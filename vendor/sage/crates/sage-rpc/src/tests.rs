use std::{sync::Arc, time::Duration};

use anyhow::{Result, bail};
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use bip39::Mnemonic;
use chia_wallet_sdk::{
    chia::{
        bls::master_to_wallet_unhardened,
        puzzle_types::{DeriveSynthetic, standard::StandardArgs},
    },
    prelude::*,
    test::PeerSimulator,
    types::puzzles::P2DelegatedConditionsArgs,
};
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use rustls::crypto::aws_lc_rs::default_provider;
use sage::Sage;
use sage_api::{
    Amount, GetCats, GetKey, GetNfts, GetPeers, GetSyncStatus, GetVersion, ImportKey, Login,
    NftSortMode, RequiredSignatures, SendCat, SendXch, TransferNfts,
};
use sage_api_macro::impl_endpoints;
use sage_wallet::{SyncCommand, SyncEvent};
use serde::{Serialize, de::DeserializeOwned};
use tempfile::TempDir;
use tokio::{
    sync::{Mutex, mpsc},
    time::timeout,
};
use tower::ServiceExt;
use tracing::debug;

use crate::make_router;

struct TestApp {
    sage: Arc<Mutex<Sage>>,
    router: Router<()>,
    rng: ChaCha8Rng,
    sim: PeerSimulator,
    events: mpsc::Receiver<SyncEvent>,
    _dir: TempDir,
}

impl TestApp {
    pub async fn new() -> Result<Self> {
        let _ = default_provider().install_default();

        let dir = TempDir::new()?;
        let rng = ChaCha8Rng::seed_from_u64(1337);
        let sim = PeerSimulator::new().await?;

        let mut sage = Sage::new(dir.path(), true);

        // Make sure we don't attempt to connect to actual nodes
        sage.config.network.target_peers = 1;
        sage.config.network.discover_peers = false;
        sage.config.network.default_network = "testnet11".to_string();

        let events = sage.initialize().await?;

        let sage = Arc::new(Mutex::new(sage));
        let router = make_router(sage.clone());

        let app = Self {
            sage,
            router,
            rng,
            sim,
            events,
            _dir: dir,
        };

        let (peer, receiver) = app.sim.connect_raw().await?;

        app.sage
            .lock()
            .await
            .command_sender
            .send(SyncCommand::AddPeer { peer, receiver })
            .await?;

        Ok(app)
    }

    /// Like [`TestApp::new`] but connects to **real Chia mainnet peers**
    /// (DNS-discovered) instead of the local simulator. Used by the live
    /// Tangem diagnostic (`#[ignore]`d; requires network access).
    pub async fn new_mainnet() -> Result<Self> {
        let _ = default_provider().install_default();

        let dir = TempDir::new()?;
        let rng = ChaCha8Rng::seed_from_u64(1337);
        let sim = PeerSimulator::new().await?; // created but unused on mainnet

        let mut sage = Sage::new(dir.path(), true);

        sage.config.network.target_peers = 5;
        sage.config.network.discover_peers = true;
        sage.config.network.default_network = "mainnet".to_string();

        let events = sage.initialize().await?;

        let sage = Arc::new(Mutex::new(sage));
        let router = make_router(sage.clone());

        // No AddPeer: the sync manager discovers mainnet peers via the
        // network's DNS introducers.
        Ok(Self {
            sage,
            router,
            rng,
            sim,
            events,
            _dir: dir,
        })
    }

