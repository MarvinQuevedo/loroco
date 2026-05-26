//! The actual Sage engine — boots, dispatches, and holds the unlocked SK.
//!
//! Lifecycle:
//! - `version` / `ping` work without any state.
//! - `generate_mnemonic` / `import_mnemonic` are stateless (no SK yet).
//! - `unlock_keychain` populates the in-memory SK cache for the unlocked
//!   fingerprint. Subsequent `derive_address` / `sign_message` calls use
//!   that cached SK without needing the password again.
//! - `lock_keychain` clears the cache.
//!
//! Anything that needs persistent on-chain state (sync, coin queries)
//! returns `NotImplemented` until the storage bridge is wired.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use bip39::Mnemonic;
use chia_wallet_sdk::{
    chia::{
        bls::{master_to_wallet_unhardened, PublicKey, SecretKey, Signature, sign},
        puzzle_types::{standard::StandardArgs, DeriveSynthetic},
    },
    coinset::{ChiaRpcClient, CoinsetClient},
    prelude::*,
    utils::Address,
};
use sage_keychain::Keychain;
use serde::{Deserialize, Serialize};
use wasm_bindgen::JsValue;

use crate::{storage_bridge::JsStorage, EngineError};

/// Engine state. Cheap to clone (`Arc`-wrapped storage + key cache).
#[derive(Clone)]
pub struct SageEngine {
    storage: Arc<JsStorage>,
    /// Master secret keys per fingerprint, populated by `unlock_keychain`.
    /// In WASM/browser this is single-threaded so the Mutex never contends;
    /// it gives us interior mutability + `Clone` for the engine struct.
    unlocked: Arc<Mutex<HashMap<u32, SecretKey>>>,
}