    async fn call_rpc<T: Serialize, R: DeserializeOwned>(&self, path: &str, body: T) -> Result<R> {
        let req = Request::builder()
            .method("POST")
            .uri(path)
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_string(&body)?))?;

        let response = self.router.clone().oneshot(req).await?;
        let status = response.status();

        if status != StatusCode::OK {
            let body = response.into_body();
            let body = axum::body::to_bytes(body, usize::MAX).await?;
            bail!(
                "RPC request failed with status {status}: {}",
                String::from_utf8(body.to_vec())?
            );
        }

        let body = response.into_body();
        let body = axum::body::to_bytes(body, usize::MAX).await?;

        Ok(serde_json::from_slice(&body)?)
    }

    async fn setup_bls(&mut self, balance: u64) -> Result<u32> {
        let mnemonic = Mnemonic::from_entropy(&self.rng.r#gen::<[u8; 16]>())?;

        if balance > 0 {
            let master_sk = SecretKey::from_seed(&mnemonic.to_seed(""));
            let p2_puzzle_hash = StandardArgs::curry_tree_hash(
                master_to_wallet_unhardened(&master_sk, 0)
                    .public_key()
                    .derive_synthetic(),
            );

            self.sim.lock().await.create_block();

            self.sim
                .lock()
                .await
                .new_coin(p2_puzzle_hash.into(), balance);
        }

        let fingerprint = self
            .import_key(ImportKey {
                name: "Alice".to_string(),
                key: mnemonic.to_string(),
                derivation_index: 0,
                hardened: None,
                unhardened: None,
                save_secrets: true,
                login: true,
                emoji: None,
                arbor_only: false,
            })
            .await?
            .fingerprint;

        self.consume_until(|event| matches!(event, SyncEvent::Subscribed))
            .await;

        Ok(fingerprint)
    }

    async fn consume_until(&mut self, f: impl Fn(SyncEvent) -> bool) {
        loop {
            let next = timeout(Duration::from_secs(10), self.events.recv())
                .await
                .unwrap_or_else(|_| panic!("timed out listening for event"))
                .unwrap_or_else(|| panic!("missing next event"));

            debug!("Consuming event: {next:?}");

            if f(next) {
                return;
            }
        }
    }

    async fn wait_for_coins(&mut self) {
        self.consume_until(|event| matches!(event, SyncEvent::CoinsUpdated))
            .await;
    }

    #[allow(unused)]
    async fn wait_for_puzzles(&mut self) {
        self.consume_until(|event| matches!(event, SyncEvent::PuzzleBatchSynced))
            .await;
    }

    /// Imports a Tangem card as a watch-only wallet: only the card's BLS
    /// public key is known. Sage curries it into the `p2_delegated_conditions`
    /// ("arbor") puzzle — the exact puzzle a Tangem card spends. Optionally
    /// funds the arbor puzzle hash with `balance` mojos of XCH.
    ///
    /// Returns `(fingerprint, card_public_key, arbor_puzzle_hash)`.
    async fn setup_tangem(&mut self, balance: u64) -> Result<(u32, PublicKey, Bytes32)> {
        let card_pk = PublicKey::from_bytes(&TANGEM_PUBLIC_KEY)?;
        let arbor_ph: Bytes32 = P2DelegatedConditionsArgs::new(card_pk)
            .curry_tree_hash()
            .into();

        if balance > 0 {
            self.sim.lock().await.create_block();
            self.sim.lock().await.new_coin(arbor_ph, balance);
        }

        // External-signer import: ONLY the card's BLS public key. `arbor_only`
        // makes Sage create exactly one `p2_delegated_conditions` puzzle and
        // ZERO HD derivations (derivation_index/hardened/unhardened ignored).
        let fingerprint = self
            .import_key(ImportKey {
                name: "Tangem".to_string(),
                key: TANGEM_PUBLIC_KEY_HEX.to_string(),
                derivation_index: 0,
                hardened: None,
                unhardened: None,
                save_secrets: false,
                login: true,
                emoji: None,
                arbor_only: true,
            })
            .await?
            .fingerprint;

        Ok((fingerprint, card_pk, arbor_ph))
    }

    /// Drain any buffered sync events (the channel has a bounded buffer; we
    /// don't assert on event order for the Tangem tests, we poll state).
    fn drain_events(&mut self) {
        while self.events.try_recv().is_ok() {}
    }
}

/// The real Tangem card BLS public key (48-byte G1) provided by the user.
const TANGEM_PUBLIC_KEY: [u8; 48] = hex_literal::hex!(
    "8fba5482e6c798a06ee1fd95deaaa83f11c46da06006ab3524e917f4e116c2bdec69d6098043ca568290ac366e5e2dc5"
);
const TANGEM_PUBLIC_KEY_HEX: &str =
    "0x8fba5482e6c798a06ee1fd95deaaa83f11c46da06006ab3524e917f4e116c2bdec69d6098043ca568290ac366e5e2dc5";
/// The single puzzle hash + mainnet address the user confirmed for this card.
const TANGEM_ARBOR_PUZZLE_HASH: &str =
    "bdca1be3075afcf8b7fdf3c0bbfee3341c439d9d7d44cc798d3e0ca66bb42389";
const TANGEM_ARBOR_ADDRESS_MAINNET: &str =
    "xch1hh9phcc8tt703dla70qthlhrxswy88va04zvc7vd8cx2v6a5ywyst8mgul";

impl_endpoints! {
    impl TestApp {
        (repeat pub async fn endpoint(&self, body: sage_api::Endpoint) -> Result<sage_api::EndpointResponse> {
            self.call_rpc(&format!("/{}", endpoint_string), body).await
        })
    }
}

#[tokio::test]
async fn test_rpc_version() -> Result<()> {
    let app = TestApp::new().await?;

    let response = app.get_version(GetVersion {}).await?;

    assert_eq!(response.version, env!("CARGO_PKG_VERSION"));

    Ok(())
}

#[tokio::test]
async fn test_initial_state() -> Result<()> {
    let mut app = TestApp::new().await?;

    let fingerprint = app.setup_bls(0).await?;

    let key = app
        .get_key(GetKey { fingerprint: None })
        .await?
        .key
        .expect("should be logged in");

    assert_eq!(key.fingerprint, fingerprint);

    let peers = app.get_peers(GetPeers {}).await?.peers;

    assert_eq!(peers.len(), 1);
    assert_eq!(peers[0].peak_height, 0);
    assert!(!peers[0].user_managed);

    let status = app.get_sync_status(GetSyncStatus {}).await?;

    assert_eq!(status.synced_coins, 0);
    assert_eq!(status.total_coins, 0);
    assert_eq!(status.selectable_balance.to_u64(), Some(0));
    assert_eq!(status.unhardened_derivation_index, 1000);
    assert_eq!(status.hardened_derivation_index, 0);
    assert_eq!(
        status.receive_address,
        "txch19hutewzq3z4l6y3fsw5laatre79tuz5p43jlvag0yz466xx9l7vs4vnpem"
    );

    Ok(())
}

#[tokio::test]
async fn test_send_xch() -> Result<()> {
    let mut app = TestApp::new().await?;

    let alice = app.setup_bls(1000).await?;

    let bob = app.setup_bls(1000).await?;
    let bob_address = app.get_sync_status(GetSyncStatus {}).await?.receive_address;

    app.login(Login { fingerprint: alice }).await?;

    let balance = app
        .get_sync_status(GetSyncStatus {})
        .await?
        .selectable_balance
        .to_u64();
    assert_eq!(balance, Some(1000));

    app.wait_for_coins().await;

    app.send_xch(SendXch {
        address: bob_address,
        amount: Amount::u64(1000),
        fee: Amount::u64(0),
        memos: vec![],
        clawback: None,
        auto_submit: true,
    })
    .await?;

    app.wait_for_coins().await;

    let balance = app
        .get_sync_status(GetSyncStatus {})
        .await?
        .selectable_balance
        .to_u64();
    assert_eq!(balance, Some(0));

    app.login(Login { fingerprint: bob }).await?;

    app.wait_for_coins().await;

    let balance = app
        .get_sync_status(GetSyncStatus {})
        .await?
        .selectable_balance
        .to_u64();
    assert_eq!(balance, Some(2000));

    Ok(())
}

// ---------------------------------------------------------------------------
// Tangem / arbor (external-signer) tests
//
// Run with output:
//   SQLX_OFFLINE=true cargo test -p sage-rpc tangem -- --nocapture
// ---------------------------------------------------------------------------

/// Importing only the card's public key (arbor_only) must produce EXACTLY the
/// single `p2_delegated_conditions` puzzle hash + address the user confirmed
/// for this real Tangem card, and zero HD derivations.
#[tokio::test]
async fn test_tangem_import_and_address() -> Result<()> {
    let mut app = TestApp::new().await?;

    let (fingerprint, card_pk, arbor_ph) = app.setup_tangem(0).await?;

    // The single puzzle hash matches the value the user confirmed on-chain.
    assert_eq!(hex::encode(arbor_ph), TANGEM_ARBOR_PUZZLE_HASH);

    // ...and its mainnet address matches.
    let mainnet = Address::new(arbor_ph, "xch".to_string()).encode()?;
    assert_eq!(mainnet, TANGEM_ARBOR_ADDRESS_MAINNET);

    // The wallet is logged in and its single receive == change == arbor addr.
    let status = app.get_sync_status(GetSyncStatus {}).await?;
    let testnet_arbor = Address::new(arbor_ph, "txch".to_string()).encode()?;
    assert_eq!(status.receive_address, testnet_arbor);

    let key = app
        .get_key(GetKey { fingerprint: None })
        .await?
        .key
        .expect("logged in");
    assert_eq!(key.fingerprint, fingerprint);
    assert!(!key.has_secrets, "Tangem wallet must not store secrets");

    println!("\n=== TANGEM import ===");
    println!("card public key : {}", hex::encode(card_pk.to_bytes()));
    println!("arbor puzzle    : 0x{}", hex::encode(arbor_ph));
    println!("mainnet address : {mainnet}");
    println!("testnet address : {testnet_arbor}");
    println!("has_secrets     : {}", key.has_secrets);

    Ok(())
}