impl SageEngine {
    pub fn new(storage_callbacks: JsValue) -> Result<Self, JsValue> {
        let storage = JsStorage::from_js(storage_callbacks)?;
        Ok(Self {
            storage: Arc::new(storage),
            unlocked: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Look up the cached SK for `fingerprint`, returning a fresh clone.
    /// Get a master public key either from a cached unlocked SK (by
    /// fingerprint) or from a directly-passed hex master_public_key.
    /// Used by stateless read methods that need to derive puzzle hashes
    /// without requiring the wallet to be unlocked first.
    fn resolve_master_pk(
        &self,
        fingerprint: Option<u32>,
        master_public_key_hex: Option<&str>,
    ) -> Result<PublicKey, EngineError> {
        if let Some(hex_str) = master_public_key_hex {
            let bytes = hex::decode(hex_str.trim_start_matches("0x"))
                .map_err(|e| EngineError::InvalidParams(format!("master_public_key hex: {e}")))?;
            let arr: [u8; 48] = bytes.as_slice().try_into().map_err(|_| {
                EngineError::InvalidParams("master_public_key must be 48 bytes (G1)".to_string())
            })?;
            return PublicKey::from_bytes(&arr)
                .map_err(|e| EngineError::InvalidParams(format!("master_public_key: {e}")));
        }
        if let Some(fp) = fingerprint {
            return Ok(self.unlocked_sk(fp)?.public_key());
        }
        Err(EngineError::InvalidParams(
            "need `fingerprint` (unlocked) or `master_public_key`".to_string(),
        ))
    }

    fn unlocked_sk(&self, fingerprint: u32) -> Result<SecretKey, EngineError> {
        let guard = self
            .unlocked
            .lock()
            .map_err(|_| EngineError::Internal("unlocked-cache mutex poisoned".to_string()))?;
        guard
            .get(&fingerprint)
            .cloned()
            .ok_or_else(|| {
                EngineError::InvalidParams(format!(
                    "fingerprint {fingerprint} is locked — call unlock_keychain first"
                ))
            })
    }

    pub async fn dispatch(&self, method: &str, params_json: &str) -> Result<String, EngineError> {
        match method {
            // ─── Sage-aligned canonical names ─────────────────────────────
            // These mirror the impl Sage::xxx surface in
            // vendor/sage/crates/sage/src/endpoints/. Same Request/Response
            // shapes from sage-api so a dApp / FFI / RPC caller can hit any
            // transport with the same payload.

            // Authentication & Keys
            "login" => self.login(params_json).await,
            "logout" => self.logout(params_json).await,
            "import_key" => self.import_key(params_json).await,
            "generate_mnemonic" => self.generate_mnemonic(params_json).await,
            "get_keys" => self.get_keys(params_json).await,
            "get_key" => self.get_key(params_json).await,
            "get_sync_status" => self.get_sync_status(params_json).await,

            // Addresses
            "check_address" => self.check_address(params_json).await,

            // Signing
            "sign_message_with_public_key" => self.sign_message(params_json).await,

            // ─── Pre-sage-api ad-hoc names (kept for our popup callers) ──
            // These are aliases to the canonical methods above so the React
            // popup keeps working while we migrate JS callers.
            "ping" => Ok(serde_json::json!({"pong": true}).to_string()),
            "version" => Ok(serde_json::json!({
                "engine": env!("CARGO_PKG_VERSION"),
                "sage_api": "0.12.10",
            })
            .to_string()),
            "derive_address" => self.derive_address(params_json).await,
            "derive_addresses" => self.derive_addresses(params_json).await,
            "decode_address" => self.check_address(params_json).await,
            "validate_mnemonic" => self.validate_mnemonic(params_json).await,
            "import_mnemonic" => self.import_key(params_json).await,
            "unlock_keychain" => self.login(params_json).await,
            "lock_keychain" => self.logout(params_json).await,
            "is_unlocked" => self.is_unlocked(params_json).await,
            "sign_message" => self.sign_message(params_json).await,
            "verify_signature" => self.verify_signature(params_json).await,
            "sync_tick" => self.sync_tick(params_json).await,
            "get_address_balance" => self.get_address_balance(params_json).await,
            "scan_puzzle_hashes" => self.scan_puzzle_hashes(params_json).await,
            "scan_hints" => self.scan_hints(params_json).await,
            "check_coins_spent" => self.check_coins_spent(params_json).await,
            "send_xch" => self.send_xch(params_json).await,
            "scan_cats" => self.scan_cats(params_json).await,
            "scan_nfts" => self.scan_nfts(params_json).await,

            other => Err(EngineError::NotImplemented(other.to_string())),
        }
    }

    /// Discover NFT receipts by hint matching + parse with chia-sdk-driver.
    ///
    /// Mirrors `scan_cats`. NFTs are singletons; when one is transferred to
    /// the wallet the on-chain coin carries `hint = inner_ph` (the wallet's
    /// p2_puzzle_hash). We resolve to the NFT primitive via `Nft::parse_child`
    /// on the parent spend so we can extract launcher_id, metadata (URIs +
    /// edition), current_owner DID, royalty.
    ///
    /// Params: `{ ("fingerprint" | "master_public_key"),
    ///            "start"?, "count"?, "testnet"?, "endpoint"? }`
    ///
    /// Returns: `{ "nfts": [{ launcher_id, coin_id, parent_coin_info,
    ///   puzzle_hash, amount, metadata: { edition_number, edition_total,
    ///   data_uris, metadata_uris, license_uris, data_hash, metadata_hash,
    ///   license_hash }, current_owner_did, royalty_puzzle_hash,
    ///   royalty_basis_points, p2_puzzle_hash, confirmed_block_index,
    ///   spent }] }`.
    async fn scan_nfts(&self, params_json: &str) -> Result<String, EngineError> {
        use chia_wallet_sdk::{
            chia::puzzle_types::nft::NftMetadata,
            clvm_traits::FromClvm,
            clvmr::serde::node_from_bytes,
            driver::{Nft, Puzzle, SpendContext},
        };

        #[derive(Deserialize)]
        struct Req {
            #[serde(default)]
            fingerprint: Option<u32>,
            #[serde(default)]
            master_public_key: Option<String>,
            #[serde(default)]
            start: u32,
            #[serde(default = "default_nft_count")]
            count: u32,
            #[serde(default)]
            testnet: bool,
            #[serde(default)]
            endpoint: Option<String>,
        }
        fn default_nft_count() -> u32 {
            50
        }

        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;
        if req.count == 0 || req.count > 200 {
            return Err(EngineError::InvalidParams(format!(
                "count must be 1..=200, got {}",
                req.count
            )));
        }
        let master_pk =
            self.resolve_master_pk(req.fingerprint, req.master_public_key.as_deref())?;

        // Inner puzzle hashes — same set used for XCH/CAT detection.
        let mut inner_phs: Vec<Bytes32> = Vec::with_capacity(req.count as usize);
        for i in 0..req.count {
            let idx = req.start + i;
            let intermediate_pk = master_to_wallet_unhardened(&master_pk, idx);
            let synthetic_pk = intermediate_pk.derive_synthetic();
            let inner_ph: Bytes32 = StandardArgs::curry_tree_hash(synthetic_pk).into();
            inner_phs.push(inner_ph);
        }
        let inner_phs_set: std::collections::HashSet<Bytes32> =
            inner_phs.iter().copied().collect();

        let client = make_client(req.endpoint.as_deref());

        // 1. For each inner_ph, scan hints for incoming NFTs.
        //    Filter out coins whose puzzle_hash IS one of our PHs (those
        //    are XCH receives, not NFTs).
        let mut candidates = Vec::new();
        for hint in &inner_phs {
            let res = client
                .get_coin_records_by_hint(*hint, None, None, Some(true))
                .await
                .map_err(|e| EngineError::Internal(format!("coinset hint: {e}")))?;
            for r in res.coin_records.unwrap_or_default() {
                if inner_phs_set.contains(&r.coin.puzzle_hash) {
                    continue;
                }
                candidates.push((*hint, r));
            }
        }

        // 2. For each candidate, fetch the parent's puzzle+solution and try
        //    Nft::parse_child. Skip ones that don't parse (those will be
        //    handled by scan_cats / scan_dids).
        let mut nfts: Vec<serde_json::Value> = Vec::new();

        for (hint, rec) in &candidates {
            let parent_id = rec.coin.parent_coin_info;
            let parent_rec = match client.get_coin_record_by_name(parent_id).await {
                Ok(r) => r.coin_record,
                Err(_) => continue,
            };
            let Some(parent_rec) = parent_rec else {
                continue;
            };
            if !parent_rec.spent {
                continue;
            }
            let spend = match client
                .get_puzzle_and_solution(parent_id, Some(parent_rec.spent_block_index))
                .await
            {
                Ok(s) => s,
                Err(_) => continue,
            };
            let Some(coin_spend) = spend.coin_solution else {
                continue;
            };

            let mut ctx = SpendContext::new();
            let puzzle_ptr =
                match node_from_bytes(&mut *ctx, coin_spend.puzzle_reveal.as_ref()) {
                    Ok(p) => p,
                    Err(_) => continue,
                };
            let solution_ptr =
                match node_from_bytes(&mut *ctx, coin_spend.solution.as_ref()) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
            let parent_puzzle = Puzzle::parse(&ctx, puzzle_ptr);
            let nft = match Nft::parse_child(
                &mut *ctx,
                coin_spend.coin,
                parent_puzzle,
                solution_ptr,
            ) {
                Ok(Some(n)) => n,
                _ => continue,
            };

            // Match on coin_id — Nft::parse_child returns one child but its
            // coin should be the one we're looking at.
            if nft.coin.coin_id() != rec.coin.coin_id() {
                continue;
            }

            // Decode metadata via NftMetadata::from_clvm.
            let metadata_json = match NftMetadata::from_clvm(&*ctx, nft.info.metadata.ptr()) {
                Ok(md) => serde_json::json!({
                    "edition_number": md.edition_number,
                    "edition_total": md.edition_total,
                    "data_uris": md.data_uris,
                    "data_hash": md.data_hash.map(|h| format!("0x{}", hex::encode(h))),
                    "metadata_uris": md.metadata_uris,
                    "metadata_hash": md.metadata_hash.map(|h| format!("0x{}", hex::encode(h))),
                    "license_uris": md.license_uris,
                    "license_hash": md.license_hash.map(|h| format!("0x{}", hex::encode(h))),
                }),
                Err(_) => serde_json::json!({}),
            };

            nfts.push(serde_json::json!({
                "launcher_id": format!("0x{}", hex::encode(nft.info.launcher_id)),
                "coin_id": format!("0x{}", hex::encode(nft.coin.coin_id())),
                "parent_coin_info": format!("0x{}", hex::encode(rec.coin.parent_coin_info)),
                "puzzle_hash": format!("0x{}", hex::encode(rec.coin.puzzle_hash)),
                "amount": rec.coin.amount.to_string(),
                "metadata": metadata_json,
                "metadata_updater_puzzle_hash": format!("0x{}", hex::encode(nft.info.metadata_updater_puzzle_hash)),
                "current_owner_did": nft.info.current_owner.map(|d| format!("0x{}", hex::encode(d))),
                "royalty_puzzle_hash": format!("0x{}", hex::encode(nft.info.royalty_puzzle_hash)),
                "royalty_basis_points": nft.info.royalty_basis_points,
                "p2_puzzle_hash": format!("0x{}", hex::encode(nft.info.p2_puzzle_hash)),
                "hint": format!("0x{}", hex::encode(hint)),
                "confirmed_block_index": rec.confirmed_block_index,
                "spent": rec.spent,
                "spent_block_index": rec.spent_block_index,
            }));
        }

        Ok(serde_json::json!({
            "nfts": nfts,
            "scanned_inner_hashes": inner_phs.len(),
            "testnet": req.testnet,
        })
        .to_string())
    }

    /// Discover CAT receipts across a list of inner puzzle hashes (the
    /// wallet's p2 puzzle hashes). When someone sends a CAT to your address,
    /// the on-chain coin is at the CAT outer puzzle hash with `hint = inner_ph`,
    /// so we use coinset's `get_coin_records_by_hint` to surface them, then
    /// fetch the parent spend and let `Cat::parse_children` extract the
    /// `asset_id` (tail hash).
    ///
    /// Params: `{ ("fingerprint": N | "master_public_key": "0x..."),
    ///            "start": K, "count": M, "endpoint"?: "..." }`
    ///
    /// Returns: `{ "cats": [{ "asset_id", "total_unspent_mojos",
    ///   "unspent_coin_count", "coins": [{ coin_id, parent, ph, amount,
    ///   inner_puzzle_hash, hint, confirmed_block, spent_block }] }] }`.
    async fn scan_cats(&self, params_json: &str) -> Result<String, EngineError> {
        use chia_wallet_sdk::{
            chia::protocol::Program,
            clvmr::serde::node_from_bytes,
            driver::{Cat, Puzzle, SpendContext},
        };

        #[derive(Deserialize)]
        struct Req {
            #[serde(default)]
            fingerprint: Option<u32>,
            #[serde(default)]
            master_public_key: Option<String>,
            #[serde(default)]
            start: u32,
            #[serde(default = "default_cat_count")]
            count: u32,
            #[serde(default)]
            testnet: bool,
            #[serde(default)]
            endpoint: Option<String>,
        }
        fn default_cat_count() -> u32 {
            50
        }

        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;
        if req.count == 0 || req.count > 200 {
            return Err(EngineError::InvalidParams(format!(
                "count must be 1..=200, got {}",
                req.count
            )));
        }
        let master_pk =
            self.resolve_master_pk(req.fingerprint, req.master_public_key.as_deref())?;

        // 1. Derive the inner puzzle hashes we'll scan as hints.
        let mut inner_phs: Vec<Bytes32> = Vec::with_capacity(req.count as usize);
        for i in 0..req.count {
            let idx = req.start + i;
            let intermediate_pk = master_to_wallet_unhardened(&master_pk, idx);
            let synthetic_pk = intermediate_pk.derive_synthetic();
            let inner_ph: Bytes32 = StandardArgs::curry_tree_hash(synthetic_pk).into();
            inner_phs.push(inner_ph);
        }
        let inner_phs_set: std::collections::HashSet<Bytes32> =
            inner_phs.iter().copied().collect();

        let client = make_client(req.endpoint.as_deref());

        // 2. For each inner_ph, fetch coins with hint = inner_ph.
        //    We skip records whose outer puzzle_hash is itself in inner_phs
        //    (those are XCH receives, already covered by scan_puzzle_hashes).
        let mut candidates = Vec::new();
        for hint in &inner_phs {
            let res = client
                .get_coin_records_by_hint(*hint, None, None, Some(true))
                .await
                .map_err(|e| EngineError::Internal(format!("coinset hint: {e}")))?;
            for r in res.coin_records.unwrap_or_default() {
                if inner_phs_set.contains(&r.coin.puzzle_hash) {
                    continue; // XCH receive — covered elsewhere
                }
                candidates.push((*hint, r));
            }
        }

        // 3. For each candidate, fetch its PARENT's spend, parse via
        //    Cat::parse_children, and find the child matching this coin.
        let mut by_asset: std::collections::HashMap<Bytes32, CatBucket> =
            std::collections::HashMap::new();

        // Parent cache: avoid re-fetching when many siblings share a parent
        let mut parent_cache: std::collections::HashMap<Bytes32, Option<Vec<Cat>>> =
            std::collections::HashMap::new();

        for (hint, rec) in &candidates {
            let parent_id = rec.coin.parent_coin_info;
            let children = match parent_cache.get(&parent_id) {
                Some(v) => v.clone(),
                None => {
                    // Fetch parent record so we know which block to query
                    // get_puzzle_and_solution against.
                    let parent_rec = client
                        .get_coin_record_by_name(parent_id)
                        .await
                        .map_err(|e| EngineError::Internal(format!("coinset parent: {e}")))?;
                    let parent_rec = parent_rec.coin_record;
                    let Some(parent_rec) = parent_rec else {
                        parent_cache.insert(parent_id, None);
                        continue;
                    };
                    if !parent_rec.spent {
                        parent_cache.insert(parent_id, None);
                        continue;
                    }
                    let spend = client
                        .get_puzzle_and_solution(
                            parent_id,
                            Some(parent_rec.spent_block_index),
                        )
                        .await
                        .map_err(|e| EngineError::Internal(format!("coinset puzzle: {e}")))?;
                    let Some(coin_spend) = spend.coin_solution else {
                        parent_cache.insert(parent_id, None);
                        continue;
                    };

                    // Parse via chia-sdk-driver
                    let mut ctx = SpendContext::new();
                    let puzzle_ptr = node_from_bytes(
                        &mut *ctx,
                        coin_spend.puzzle_reveal.as_ref(),
                    )
                    .map_err(|e| EngineError::Internal(format!("clvm puzzle: {e}")))?;
                    let solution_ptr = node_from_bytes(
                        &mut *ctx,
                        coin_spend.solution.as_ref(),
                    )
                    .map_err(|e| EngineError::Internal(format!("clvm solution: {e}")))?;
                    let parent_puzzle = Puzzle::parse(&ctx, puzzle_ptr);
                    let parsed = Cat::parse_children(
                        &mut *ctx,
                        coin_spend.coin,
                        parent_puzzle,
                        solution_ptr,
                    )
                    .map_err(|e| EngineError::Internal(format!("Cat::parse_children: {e}")))?;
                    parent_cache.insert(parent_id, parsed.clone());
                    parsed
                }
            };

            let Some(children) = children else {
                continue;
            };
            // Match the on-chain coin to the parsed child by coin_id.
            let coin_id = rec.coin.coin_id();
            let Some(child) = children.iter().find(|c| c.coin.coin_id() == coin_id) else {
                continue;
            };

            let bucket = by_asset
                .entry(child.info.asset_id)
                .or_insert_with(|| CatBucket {
                    asset_id: child.info.asset_id,
                    coins: Vec::new(),
                });
            bucket.coins.push(CatCoinView {
                coin_id,
                parent_coin_info: rec.coin.parent_coin_info,
                puzzle_hash: rec.coin.puzzle_hash,
                amount: rec.coin.amount,
                inner_puzzle_hash: child.info.p2_puzzle_hash,
                hint: *hint,
                confirmed_block_index: rec.confirmed_block_index,
                spent: rec.spent,
                spent_block_index: rec.spent_block_index,
            });
        }

        // Emit per-asset rollups
        let cats: Vec<_> = by_asset
            .into_values()
            .map(|b| {
                let mut total_unspent: u128 = 0;
                let mut unspent_count: u32 = 0;
                let coins_json: Vec<_> = b
                    .coins
                    .iter()
                    .map(|c| {
                        if !c.spent {
                            total_unspent =
                                total_unspent.saturating_add(u128::from(c.amount));
                            unspent_count = unspent_count.saturating_add(1);
                        }
                        serde_json::json!({
                            "coin_id": format!("0x{}", hex::encode(c.coin_id)),
                            "parent_coin_info": format!("0x{}", hex::encode(c.parent_coin_info)),
                            "puzzle_hash": format!("0x{}", hex::encode(c.puzzle_hash)),
                            "amount": c.amount.to_string(),
                            "inner_puzzle_hash": format!("0x{}", hex::encode(c.inner_puzzle_hash)),
                            "hint": format!("0x{}", hex::encode(c.hint)),
                            "confirmed_block_index": c.confirmed_block_index,
                            "spent": c.spent,
                            "spent_block_index": c.spent_block_index,
                        })
                    })
                    .collect();
                serde_json::json!({
                    "asset_id": format!("0x{}", hex::encode(b.asset_id)),
                    "total_unspent_mojos": total_unspent.to_string(),
                    "unspent_coin_count": unspent_count,
                    "coins": coins_json,
                })
            })
            .collect();

        Ok(serde_json::json!({
            "cats": cats,
            "scanned_inner_hashes": inner_phs.len(),
            "testnet": req.testnet,
        })
        .to_string())
    }

    /// Send XCH: build a SpendBundle from one or more input coins, sign,
    /// and push via coinset. Multi-coin selection lives on the JS side
    /// (chrome.storage.local["coins.<fp>"]) so the engine stays stateless
    /// about which coins to pick — it just trusts the list it's given.
    ///
    /// Multi-input pattern: the first coin carries the outputs and asserts
    /// that every other coin in the bundle is spent in the same block; the
    /// other coins spend with a single assert_concurrent_spend back to the
    /// first. Each coin is signed with its own synthetic SK at the matching
    /// derivation_index.
    ///
    /// Params:
    /// ```
    /// {
    ///   fingerprint: u32,
    ///   recipient_address: "xch1...",
    ///   amount_mojos: "1000000000000",
    ///   fee_mojos: "0",
    ///   input_coins: [{ parent_coin_info, puzzle_hash, amount, derivation_index }],
    ///   change_index: u32,
    ///   testnet: false,
    ///   endpoint?: "mainnet" | "testnet11" | "<url>",
    ///   broadcast?: true
    /// }
    /// ```
    ///
    /// Backwards-compat: `input_coin` (singular) is still accepted and gets
    /// wrapped into a 1-element `input_coins`.
    ///
    /// Returns: `{ tx_id, status, error?, spend_bundle, change_mojos,
    ///             input_count, total_input_mojos }`.
    async fn send_xch(&self, params_json: &str) -> Result<String, EngineError> {
        use chia_wallet_sdk::{
            chia::{
                bls::{sign, Signature},
                consensus::consensus_constants::ConsensusConstants,
                protocol::SpendBundle,
            },
            driver::{SpendContext, StandardLayer},
            signer::{AggSigConstants, RequiredBlsSignature, RequiredSignature},
            types::MAINNET_CONSTANTS,
        };

        #[derive(Deserialize, Clone)]
        struct InputCoin {
            parent_coin_info: String,
            puzzle_hash: String,
            amount: String,
            derivation_index: u32,
        }
        #[derive(Deserialize)]
        struct Req {
            fingerprint: u32,
            recipient_address: String,
            amount_mojos: String,
            #[serde(default = "default_zero_mojos")]
            fee_mojos: String,
            #[serde(default)]
            input_coin: Option<InputCoin>,
            #[serde(default)]
            input_coins: Option<Vec<InputCoin>>,
            #[serde(default)]
            change_index: u32,
            #[serde(default)]
            testnet: bool,
            #[serde(default)]
            endpoint: Option<String>,
            #[serde(default = "default_true")]
            broadcast: bool,
        }
        fn default_zero_mojos() -> String {
            "0".to_string()
        }
        fn default_true() -> bool {
            true
        }

        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;

        // 1. Parse + validate
        let amount: u64 = req
            .amount_mojos
            .parse()
            .map_err(|_| EngineError::InvalidParams("amount_mojos must be u64".to_string()))?;
        let fee: u64 = req
            .fee_mojos
            .parse()
            .map_err(|_| EngineError::InvalidParams("fee_mojos must be u64".to_string()))?;
        if amount == 0 {
            return Err(EngineError::InvalidParams(
                "amount_mojos must be > 0".to_string(),
            ));
        }
        let needed = amount
            .checked_add(fee)
            .ok_or_else(|| EngineError::InvalidParams("amount + fee overflow".to_string()))?;

        let inputs = req
            .input_coins
            .or_else(|| req.input_coin.map(|c| vec![c]))
            .ok_or_else(|| {
                EngineError::InvalidParams(
                    "send_xch needs `input_coins` (or legacy `input_coin`)".to_string(),
                )
            })?;
        if inputs.is_empty() {
            return Err(EngineError::InvalidParams("input_coins is empty".to_string()));
        }
        if inputs.len() > 50 {
            return Err(EngineError::InvalidParams(format!(
                "too many input_coins ({}), max 50 per bundle",
                inputs.len()
            )));
        }

        // Parse and sum
        let mut total_input: u64 = 0;
        let mut parsed: Vec<(Coin, SecretKey, PublicKey, u32)> = Vec::with_capacity(inputs.len());
        let master_sk = self.unlocked_sk(req.fingerprint)?;
        for c in &inputs {
            let amount_u: u64 = c
                .amount
                .parse()
                .map_err(|_| EngineError::InvalidParams("input.amount must be u64".to_string()))?;
            total_input = total_input
                .checked_add(amount_u)
                .ok_or_else(|| EngineError::InvalidParams("input sum overflow".to_string()))?;
            let parent = parse_bytes32(&c.parent_coin_info)?;
            let coin_ph = parse_bytes32(&c.puzzle_hash)?;
            let coin = Coin::new(parent, coin_ph, amount_u);
            let intermediate = master_to_wallet_unhardened(&master_sk, c.derivation_index);
            let synthetic_sk = intermediate.derive_synthetic();
            let synthetic_pk = synthetic_sk.public_key();
            let derived_ph: Bytes32 = StandardArgs::curry_tree_hash(synthetic_pk).into();
            if derived_ph != coin_ph {
                return Err(EngineError::InvalidParams(format!(
                    "input coin at index {} has puzzle_hash {} but derivation_index {} derives \
                     to {}",
                    parsed.len(),
                    hex::encode(coin_ph),
                    c.derivation_index,
                    hex::encode(derived_ph)
                )));
            }
            parsed.push((coin, synthetic_sk, synthetic_pk, c.derivation_index));
        }

        if total_input < needed {
            return Err(EngineError::InvalidParams(format!(
                "input coins sum to {total_input} mojos but {needed} needed (amount + fee)"
            )));
        }
        let change = total_input - needed;

        let recipient = Address::decode(req.recipient_address.trim())
            .map_err(|e| EngineError::InvalidParams(format!("recipient: {e}")))?;
        let recipient_ph = recipient.puzzle_hash;

        let change_intermediate_sk = master_to_wallet_unhardened(&master_sk, req.change_index);
        let change_synthetic_pk = change_intermediate_sk.derive_synthetic().public_key();
        let change_ph: Bytes32 = StandardArgs::curry_tree_hash(change_synthetic_pk).into();

        // 2. Build conditions
        // First coin: outputs + reserve_fee + assert_concurrent_spend for the rest.
        // Other coins: assert_concurrent_spend back to the first.
        let mut ctx = SpendContext::new();

        let (head_coin, head_sk, head_pk, _) = parsed[0].clone();
        let head_coin_id = head_coin.coin_id();

        let mut head_conditions = Conditions::new()
            .create_coin(
                recipient_ph,
                amount,
                ::chia_wallet_sdk::chia::puzzle_types::Memos::None,
            );
        if fee > 0 {
            head_conditions = head_conditions.reserve_fee(fee);
        }
        if change > 0 {
            head_conditions = head_conditions.create_coin(
                change_ph,
                change,
                ::chia_wallet_sdk::chia::puzzle_types::Memos::None,
            );
        }
        for (other_coin, _, _, _) in parsed.iter().skip(1) {
            head_conditions = head_conditions.assert_concurrent_spend(other_coin.coin_id());
        }

        StandardLayer::new(head_pk)
            .spend(&mut ctx, head_coin, head_conditions)
            .map_err(|e| EngineError::Internal(format!("StandardLayer::spend head: {e}")))?;

        // Tail coins: just assert_concurrent_spend(head)
        for (i, (coin, _, pk, _)) in parsed.iter().enumerate().skip(1) {
            let tail = Conditions::new().assert_concurrent_spend(head_coin_id);
            StandardLayer::new(*pk)
                .spend(&mut ctx, *coin, tail)
                .map_err(|e| {
                    EngineError::Internal(format!("StandardLayer::spend tail {i}: {e}"))
                })?;
        }

        let coin_spends = ctx.take();

        // 3. Compute required AGG_SIG signatures + sign with each input's SK
        let constants: &ConsensusConstants = &MAINNET_CONSTANTS;
        let agg_sig_consts = AggSigConstants::new(constants.agg_sig_me_additional_data);
        let required = RequiredSignature::from_coin_spends(
            &mut ctx,
            &coin_spends,
            &agg_sig_consts,
        )
        .map_err(|e| EngineError::Internal(format!("required_signatures: {e}")))?;

        // Build pk → sk lookup
        let mut sks_by_pk: std::collections::HashMap<Vec<u8>, SecretKey> =
            std::collections::HashMap::new();
        sks_by_pk.insert(head_pk.to_bytes().to_vec(), head_sk);
        for (_, sk, pk, _) in parsed.iter().skip(1) {
            sks_by_pk.insert(pk.to_bytes().to_vec(), sk.clone());
        }

        let mut aggregated = Signature::default();
        for req_sig in required {
            match req_sig {
                RequiredSignature::Bls(RequiredBlsSignature {
                    public_key,
                    raw_message,
                    appended_info,
                    domain_string,
                }) => {
                    let pk_bytes = public_key.to_bytes().to_vec();
                    let sk = sks_by_pk.get(&pk_bytes).ok_or_else(|| {
                        EngineError::Internal(format!(
                            "no secret key cached for pubkey {} (not among the input coins)",
                            hex::encode(&pk_bytes)
                        ))
                    })?;
                    let mut msg = raw_message.to_vec();
                    msg.extend_from_slice(&appended_info);
                    if let Some(domain) = domain_string {
                        msg.extend_from_slice(&domain);
                    }
                    aggregated.aggregate(&sign(sk, &msg));
                }
                RequiredSignature::Secp(_) => {
                    return Err(EngineError::Internal(
                        "SECP signatures not supported in send_xch".to_string(),
                    ));
                }
            }
        }
        let bundle = SpendBundle::new(coin_spends.clone(), aggregated);

        // 6. Push (unless dry-run)
        let mut status = "DRY_RUN".to_string();
        let mut error: Option<String> = None;
        if req.broadcast {
            let client = make_client(req.endpoint.as_deref());
            let res = client
                .push_tx(bundle.clone())
                .await
                .map_err(|e| EngineError::Internal(format!("push_tx: {e}")))?;
            status = res.status;
            error = res.error;
        }

        let tx_id = bundle.name();
        Ok(serde_json::json!({
            "tx_id": format!("0x{}", hex::encode(tx_id)),
            "status": status,
            "error": error,
            "spend_bundle": {
                "coin_spends": coin_spends.iter().map(serialize_coin_spend).collect::<Vec<_>>(),
                "aggregated_signature": format!("0x{}", hex::encode(bundle.aggregated_signature.to_bytes())),
            },
            "change_mojos": change.to_string(),
            "input_count": inputs.len(),
            "total_input_mojos": total_input.to_string(),
            "testnet": req.testnet,
        })
        .to_string())
    }

    /// Incremental sync of a list of puzzle_hashes against coinset.org.
    ///
    /// JS keeps `last_synced_height` per puzzle_hash in chrome.storage.local
    /// and passes the lowest of those (minus reorg window) as `start_height`.
    /// The engine fetches coin records created in [start, peak] and returns
    /// them along with the peak height to set as the new sync mark.
    ///
    /// Params:
    /// `{ "puzzle_hashes": ["0x..."], "start_height": K?, "include_spent": bool?,
    ///    "endpoint"?: "mainnet"|"testnet11"|"<url>" }`
    ///
    /// Returns:
    /// `{ "peak_height": N, "coin_records": [{coin, confirmed_block_index,
    ///    spent_block_index, spent, coinbase, timestamp, puzzle_hash, hint?}] }`
    async fn scan_puzzle_hashes(&self, params_json: &str) -> Result<String, EngineError> {
        #[derive(Deserialize)]
        struct Req {
            puzzle_hashes: Vec<String>,
            #[serde(default)]
            start_height: Option<u32>,
            #[serde(default)]
            include_spent: Option<bool>,
            #[serde(default)]
            endpoint: Option<String>,
        }
        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;
        if req.puzzle_hashes.is_empty() {
            return Err(EngineError::InvalidParams("puzzle_hashes is empty".into()));
        }
        if req.puzzle_hashes.len() > 500 {
            return Err(EngineError::InvalidParams(format!(
                "too many puzzle_hashes ({}), max 500",
                req.puzzle_hashes.len()
            )));
        }
        let phs = req
            .puzzle_hashes
            .iter()
            .map(|s| parse_bytes32(s.trim()))
            .collect::<Result<Vec<_>, _>>()?;

        let client = make_client(req.endpoint.as_deref());

        // Bound the result by the peak so the JS side knows where to set its
        // next high-water mark — fetched first to avoid races against new blocks.
        let state = client
            .get_blockchain_state()
            .await
            .map_err(|e| EngineError::Internal(format!("coinset rpc: {e}")))?;
        let peak = state
            .blockchain_state
            .ok_or_else(|| EngineError::Internal("empty blockchain state".to_string()))?
            .peak
            .height;

        let res = client
            .get_coin_records_by_puzzle_hashes(
                phs,
                req.start_height,
                Some(peak + 1),
                req.include_spent,
            )
            .await
            .map_err(|e| EngineError::Internal(format!("coinset rpc: {e}")))?;

        let records: Vec<_> = res
            .coin_records
            .unwrap_or_default()
            .into_iter()
            .map(serialize_coin_record)
            .collect();

        Ok(serde_json::json!({
            "peak_height": peak,
            "coin_records": records,
        })
        .to_string())
    }

    /// Same as `scan_puzzle_hashes` but for hint values — used to discover
    /// inbound CATs, NFTs, DIDs that arrive at a hint we own.
    async fn scan_hints(&self, params_json: &str) -> Result<String, EngineError> {
        #[derive(Deserialize)]
        struct Req {
            hints: Vec<String>,
            #[serde(default)]
            start_height: Option<u32>,
            #[serde(default)]
            include_spent: Option<bool>,
            #[serde(default)]
            endpoint: Option<String>,
        }
        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;
        if req.hints.is_empty() {
            return Err(EngineError::InvalidParams("hints is empty".into()));
        }
        if req.hints.len() > 500 {
            return Err(EngineError::InvalidParams(format!(
                "too many hints ({}), max 500",
                req.hints.len()
            )));
        }
        let client = make_client(req.endpoint.as_deref());
        let state = client
            .get_blockchain_state()
            .await
            .map_err(|e| EngineError::Internal(format!("coinset rpc: {e}")))?;
        let peak = state
            .blockchain_state
            .ok_or_else(|| EngineError::Internal("empty blockchain state".to_string()))?
            .peak
            .height;

        // coinset has a per-hint endpoint and a multi-hint endpoint
        // (get_coin_records_by_hints). Use the multi-hint form for batching.
        let mut all = Vec::new();
        for hint_str in &req.hints {
            let hint = parse_bytes32(hint_str.trim())?;
            let res = client
                .get_coin_records_by_hint(
                    hint,
                    req.start_height,
                    Some(peak + 1),
                    req.include_spent,
                )
                .await
                .map_err(|e| EngineError::Internal(format!("coinset rpc: {e}")))?;
            for r in res.coin_records.unwrap_or_default() {
                let mut json = serialize_coin_record(r);
                json["hint"] = serde_json::Value::String(hint_str.clone());
                all.push(json);
            }
        }
        Ok(serde_json::json!({
            "peak_height": peak,
            "coin_records": all,
        })
        .to_string())
    }

    /// Batch-check a list of coin ids: returns which ones have been spent
    /// since we last looked. JS keeps an "unspent set" in storage and pumps
    /// it through this every tick to detect outbound spends.
    ///
    /// Params: `{ "coin_ids": ["0x..."], "endpoint"?: "..." }`
    /// Returns: `{ "spent": [{coin_id, spent_block_index}],
    ///             "missing": ["0x..."] }`
    async fn check_coins_spent(&self, params_json: &str) -> Result<String, EngineError> {
        #[derive(Deserialize)]
        struct Req {
            coin_ids: Vec<String>,
            #[serde(default)]
            endpoint: Option<String>,
        }
        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;
        if req.coin_ids.is_empty() {
            return Ok(serde_json::json!({ "spent": [], "missing": [] }).to_string());
        }
        if req.coin_ids.len() > 500 {
            return Err(EngineError::InvalidParams(format!(
                "too many coin_ids ({}), max 500",
                req.coin_ids.len()
            )));
        }
        let ids = req
            .coin_ids
            .iter()
            .map(|s| parse_bytes32(s.trim()))
            .collect::<Result<Vec<_>, _>>()?;
        let client = make_client(req.endpoint.as_deref());
        let res = client
            .get_coin_records_by_names(ids.clone(), None, None, Some(true))
            .await
            .map_err(|e| EngineError::Internal(format!("coinset rpc: {e}")))?;
        let records = res.coin_records.unwrap_or_default();
        let returned: std::collections::HashSet<Bytes32> =
            records.iter().map(|r| r.coin.coin_id()).collect();
        let missing: Vec<String> = ids
            .iter()
            .filter(|id| !returned.contains(*id))
            .map(|id| format!("0x{}", hex::encode(id)))
            .collect();
        let spent: Vec<_> = records
            .into_iter()
            .filter(|r| r.spent)
            .map(|r| {
                serde_json::json!({
                    "coin_id": format!("0x{}", hex::encode(r.coin.coin_id())),
                    "spent_block_index": r.spent_block_index,
                })
            })
            .collect();
        Ok(serde_json::json!({
            "spent": spent,
            "missing": missing,
        })
        .to_string())
    }

    /// Fetch the unspent XCH balance held across a range of derived addresses
    /// by querying coinset.org directly. No local storage needed — perfect
    /// for showing "real" balances before the storage bridge ships.
    ///
    /// Accepts EITHER `fingerprint` (cached SK) OR `master_public_key`
    /// (stateless, works while locked).
    ///
    /// Params:
    /// `{ ("fingerprint": N | "master_public_key": "0x..."),
    ///    "start": K, "count": M, "testnet": bool,
    ///    "endpoint"?: "mainnet" | "testnet11" | "<url>" }`
    ///
    /// Returns:
    /// `{ "total_unspent_mojos": "<u128>", "total_unspent_xch": "<decimal>",
    ///    "unspent_coin_count": N, "addresses": [{index, puzzle_hash,
    ///    address, unspent_mojos: "<u128>", unspent_count}] }`
    async fn get_address_balance(&self, params_json: &str) -> Result<String, EngineError> {
        #[derive(Deserialize)]
        struct Req {
            #[serde(default)]
            fingerprint: Option<u32>,
            #[serde(default)]
            master_public_key: Option<String>,
            #[serde(default)]
            start: u32,
            #[serde(default = "default_balance_count")]
            count: u32,
            #[serde(default)]
            testnet: bool,
            #[serde(default)]
            endpoint: Option<String>,
        }
        fn default_balance_count() -> u32 {
            20
        }
        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;
        if req.count == 0 || req.count > 500 {
            return Err(EngineError::InvalidParams(format!(
                "count must be 1..=500, got {}",
                req.count
            )));
        }

        let master_pk = self.resolve_master_pk(req.fingerprint, req.master_public_key.as_deref())?;
        let prefix = if req.testnet { "txch" } else { "xch" };

        // Build the puzzle-hash list + address list in parallel arrays
        let mut puzzle_hashes: Vec<Bytes32> = Vec::with_capacity(req.count as usize);
        let mut address_meta = Vec::with_capacity(req.count as usize);
        for i in 0..req.count {
            let idx = req.start + i;
            let intermediate_pk = master_to_wallet_unhardened(&master_pk, idx);
            let synthetic_pk = intermediate_pk.derive_synthetic();
            let puzzle_hash: Bytes32 = StandardArgs::curry_tree_hash(synthetic_pk).into();
            let address = Address::new(puzzle_hash, prefix.to_string())
                .encode()
                .map_err(|e| EngineError::Internal(format!("bech32m: {e}")))?;
            puzzle_hashes.push(puzzle_hash);
            address_meta.push((idx, puzzle_hash, address));
        }

        let client = make_client(req.endpoint.as_deref());

        // Batch: coinset accepts a list, returns coin_records for all of them.
        // Filter to unspent (spent_block_index == 0).
        let res = client
            .get_coin_records_by_puzzle_hashes(puzzle_hashes.clone(), None, None, Some(false))
            .await
            .map_err(|e| EngineError::Internal(format!("coinset rpc: {e}")))?;
        let records = res.coin_records.unwrap_or_default();

        // Bucket by puzzle_hash so we can attribute per-address.
        let mut per_ph: std::collections::HashMap<Bytes32, (u128, u32)> =
            std::collections::HashMap::with_capacity(req.count as usize);
        let mut total_mojos: u128 = 0;
        let mut total_count: u32 = 0;
        for r in records {
            if r.spent {
                continue;
            }
            let entry = per_ph.entry(r.coin.puzzle_hash).or_insert((0, 0));
            entry.0 = entry.0.saturating_add(u128::from(r.coin.amount));
            entry.1 = entry.1.saturating_add(1);
            total_mojos = total_mojos.saturating_add(u128::from(r.coin.amount));
            total_count = total_count.saturating_add(1);
        }

        let addresses: Vec<_> = address_meta
            .into_iter()
            .map(|(idx, ph, addr)| {
                let (m, c) = per_ph.get(&ph).copied().unwrap_or((0, 0));
                serde_json::json!({
                    "index": idx,
                    "puzzle_hash": format!("0x{}", hex::encode(ph)),
                    "address": addr,
                    "unspent_mojos": m.to_string(),
                    "unspent_count": c,
                })
            })
            .collect();

        Ok(serde_json::json!({
            "total_unspent_mojos": total_mojos.to_string(),
            "total_unspent_xch": format_mojos_as_xch(total_mojos),
            "unspent_coin_count": total_count,
            "addresses": addresses,
        })
        .to_string())
    }

    /// Sage-aligned `get_keys`: list KeyInfo for every wallet the engine
    /// knows about. The engine doesn't persist a wallet list (JS does that
    /// in `chrome.storage.local`), so the JS side passes the encrypted
    /// keychain blobs as an array; the engine decodes the master public
    /// keys and synthesises a KeyInfo per fingerprint.
    ///
    /// Params: `{ "wallets": [{ "fingerprint": N, "keychain_blob": "hex",
    ///                          "name"?: "...", "emoji"?: "..." }] }`.
    /// Returns: `{ "keys": [KeyInfo] }`.
    async fn get_keys(&self, params_json: &str) -> Result<String, EngineError> {
        #[derive(Deserialize)]
        struct WalletEntry {
            fingerprint: u32,
            keychain_blob: String,
            #[serde(default)]
            name: Option<String>,
            #[serde(default)]
            emoji: Option<String>,
        }
        #[derive(Deserialize, Default)]
        struct Req {
            #[serde(default)]
            wallets: Vec<WalletEntry>,
        }
        let req: Req = if params_json.trim().is_empty() || params_json == "{}" {
            Req::default()
        } else {
            serde_json::from_str(params_json)
                .map_err(|e| EngineError::InvalidParams(e.to_string()))?
        };

        let mut keys = Vec::with_capacity(req.wallets.len());
        for w in req.wallets {
            let info = self
                .key_info_from_blob(w.fingerprint, &w.keychain_blob, w.name, w.emoji)
                .await?;
            keys.push(info);
        }
        Ok(serde_json::json!({ "keys": keys }).to_string())
    }

    /// Sage-aligned `get_key`: KeyInfo for a single wallet by fingerprint.
    /// Same JS-passes-the-blob model as `get_keys`.
    async fn get_key(&self, params_json: &str) -> Result<String, EngineError> {
        #[derive(Deserialize)]
        struct Req {
            fingerprint: u32,
            keychain_blob: String,
            #[serde(default)]
            name: Option<String>,
            #[serde(default)]
            emoji: Option<String>,
        }
        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;
        let info = self
            .key_info_from_blob(req.fingerprint, &req.keychain_blob, req.name, req.emoji)
            .await?;
        Ok(serde_json::json!({ "key": info }).to_string())
    }

    async fn key_info_from_blob(
        &self,
        fingerprint: u32,
        keychain_blob: &str,
        name: Option<String>,
        emoji: Option<String>,
    ) -> Result<serde_json::Value, EngineError> {
        let blob = hex::decode(keychain_blob.trim_start_matches("0x"))
            .map_err(|e| EngineError::InvalidParams(format!("keychain_blob hex: {e}")))?;
        let keychain = Keychain::from_bytes(&blob)
            .map_err(|e| EngineError::InvalidParams(format!("keychain decode: {e}")))?;
        let pk = keychain
            .extract_public_key(fingerprint)
            .map_err(|e| EngineError::Internal(e.to_string()))?
            .ok_or_else(|| {
                EngineError::InvalidParams(format!("fingerprint {fingerprint} not in keychain"))
            })?;
        let has_secrets = keychain.has_secret_key(fingerprint);
        let unlocked = self
            .unlocked
            .lock()
            .map(|g| g.contains_key(&fingerprint))
            .unwrap_or(false);
        Ok(serde_json::json!({
            "name": name.unwrap_or_else(|| format!("Wallet {fingerprint}")),
            "fingerprint": fingerprint,
            "public_key": format!("0x{}", hex::encode(pk.to_bytes())),
            "kind": if has_secrets { "Hd" } else { "PublicOnly" },
            "has_secrets": has_secrets,
            "network_id": "mainnet",
            "emoji": emoji,
            "arbor_only": false,
            "unlocked": unlocked,
        }))
    }

    /// Sage-aligned `get_sync_status` (lightweight). Native sage reads from
    /// the DB; we don't have storage wired yet so we report what we can
    /// from the engine + the most recent sync_tick snapshot (no balance
    /// numbers — those come from the JS-side coin-store today).
    async fn get_sync_status(&self, params_json: &str) -> Result<String, EngineError> {
        #[derive(Deserialize, Default)]
        struct Req {
            #[serde(default)]
            endpoint: Option<String>,
        }
        let req: Req = if params_json.trim().is_empty() || params_json == "{}" {
            Req::default()
        } else {
            serde_json::from_str(params_json).unwrap_or_default()
        };
        let client = make_client(req.endpoint.as_deref());
        let state = client
            .get_blockchain_state()
            .await
            .map_err(|e| EngineError::Internal(format!("coinset rpc: {e}")))?;
        let body = state
            .blockchain_state
            .ok_or_else(|| EngineError::Internal("empty blockchain state".to_string()))?;
        Ok(serde_json::json!({
            "balance": "0",
            "unit_decimals": 12,
            "unit_ticker": "XCH",
            "synced_coins": 0,
            "total_coins": 0,
            "receive_address": "",
            "burn_address": "",
            "header_hash": format!("0x{}", hex::encode(body.peak.header_hash)),
            "synced": body.sync.synced,
            "peak_height": body.peak.height,
        })
        .to_string())
    }

    /// Check whether a BIP-39 phrase parses + has a valid checksum.
    ///
    /// Params: `{ "mnemonic": "..." }`.
    /// Returns: `{ "valid": bool, "word_count": N, "error"?: "..." }`.
    async fn validate_mnemonic(&self, params_json: &str) -> Result<String, EngineError> {
        #[derive(Deserialize)]
        struct Req {
            mnemonic: String,
        }
        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;
        let trimmed = req.mnemonic.trim();
        let word_count = trimmed.split_whitespace().count();
        match Mnemonic::parse(trimmed) {
            Ok(_) => Ok(serde_json::json!({
                "valid": true,
                "word_count": word_count,
            })
            .to_string()),
            Err(e) => Ok(serde_json::json!({
                "valid": false,
                "word_count": word_count,
                "error": e.to_string(),
            })
            .to_string()),
        }
    }

    /// Verify a BLS signature against a message + public key.
    /// Useful for dApp sign-in flows (verifyMessage) and for popup smoke
    /// tests of sign_message.
    ///
    /// Params: `{ "message": hex, "public_key": hex, "signature": hex }`.
    /// Returns: `{ "valid": bool }`.
    async fn verify_signature(&self, params_json: &str) -> Result<String, EngineError> {
        use chia_wallet_sdk::chia::bls::verify;
        #[derive(Deserialize)]
        struct Req {
            message: String,
            public_key: String,
            signature: String,
        }
        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;
        let msg = hex::decode(req.message.trim_start_matches("0x"))
            .map_err(|e| EngineError::InvalidParams(format!("message hex: {e}")))?;
        let pk_bytes = hex::decode(req.public_key.trim_start_matches("0x"))
            .map_err(|e| EngineError::InvalidParams(format!("pk hex: {e}")))?;
        let sig_bytes = hex::decode(req.signature.trim_start_matches("0x"))
            .map_err(|e| EngineError::InvalidParams(format!("sig hex: {e}")))?;
        let pk = PublicKey::from_bytes(
            pk_bytes
                .as_slice()
                .try_into()
                .map_err(|_| EngineError::InvalidParams("pk must be 48 bytes".to_string()))?,
        )
        .map_err(|e| EngineError::InvalidParams(format!("pk: {e}")))?;
        let sig = Signature::from_bytes(
            sig_bytes
                .as_slice()
                .try_into()
                .map_err(|_| EngineError::InvalidParams("sig must be 96 bytes".to_string()))?,
        )
        .map_err(|e| EngineError::InvalidParams(format!("sig: {e}")))?;
        let valid = verify(&sig, &pk, &msg);
        Ok(serde_json::json!({ "valid": valid }).to_string())
    }

    /// Bulk-derive a range of addresses for the receive screen.
    ///
    /// Accepts EITHER `fingerprint` (uses the cached unlocked SK) OR
    /// `master_public_key` (stateless — works even when the engine is
    /// locked, useful for the background sync loop that runs after the SW
    /// dies and revives).
    ///
    /// Params: `{ ("fingerprint": N | "master_public_key": "0x..."),
    ///            "start": K, "count": M, "testnet": bool }`.
    /// Returns: `{ "addresses": [{ index, address, puzzle_hash, public_key }] }`.
    async fn derive_addresses(&self, params_json: &str) -> Result<String, EngineError> {
        #[derive(Deserialize)]
        struct Req {
            #[serde(default)]
            fingerprint: Option<u32>,
            #[serde(default)]
            master_public_key: Option<String>,
            #[serde(default)]
            start: u32,
            #[serde(default = "default_count")]
            count: u32,
            #[serde(default)]
            testnet: bool,
        }
        fn default_count() -> u32 {
            10
        }
        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;
        if req.count == 0 || req.count > 200 {
            return Err(EngineError::InvalidParams(format!(
                "count must be 1..=200, got {}",
                req.count
            )));
        }
        let master_pk = self.resolve_master_pk(req.fingerprint, req.master_public_key.as_deref())?;
        let prefix = if req.testnet { "txch" } else { "xch" };
        let mut out = Vec::with_capacity(req.count as usize);
        for i in 0..req.count {
            let idx = req.start + i;
            let intermediate_pk = master_to_wallet_unhardened(&master_pk, idx);
            let synthetic_pk = intermediate_pk.derive_synthetic();
            let puzzle_hash: Bytes32 = StandardArgs::curry_tree_hash(synthetic_pk).into();
            let address = Address::new(puzzle_hash, prefix.to_string())
                .encode()
                .map_err(|e| EngineError::Internal(format!("bech32m: {e}")))?;
            out.push(serde_json::json!({
                "index": idx,
                "address": address,
                "puzzle_hash": format!("0x{}", hex::encode(puzzle_hash)),
                "public_key": format!("0x{}", hex::encode(synthetic_pk.to_bytes())),
            }));
        }
        Ok(serde_json::json!({ "addresses": out }).to_string())
    }

    /// Validate a Chia bech32m address.
    ///
    /// Matches sage's `check_address` — returns `{ valid: bool }`. Extended
    /// with `puzzle_hash` + `prefix` when the address is valid so callers
    /// don't have to make a second roundtrip to parse it.
    ///
    /// Params: `{ "address": "xch1..." }` (sage-api `CheckAddress`).
    async fn check_address(&self, params_json: &str) -> Result<String, EngineError> {
        #[derive(Deserialize)]
        struct Req {
            address: String,
        }
        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;
        match Address::decode(req.address.trim()) {
            Ok(parsed) => Ok(serde_json::json!({
                "valid": true,
                "puzzle_hash": format!("0x{}", hex::encode(parsed.puzzle_hash)),
                "prefix": parsed.prefix,
            })
            .to_string()),
            Err(e) => Ok(serde_json::json!({
                "valid": false,
                "error": e.to_string(),
            })
            .to_string()),
        }
    }

    /// One sync poll against the configured Chia RPC backend.
    ///
    /// Today this is a smoke test: hit `get_blockchain_state` against the
    /// mainnet coinset.org endpoint and return the current peak height +
    /// sync mode + network info. Real wallet sync (per-puzzle-hash polling,
    /// hint walking, mempool watch) will come next on top of this.
    ///
    /// Params: `{ "endpoint"?: "mainnet" | "testnet11" | "<url>" }` (default
    /// mainnet).
    async fn sync_tick(&self, params_json: &str) -> Result<String, EngineError> {
        #[derive(Deserialize, Default)]
        struct Req {
            #[serde(default)]
            endpoint: Option<String>,
        }
        let req: Req = if params_json.trim().is_empty() || params_json == "{}" {
            Req::default()
        } else {
            serde_json::from_str(params_json)
                .map_err(|e| EngineError::InvalidParams(e.to_string()))?
        };
        let client = make_client(req.endpoint.as_deref());
        let state = client
            .get_blockchain_state()
            .await
            .map_err(|e| EngineError::Internal(format!("coinset rpc: {e}")))?;
        let body = state.blockchain_state.ok_or_else(|| {
            EngineError::Internal(state.error.unwrap_or_else(|| "empty response".to_string()))
        })?;
        Ok(serde_json::json!({
            "peak_height": body.peak.height,
            "peak_header_hash": format!("0x{}", hex::encode(body.peak.header_hash)),
            "synced": body.sync.synced,
            "sync_mode": body.sync.sync_mode,
            "mempool_size": body.mempool_size,
            "mempool_cost": body.mempool_cost,
            "difficulty": body.difficulty,
        })
        .to_string())
    }

    /// Generate a new BIP-39 mnemonic.
    ///
    /// Sage-compatible params: `{ "use_24_words": true }`.
    /// Extended params: `{ "words": 12|15|18|21|24 }`.
    /// Returns: `{ "mnemonic": "...", "word_count": N }`.
    async fn generate_mnemonic(&self, params_json: &str) -> Result<String, EngineError> {
        #[derive(Deserialize, Default)]
        struct Req {
            /// Sage native field — true = 24 words, false = 12.
            #[serde(default)]
            use_24_words: Option<bool>,
            /// Extended: exact word count (12/15/18/21/24).
            #[serde(default)]
            words: Option<u8>,
        }
        let req: Req = if params_json.trim().is_empty() || params_json == "{}" {
            Req::default()
        } else {
            serde_json::from_str(params_json)
                .map_err(|e| EngineError::InvalidParams(e.to_string()))?
        };

        let count = match (req.words, req.use_24_words) {
            (Some(n), _) => n,
            (None, Some(true)) | (None, None) => 24,
            (None, Some(false)) => 12,
        };
        match count {
            12 | 15 | 18 | 21 | 24 => {}
            other => {
                return Err(EngineError::InvalidParams(format!(
                    "word count must be 12/15/18/21/24, got {other}"
                )));
            }
        }

        let mnemonic = Mnemonic::generate(count as usize)
            .map_err(|e| EngineError::Internal(e.to_string()))?;
        Ok(serde_json::json!({
            "mnemonic": mnemonic.to_string(),
            "word_count": count,
        })
        .to_string())
    }

    /// Validate a mnemonic, compute its fingerprint, and encrypt the entropy
    /// with the given password into a sage-keychain blob.
    ///
    /// The blob lives in `chrome.storage.local` keyed by fingerprint; the
    /// engine never persists it itself.
    ///
    /// Sage native uses `ImportKey { name, key, derivation_index, save_secrets }`
    /// where `key` is the mnemonic. We accept either field (`key` matches
    /// sage, `mnemonic` matches our older shape).
    ///
    /// Params (any of the following work):
    ///   `{ "mnemonic": "...", "password": "...", "testnet"?: bool, "name"?: "..." }`
    ///   `{ "key":       "...", "password": "...", "testnet"?: bool, "name"?: "..." }`
    ///
    /// Returns: `{ "fingerprint", "master_public_key", "keychain_blob",
    ///             "address_0", "name"? }`.
    async fn import_key(&self, params_json: &str) -> Result<String, EngineError> {
        #[derive(Deserialize)]
        struct Req {
            // Accept both names.
            #[serde(default)]
            mnemonic: Option<String>,
            #[serde(default)]
            key: Option<String>,
            password: String,
            #[serde(default)]
            testnet: bool,
            #[serde(default)]
            name: Option<String>,
        }
        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;
        let mnemonic_input = req
            .key
            .as_deref()
            .or(req.mnemonic.as_deref())
            .ok_or_else(|| {
                EngineError::InvalidParams("missing `mnemonic` or `key` field".to_string())
            })?;
        let password = req.password;
        let testnet = req.testnet;
        let name = req.name;
        return self.do_import_key(mnemonic_input, &password, testnet, name).await;
    }

    /// Legacy entrypoint that still expects only the old-shape body.
    async fn do_import_key(
        &self,
        mnemonic_str: &str,
        password: &str,
        testnet: bool,
        name: Option<String>,
    ) -> Result<String, EngineError> {
        #[allow(dead_code)]
        struct Req {
            mnemonic: String,
            password: String,
            testnet: bool,
        }
        let _ = Req {
            mnemonic: String::new(),
            password: String::new(),
            testnet: false,
        };

        let mnemonic = Mnemonic::parse(mnemonic_str.trim())
            .map_err(|e| EngineError::InvalidParams(format!("mnemonic: {e}")))?;

        let mut keychain = Keychain::default();
        let fingerprint = keychain
            .add_mnemonic(&mnemonic, password.as_bytes())
            .map_err(|e| EngineError::Internal(e.to_string()))?;
        let blob = keychain
            .to_bytes()
            .map_err(|e| EngineError::Internal(e.to_string()))?;

        // Derive the first address as a nice confirmation for the UI.
        let seed = mnemonic.to_seed("");
        let master_sk = SecretKey::from_seed(&seed);
        let intermediate_pk = master_to_wallet_unhardened(&master_sk.public_key(), 0);
        let synthetic_pk = intermediate_pk.derive_synthetic();
        let puzzle_hash: Bytes32 = StandardArgs::curry_tree_hash(synthetic_pk).into();
        let prefix = if testnet { "txch" } else { "xch" };
        let address_0 = Address::new(puzzle_hash, prefix.to_string())
            .encode()
            .map_err(|e| EngineError::Internal(format!("bech32m: {e}")))?;

        Ok(serde_json::json!({
            "fingerprint": fingerprint,
            "master_public_key": format!("0x{}", hex::encode(master_sk.public_key().to_bytes())),
            "keychain_blob": hex::encode(&blob),
            "address_0": address_0,
            "name": name,
        })
        .to_string())
    }

    /// Sage-aligned `login`. Decrypts a keychain blob with the password and
    /// caches the master SK in memory for the given fingerprint. Returns
    /// the unlocked KeyInfo plus the mnemonic (for the popup's
    /// "show recovery phrase" flow).
    ///
    /// In native sage `login` only takes `{fingerprint}` because the
    /// keychain lives on disk; in WASM the blob lives in JS storage so
    /// the JS side passes both.
    ///
    /// Params: `{ "keychain_blob": "hex...", "fingerprint": N, "password": "..." }`.
    /// Returns: `{ "fingerprint": N, "mnemonic": "...", "master_public_key": "0x..." }`.
    async fn login(&self, params_json: &str) -> Result<String, EngineError> {
        #[derive(Deserialize)]
        struct Req {
            keychain_blob: String,
            fingerprint: u32,
            password: String,
        }
        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;

        let blob = hex::decode(req.keychain_blob.trim_start_matches("0x"))
            .map_err(|e| EngineError::InvalidParams(format!("keychain_blob hex: {e}")))?;
        let keychain = Keychain::from_bytes(&blob)
            .map_err(|e| EngineError::InvalidParams(format!("keychain decode: {e}")))?;

        let master_pk = keychain
            .extract_public_key(req.fingerprint)
            .map_err(|e| EngineError::Internal(e.to_string()))?
            .ok_or_else(|| {
                EngineError::InvalidParams(format!(
                    "fingerprint {} not in keychain",
                    req.fingerprint
                ))
            })?;

        let (mnemonic, sk) = keychain
            .extract_secrets(req.fingerprint, req.password.as_bytes())
            .map_err(|_e| EngineError::InvalidParams("wrong password".to_string()))?;

        let mnemonic_str = mnemonic
            .map(|m| m.to_string())
            .ok_or_else(|| EngineError::Internal("no mnemonic stored".to_string()))?;

        // Cache the master SK so subsequent derive/sign calls don't need the
        // password again for the rest of this engine's lifetime.
        if let Some(sk) = sk {
            let mut guard = self
                .unlocked
                .lock()
                .map_err(|_| EngineError::Internal("unlocked-cache mutex poisoned".to_string()))?;
            guard.insert(req.fingerprint, sk);
        }

        Ok(serde_json::json!({
            "fingerprint": req.fingerprint,
            "mnemonic": mnemonic_str,
            "master_public_key": format!("0x{}", hex::encode(master_pk.to_bytes())),
        })
        .to_string())
    }

    /// Derive a Chia address.
    ///
    /// Two modes:
    /// * `{ "fingerprint": N, "index": K, "testnet": bool }` — uses the
    ///   unlocked SK cached at `unlock_keychain` time. Preferred.
    /// * `{ "mnemonic": "...", "index": K, "testnet": bool }` — pure stateless
    ///   path that re-derives from a mnemonic. Kept for one-off lookups.
    async fn derive_address(&self, params_json: &str) -> Result<String, EngineError> {
        let req: DeriveAddressRequest = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;

        let master_pk: PublicKey = if let Some(fp) = req.fingerprint {
            self.unlocked_sk(fp)?.public_key()
        } else if let Some(mnemonic_str) = req.mnemonic.as_deref() {
            let mnemonic = Mnemonic::parse(mnemonic_str.trim())
                .map_err(|e| EngineError::InvalidParams(format!("mnemonic: {e}")))?;
            SecretKey::from_seed(&mnemonic.to_seed("")).public_key()
        } else {
            return Err(EngineError::InvalidParams(
                "derive_address requires either `fingerprint` (preferred) or `mnemonic`"
                    .to_string(),
            ));
        };

        let intermediate_pk: PublicKey = master_to_wallet_unhardened(&master_pk, req.index);
        let synthetic_pk = intermediate_pk.derive_synthetic();
        let puzzle_hash: Bytes32 = StandardArgs::curry_tree_hash(synthetic_pk).into();
        let prefix = if req.testnet { "txch" } else { "xch" };
        let address = Address::new(puzzle_hash, prefix.to_string())
            .encode()
            .map_err(|e| EngineError::Internal(format!("bech32m: {e}")))?;

        let _ = self.storage.handle(); // silence dead-code for now

        Ok(serde_json::json!({
            "address": address,
            "puzzle_hash": format!("0x{}", hex::encode(puzzle_hash)),
            "public_key": format!("0x{}", hex::encode(synthetic_pk.to_bytes())),
            "index": req.index,
            "testnet": req.testnet,
        })
        .to_string())
    }

    /// Sage-aligned `logout`. Clears the cached SK for one fingerprint
    /// (or all if omitted). Native sage takes no params; we accept an
    /// optional `fingerprint` for multi-wallet scoping.
    async fn logout(&self, params_json: &str) -> Result<String, EngineError> {
        #[derive(Deserialize, Default)]
        struct Req {
            fingerprint: Option<u32>,
        }
        let req: Req = if params_json.trim().is_empty() || params_json == "{}" {
            Req::default()
        } else {
            serde_json::from_str(params_json)
                .map_err(|e| EngineError::InvalidParams(e.to_string()))?
        };

        let mut guard = self
            .unlocked
            .lock()
            .map_err(|_| EngineError::Internal("unlocked-cache mutex poisoned".to_string()))?;
        match req.fingerprint {
            Some(fp) => {
                guard.remove(&fp);
            }
            None => guard.clear(),
        }

        Ok(serde_json::json!({ "locked": true }).to_string())
    }

    /// Report whether a given fingerprint is currently unlocked in this
    /// engine instance.
    async fn is_unlocked(&self, params_json: &str) -> Result<String, EngineError> {
        #[derive(Deserialize)]
        struct Req {
            fingerprint: u32,
        }
        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;
        let guard = self
            .unlocked
            .lock()
            .map_err(|_| EngineError::Internal("unlocked-cache mutex poisoned".to_string()))?;
        Ok(serde_json::json!({
            "fingerprint": req.fingerprint,
            "unlocked": guard.contains_key(&req.fingerprint),
        })
        .to_string())
    }

    /// BLS-sign a message with a derived key.
    ///
    /// `message` is hex (with or without leading `0x`). The signing key is
    /// the synthetic key at `index` for the unlocked fingerprint — i.e. the
    /// same key that owns the address at that index. Uses the standard
    /// BLS augmented scheme (`sign`).
    async fn sign_message(&self, params_json: &str) -> Result<String, EngineError> {
        #[derive(Deserialize)]
        struct Req {
            fingerprint: u32,
            #[serde(default)]
            index: u32,
            message: String,
        }
        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;

        let master_sk = self.unlocked_sk(req.fingerprint)?;
        let intermediate_sk = master_to_wallet_unhardened(&master_sk, req.index);
        let synthetic_sk = intermediate_sk.derive_synthetic();

        let bytes = hex::decode(req.message.trim_start_matches("0x"))
            .map_err(|e| EngineError::InvalidParams(format!("message hex: {e}")))?;
        let signature: Signature = sign(&synthetic_sk, &bytes);

        Ok(serde_json::json!({
            "signature": format!("0x{}", hex::encode(signature.to_bytes())),
            "public_key": format!("0x{}", hex::encode(synthetic_sk.public_key().to_bytes())),
            "index": req.index,
        })
        .to_string())
    }
}

fn make_client(endpoint: Option<&str>) -> CoinsetClient {
    match endpoint {
        None | Some("mainnet") => CoinsetClient::mainnet(),
        Some("testnet11") => CoinsetClient::testnet11(),
        Some(url) => CoinsetClient::new(url.to_string()),
    }
}

fn parse_bytes32(s: &str) -> Result<Bytes32, EngineError> {
    let bytes = hex::decode(s.trim_start_matches("0x"))
        .map_err(|e| EngineError::InvalidParams(format!("hex: {e}")))?;
    let arr: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| EngineError::InvalidParams("expected 32 bytes".to_string()))?;
    Ok(Bytes32::from(arr))
}

struct CatBucket {
    asset_id: Bytes32,
    coins: Vec<CatCoinView>,
}

#[derive(Clone)]
struct CatCoinView {
    coin_id: Bytes32,
    parent_coin_info: Bytes32,
    puzzle_hash: Bytes32,
    amount: u64,
    inner_puzzle_hash: Bytes32,
    hint: Bytes32,
    confirmed_block_index: u32,
    spent: bool,
    spent_block_index: u32,
}

fn serialize_coin_spend(cs: &CoinSpend) -> serde_json::Value {
    serde_json::json!({
        "coin": {
            "parent_coin_info": format!("0x{}", hex::encode(cs.coin.parent_coin_info)),
            "puzzle_hash": format!("0x{}", hex::encode(cs.coin.puzzle_hash)),
            "amount": cs.coin.amount.to_string(),
        },
        "puzzle_reveal": format!("0x{}", hex::encode(cs.puzzle_reveal.as_ref())),
        "solution": format!("0x{}", hex::encode(cs.solution.as_ref())),
    })
}

fn serialize_coin_record(r: chia_wallet_sdk::coinset::CoinRecord) -> serde_json::Value {
    serde_json::json!({
        "coin_id": format!("0x{}", hex::encode(r.coin.coin_id())),
        "parent_coin_info": format!("0x{}", hex::encode(r.coin.parent_coin_info)),
        "puzzle_hash": format!("0x{}", hex::encode(r.coin.puzzle_hash)),
        "amount": r.coin.amount.to_string(),
        "coinbase": r.coinbase,
        "confirmed_block_index": r.confirmed_block_index,
        "spent": r.spent,
        "spent_block_index": r.spent_block_index,
        "timestamp": r.timestamp,
    })
}

/// Render a mojos amount (12 decimals) as a fixed-point XCH string with
/// trailing zeros trimmed but at least four decimals shown ("0.0000").
fn format_mojos_as_xch(mojos: u128) -> String {
    const SCALE: u128 = 1_000_000_000_000;
    let whole = mojos / SCALE;
    let frac = mojos % SCALE;
    let frac_str = format!("{frac:012}");
    let trimmed = frac_str.trim_end_matches('0');
    let display = if trimmed.len() < 4 {
        format!("{whole}.{:0<4}", trimmed)
    } else {
        format!("{whole}.{trimmed}")
    };
    display
}

#[derive(Debug, Serialize, Deserialize)]
struct DeriveAddressRequest {
    #[serde(default)]
    fingerprint: Option<u32>,
    #[serde(default)]
    mnemonic: Option<String>,
    #[serde(default)]
    index: u32,
    #[serde(default)]
    testnet: bool,
}