/// LIVE diagnostic against real Chia **mainnet** peers (no simulator).
///
///   SQLX_OFFLINE=true cargo test -p sage-rpc \
///       test_tangem_mainnet_live -- --ignored --nocapture
///
/// Imports ONLY the card's master public key (arbor_only), syncs the single
/// `p2_delegated_conditions` puzzle from mainnet, prints the real balance /
/// CATs / NFTs, and builds UNSIGNED spend bundles + the messages the card
/// must sign for whatever the wallet actually holds.
#[tokio::test]
#[ignore = "requires mainnet network access"]
async fn test_tangem_mainnet_live() -> Result<()> {
    let mut app = TestApp::new_mainnet().await?;

    let (_fp, card_pk, arbor_ph) = app.setup_tangem(0).await?;
    let address = Address::new(arbor_ph, "xch".to_string()).encode()?;

    println!("\n=== TANGEM mainnet live ===");
    println!("card public key : {}", hex::encode(card_pk.to_bytes()));
    println!("arbor puzzle    : 0x{}", hex::encode(arbor_ph));
    println!("mainnet address : {address}");

    // Wait (up to ~120s) for the sync manager to discover mainnet peers.
    let mut connected = false;
    for _ in 0..120 {
        app.drain_events();
        if let Ok(p) = app.get_peers(GetPeers {}).await {
            let best = p.peers.iter().map(|x| x.peak_height).max().unwrap_or(0);
            if !p.peers.is_empty() && best > 0 {
                println!("peers           : {} (peak {})", p.peers.len(), best);
                connected = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    if !connected {
        println!("!! no mainnet peers reachable (network blocked?) — aborting live probe");
        return Ok(());
    }

    // Let the single arbor puzzle subscription settle against the node.
    for _ in 0..45 {
        app.drain_events();
        tokio::time::sleep(Duration::from_secs(1)).await;
    }

    let status = app.get_sync_status(GetSyncStatus {}).await?;
    println!("receive address : {}", status.receive_address);
    println!(
        "xch balance     : {:?} mojos  (synced {} / {} coins)",
        status.selectable_balance.to_u64(),
        status.synced_coins,
        status.total_coins
    );
    let cats = app.get_cats(GetCats {}).await?.cats;
    println!("cats            : {cats:?}");
    let nfts = app
        .get_nfts(GetNfts {
            collection_id: None,
            minter_did_id: None,
            owner_did_id: None,
            name: None,
            offset: 0,
            limit: 100,
            sort_mode: NftSortMode::Recent,
            include_hidden: true,
        })
        .await?
        .nfts;
    println!("nfts            : {}", nfts.len());

    // Helper: dump the messages the card must sign for a built tx.
    async fn dump_required(app: &TestApp, label: &str, coin_spends: Vec<sage_api::CoinSpendJson>) {
        if coin_spends.is_empty() {
            return;
        }
        let req = app
            .required_signatures(RequiredSignatures {
                coin_spends: coin_spends.clone(),
            })
            .await
            .expect("required_signatures");
        println!("--- {label}: {} coin spend(s) ---", coin_spends.len());
        for (i, s) in req.signatures.iter().enumerate() {
            assert_eq!(
                s.public_key, TANGEM_PUBLIC_KEY_HEX,
                "every signature must be the card key"
            );
            println!("  sig[{i}] msg   : {}", s.message);
        }
    }

    // XCH: build an unsigned self-send of the whole balance.
    if let Some(bal) = status.selectable_balance.to_u64()
        && bal > 0
    {
        let tx = app
            .send_xch(SendXch {
                address: address.clone(),
                amount: Amount::u64(bal),
                fee: Amount::u64(0),
                memos: vec![],
                clawback: None,
                auto_submit: false,
            })
            .await?;
        dump_required(&app, "XCH send (unsigned)", tx.coin_spends).await;
    } else {
        println!("(no XCH to spend)");
    }

    // CATs: build an unsigned self-send for each.
    for cat in &cats {
        let Some(asset_id) = cat.asset_id.clone() else {
            continue;
        };
        match app
            .send_cat(SendCat {
                asset_id: asset_id.clone(),
                address: address.clone(),
                amount: Amount::u64(1),
                fee: Amount::u64(0),
                include_hint: true,
                memos: vec![],
                clawback: None,
                auto_submit: false,
            })
            .await
        {
            Ok(tx) => dump_required(&app, &format!("CAT {asset_id} (unsigned)"), tx.coin_spends).await,
            Err(e) => println!("(CAT {asset_id} send build failed: {e})"),
        }
    }

    // NFTs: build an unsigned self-transfer for each.
    for nft in &nfts {
        match app
            .transfer_nfts(TransferNfts {
                nft_ids: vec![nft.launcher_id.clone()],
                address: address.clone(),
                fee: Amount::u64(0),
                clawback: None,
                auto_submit: false,
            })
            .await
        {
            Ok(tx) => {
                dump_required(&app, &format!("NFT {} (unsigned)", nft.launcher_id), tx.coin_spends)
                    .await
            }
            Err(e) => println!("(NFT {} transfer build failed: {e})", nft.launcher_id),
        }
    }

    Ok(())
}

