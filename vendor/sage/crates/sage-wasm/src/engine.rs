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
        bls::{master_to_wallet_hardened, master_to_wallet_unhardened, PublicKey, SecretKey, Signature, sign},
        puzzle_types::{standard::StandardArgs, DeriveSynthetic},
    },
    coinset::{ChiaRpcClient, CoinsetClient},
    prelude::*,
    utils::Address,
};
use sage_keychain::Keychain;
use serde::{Deserialize, Serialize};
use wasm_bindgen::JsValue;

/// Direct console.log helper — tracing::* in this crate is a stub, so we
/// route diagnostic breadcrumbs through web_sys when we need to track
/// per-PH progress through scan_nfts / scan_cats. Visible in the SW
/// console; captured by `sw.on("console", ...)` in playwright benches.
fn wlog(msg: &str) {
    web_sys::console::log_1(&JsValue::from_str(msg));
}

/// Current size of the wasm linear memory, in bytes. wasm32 can only GROW —
/// it never shrinks even after dropping allocations — so if this number
/// climbs monotonically across chunks we have a leak (or a peak that keeps
/// growing). Used to instrument scan_nfts / scan_cats for memory diagnosis.
fn wasm_memory_bytes() -> usize {
    let pages = core::arch::wasm32::memory_size(0);
    pages.saturating_mul(64 * 1024)
}

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
            "import_secret_key" => self.import_secret_key(params_json).await,
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
            "derive_addresses_hardened" => self.derive_addresses_hardened(params_json).await,
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
            // ─── Split phase-1/phase-2 scans (Chrome MV3 SW lifetime) ────
            // The legacy scan_* endpoints do hint-fetch + parent-fetch +
            // CLVM parse in one call, which exceeds the 60s service-worker
            // cap for wallets with deep history. The split lets JS persist
            // raw candidates between SW lifecycles and parse them later.
            // `asset_scan_hints` is the unified phase-1 that supersedes
            // `nft_scan_hints` + `cat_scan_hints` — they used to re-fetch
            // the same hints from coinset twice. The legacy names are
            // kept as aliases for backwards-compat.
            "asset_scan_hints" => self.asset_scan_hints(params_json).await,
            "nft_scan_hints" => self.asset_scan_hints(params_json).await,
            "cat_scan_hints" => self.asset_scan_hints(params_json).await,
            "nft_parse_candidates" => self.nft_parse_candidates(params_json).await,
            "cat_parse_candidates" => self.cat_parse_candidates(params_json).await,
            "send_cat" => self.send_cat(params_json).await,
            "issue_cat" => self.issue_cat(params_json).await,
            "create_did" => self.create_did(params_json).await,
            "transfer_did" => self.transfer_did(params_json).await,
            "normalize_did" => self.normalize_did(params_json).await,
            "transfer_nft" => self.transfer_nft(params_json).await,
            "add_nft_uri" => self.add_nft_uri(params_json).await,
            "decode_offer" => self.decode_offer(params_json).await,
            "take_offer" => self.take_offer(params_json).await,
            "make_offer" => self.make_offer(params_json).await,
            "bulk_mint_nfts" => self.bulk_mint_nfts(params_json).await,
            "analyze_coin_spends" => self.analyze_coin_spends(params_json).await,

            other => Err(EngineError::NotImplemented(other.to_string())),
        }
    }

    /// Send a CAT — build a SpendBundle from one or more input CAT coins,
    /// sign every required AGG_SIG, and push it via coinset.
    ///
    /// JS does coin selection (against `chrome.storage.local["coins.<fp>"].cats`)
    /// and hands the engine the full per-coin info we captured in scan_cats:
    /// puzzle_hash, inner_puzzle_hash, lineage_proof, derivation_index.
    ///
    /// Params:
    /// ```
    /// {
    ///   fingerprint: u32,
    ///   asset_id: "0x<tail_hash>",
    ///   recipient_address: "xch1...",
    ///   amount_mojos: "1000",
    ///   fee_mojos: "0",
    ///   input_coins: [{
    ///     parent_coin_info: "0x...",
    ///     puzzle_hash: "0x...",          // outer CAT puzzle hash
    ///     amount: "5000",
    ///     inner_puzzle_hash: "0x...",    // OUR p2 inner ph
    ///     derivation_index: u32,
    ///     lineage_proof: {
    ///       parent_name, inner_puzzle_hash, amount
    ///     }
    ///   }],
    ///   change_index: u32,
    ///   endpoint?, broadcast? (default true)
    /// }
    /// ```
    async fn send_cat(&self, params_json: &str) -> Result<String, EngineError> {
        use chia_wallet_sdk::{
            chia::{
                bls::{sign, Signature},
                consensus::consensus_constants::ConsensusConstants,
                protocol::SpendBundle,
                puzzle_types::LineageProof,
            },
            driver::{Cat, CatInfo, CatSpend, SpendContext, StandardLayer},
            signer::{AggSigConstants, RequiredBlsSignature, RequiredSignature},
            types::MAINNET_CONSTANTS,
        };

        #[derive(Deserialize)]
        struct LineageJson {
            parent_name: String,
            inner_puzzle_hash: String,
            amount: String,
        }
        #[derive(Deserialize)]
        struct InputCoinJson {
            parent_coin_info: String,
            puzzle_hash: String,
            amount: String,
            inner_puzzle_hash: String,
            #[serde(default)]
            hidden_puzzle_hash: Option<String>,
            derivation_index: u32,
            lineage_proof: LineageJson,
        }
        // Oleada-2 multi-output for CATs: each entry maps 1:1 to a CREATE_COIN
        // on the head CAT inner spend, automatically hinted with the inner_ph
        // so the recipient's wallet can index by hint.
        #[derive(Deserialize)]
        struct OutputSpec {
            address: String,
            amount: String,
        }
        #[derive(Deserialize)]
        struct Req {
            fingerprint: u32,
            asset_id: String,
            // Legacy single-output. Either (recipient_address+amount_mojos) OR
            // `outputs` MUST be present, never both.
            #[serde(default)]
            recipient_address: Option<String>,
            #[serde(default)]
            amount_mojos: Option<String>,
            // New multi-output (Oleada 2). Use for bulkSendCat.
            #[serde(default)]
            outputs: Option<Vec<OutputSpec>>,
            #[serde(default = "default_zero_mojos_cat")]
            fee_mojos: String,
            input_coins: Vec<InputCoinJson>,
            #[serde(default)]
            change_index: u32,
            #[serde(default)]
            endpoint: Option<String>,
            #[serde(default = "default_true_cat")]
            broadcast: bool,
        }
        fn default_zero_mojos_cat() -> String {
            "0".to_string()
        }
        fn default_true_cat() -> bool {
            true
        }

        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;

        // Normalise legacy single-output / new multi-output into one Vec.
        struct ParsedOutput {
            inner_ph: Bytes32,
            amount: u64,
        }
        let mut outputs: Vec<ParsedOutput> = Vec::new();
        match (&req.outputs, &req.recipient_address, &req.amount_mojos) {
            (Some(outs), None, None) => {
                if outs.is_empty() {
                    return Err(EngineError::InvalidParams(
                        "outputs is empty — provide at least one entry".to_string(),
                    ));
                }
                if outs.len() > 25 {
                    return Err(EngineError::InvalidParams(format!(
                        "too many outputs ({}), max 25 per CAT send",
                        outs.len()
                    )));
                }
                for (i, o) in outs.iter().enumerate() {
                    let amt: u64 = o.amount.parse().map_err(|_| {
                        EngineError::InvalidParams(format!(
                            "outputs[{i}].amount must be u64"
                        ))
                    })?;
                    if amt == 0 {
                        return Err(EngineError::InvalidParams(format!(
                            "outputs[{i}].amount must be > 0"
                        )));
                    }
                    let addr = Address::decode(o.address.trim()).map_err(|e| {
                        EngineError::InvalidParams(format!("outputs[{i}].address: {e}"))
                    })?;
                    outputs.push(ParsedOutput {
                        inner_ph: addr.puzzle_hash,
                        amount: amt,
                    });
                }
            }
            (None, Some(addr), Some(amount_str)) => {
                let amt: u64 = amount_str.parse().map_err(|_| {
                    EngineError::InvalidParams("amount_mojos must be u64".to_string())
                })?;
                if amt == 0 {
                    return Err(EngineError::InvalidParams(
                        "amount_mojos must be > 0".to_string(),
                    ));
                }
                let recipient = Address::decode(addr.trim())
                    .map_err(|e| EngineError::InvalidParams(format!("recipient: {e}")))?;
                outputs.push(ParsedOutput {
                    inner_ph: recipient.puzzle_hash,
                    amount: amt,
                });
            }
            (Some(_), Some(_), _) | (Some(_), _, Some(_)) => {
                return Err(EngineError::InvalidParams(
                    "send_cat: pass either `outputs` OR (`recipient_address` + `amount_mojos`), not both"
                        .to_string(),
                ));
            }
            _ => {
                return Err(EngineError::InvalidParams(
                    "send_cat needs `outputs` or (`recipient_address` + `amount_mojos`)"
                        .to_string(),
                ));
            }
        };

        let fee: u64 = req
            .fee_mojos
            .parse()
            .map_err(|_| EngineError::InvalidParams("fee_mojos must be u64".to_string()))?;
        let mut amount: u64 = 0;
        for o in &outputs {
            amount = amount.checked_add(o.amount).ok_or_else(|| {
                EngineError::InvalidParams("output sum overflow".to_string())
            })?;
        }
        if req.input_coins.is_empty() {
            return Err(EngineError::InvalidParams("input_coins is empty".to_string()));
        }
        if req.input_coins.len() > 25 {
            return Err(EngineError::InvalidParams(format!(
                "too many input_coins ({}), max 25 for a CAT send",
                req.input_coins.len()
            )));
        }

        let asset_id = parse_bytes32(&req.asset_id)?;

        // 1. Reconstruct each input Cat + derive its synthetic SK
        let master_sk = self.unlocked_sk(req.fingerprint)?;
        struct ParsedInput {
            cat: Cat,
            sk: SecretKey,
            pk: PublicKey,
        }
        let mut parsed: Vec<ParsedInput> = Vec::with_capacity(req.input_coins.len());
        let mut total_input: u64 = 0;
        for c in &req.input_coins {
            let amt: u64 = c
                .amount
                .parse()
                .map_err(|_| EngineError::InvalidParams("input amount u64".to_string()))?;
            total_input = total_input
                .checked_add(amt)
                .ok_or_else(|| EngineError::InvalidParams("input sum overflow".to_string()))?;
            let parent = parse_bytes32(&c.parent_coin_info)?;
            let outer_ph = parse_bytes32(&c.puzzle_hash)?;
            let inner_ph = parse_bytes32(&c.inner_puzzle_hash)?;
            let hidden_ph = c
                .hidden_puzzle_hash
                .as_deref()
                .map(parse_bytes32)
                .transpose()?;
            let lineage_parent_name = parse_bytes32(&c.lineage_proof.parent_name)?;
            let lineage_inner_ph = parse_bytes32(&c.lineage_proof.inner_puzzle_hash)?;
            let lineage_amount: u64 = c
                .lineage_proof
                .amount
                .parse()
                .map_err(|_| EngineError::InvalidParams("lineage amount u64".to_string()))?;

            // Verify we own this inner_ph at derivation_index
            let intermediate = master_to_wallet_unhardened(&master_sk, c.derivation_index);
            let synthetic_sk = intermediate.derive_synthetic();
            let synthetic_pk = synthetic_sk.public_key();
            let derived_inner: Bytes32 = StandardArgs::curry_tree_hash(synthetic_pk).into();
            if derived_inner != inner_ph {
                return Err(EngineError::InvalidParams(format!(
                    "input inner_puzzle_hash {} doesn't match derivation_index {}",
                    hex::encode(inner_ph),
                    c.derivation_index
                )));
            }

            let cat = Cat {
                coin: Coin::new(parent, outer_ph, amt),
                lineage_proof: Some(LineageProof {
                    parent_parent_coin_info: lineage_parent_name,
                    parent_inner_puzzle_hash: lineage_inner_ph,
                    parent_amount: lineage_amount,
                }),
                info: CatInfo {
                    asset_id,
                    hidden_puzzle_hash: hidden_ph,
                    p2_puzzle_hash: inner_ph,
                },
            };
            parsed.push(ParsedInput {
                cat,
                sk: synthetic_sk,
                pk: synthetic_pk,
            });
        }

        if total_input < amount {
            return Err(EngineError::InvalidParams(format!(
                "input CAT coins sum to {total_input} but {amount} needed (CAT amount)"
            )));
        }
        let cat_change = total_input - amount;

        // 2. Change p2 puzzle hash (derived from change_index)
        let change_intermediate_sk = master_to_wallet_unhardened(&master_sk, req.change_index);
        let change_synthetic_pk = change_intermediate_sk.derive_synthetic().public_key();
        let change_inner_ph: Bytes32 =
            StandardArgs::curry_tree_hash(change_synthetic_pk).into();

        // 3. Build the inner spends. Cat::spend_all expects one CatSpend per
        //    input, where the spend is the INNER puzzle's spend (the wrapping
        //    cat layer is added by Cat::spend_all). For the standard p2 puzzle
        //    that means StandardLayer::spend_with_conditions.
        //
        //    First CAT: outputs (recipient + change) + reserve_fee for XCH fee.
        //    Tail CATs: no outputs.
        let mut ctx = SpendContext::new();

        let mut cat_spends: Vec<CatSpend> = Vec::with_capacity(parsed.len());
        for (i, p) in parsed.iter().enumerate() {
            let conditions = if i == 0 {
                let mut c = Conditions::new();
                for o in &outputs {
                    c = c.create_coin(
                        o.inner_ph,
                        o.amount,
                        ctx.hint(o.inner_ph)
                            .map_err(|e| EngineError::Internal(format!("hint memos: {e}")))?,
                    );
                }
                if fee > 0 {
                    c = c.reserve_fee(fee);
                }
                if cat_change > 0 {
                    c = c.create_coin(
                        change_inner_ph,
                        cat_change,
                        ctx.hint(change_inner_ph)
                            .map_err(|e| EngineError::Internal(format!("hint memos: {e}")))?,
                    );
                }
                c
            } else {
                Conditions::new()
            };

            let inner_spend = StandardLayer::new(p.pk)
                .spend_with_conditions(&mut ctx, conditions)
                .map_err(|e| EngineError::Internal(format!("std spend_with_conditions: {e}")))?;
            cat_spends.push(CatSpend::new(p.cat, inner_spend));
        }

        Cat::spend_all(&mut ctx, &cat_spends)
            .map_err(|e| EngineError::Internal(format!("Cat::spend_all: {e}")))?;

        let coin_spends = ctx.take();

        // 4. Sign required AGG_SIGs against the right SK
        let constants: &ConsensusConstants = &MAINNET_CONSTANTS;
        let agg_sig_consts = AggSigConstants::new(constants.agg_sig_me_additional_data);
        let required = RequiredSignature::from_coin_spends(
            &mut ctx,
            &coin_spends,
            &agg_sig_consts,
        )
        .map_err(|e| EngineError::Internal(format!("required_signatures: {e}")))?;

        let mut sks_by_pk: std::collections::HashMap<Vec<u8>, SecretKey> =
            std::collections::HashMap::new();
        for p in &parsed {
            sks_by_pk.insert(p.pk.to_bytes().to_vec(), p.sk.clone());
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
                            "no secret key for pubkey {}",
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
                        "SECP signatures not supported in send_cat".to_string(),
                    ));
                }
            }
        }

        let bundle = SpendBundle::new(coin_spends.clone(), aggregated);

        // 5. Push (unless dry-run)
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
            "cat_change_mojos": cat_change.to_string(),
            "input_count": req.input_coins.len(),
            "total_input_mojos": total_input.to_string(),
        })
        .to_string())
    }

    /// Issue a new CAT via a single-issuance TAIL (GenesisByCoinId).
    ///
    /// The TAIL is derived from the chosen XCH coin's coin_id, so only ONE
    /// emission is possible (re-running with the same coin would collide; the
    /// coin is already spent). The asset_id returned to the caller is the
    /// TAIL puzzle hash.
    ///
    /// One XCH input coin pays for everything:
    ///   input_amt = amount (eve CAT mojos) + fee + change_back
    ///
    /// Params:
    /// ```
    /// {
    ///   fingerprint: u32,
    ///   recipient_address: "xch1...",        // recipient's p2 inner_ph
    ///   amount_mojos: "1000",                 // initial CAT supply
    ///   fee_mojos?: "0",
    ///   input_coin: { parent_coin_info, puzzle_hash, amount,
    ///                 derivation_index },     // XCH input (also TAIL parent)
    ///   change_index?: u32,
    ///   endpoint?: "mainnet" | "testnet11" | "<url>",
    ///   broadcast?: true
    /// }
    /// ```
    ///
    /// Returns: `{ tx_id, asset_id, status, error?, spend_bundle, change_mojos }`.
    async fn issue_cat(&self, params_json: &str) -> Result<String, EngineError> {
        use chia_wallet_sdk::{
            chia::{
                bls::{sign, Signature},
                consensus::consensus_constants::ConsensusConstants,
                protocol::SpendBundle,
            },
            driver::{Cat, SpendContext, StandardLayer},
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
            #[serde(default = "default_zero_mojos_issue")]
            fee_mojos: String,
            input_coin: InputCoin,
            #[serde(default)]
            change_index: u32,
            #[serde(default)]
            endpoint: Option<String>,
            #[serde(default = "default_true_issue")]
            broadcast: bool,
        }
        fn default_zero_mojos_issue() -> String {
            "0".to_string()
        }
        fn default_true_issue() -> bool {
            true
        }

        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;

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
        let input_amt: u64 = req
            .input_coin
            .amount
            .parse()
            .map_err(|_| EngineError::InvalidParams("input amount must be u64".to_string()))?;
        let needed = amount
            .checked_add(fee)
            .ok_or_else(|| EngineError::InvalidParams("amount + fee overflow".to_string()))?;
        if input_amt < needed {
            return Err(EngineError::InvalidParams(format!(
                "input coin {input_amt} mojos < {needed} (amount + fee)"
            )));
        }
        let change = input_amt - needed;

        let parent = parse_bytes32(&req.input_coin.parent_coin_info)?;
        let parent_ph = parse_bytes32(&req.input_coin.puzzle_hash)?;
        let parent_coin = Coin::new(parent, parent_ph, input_amt);
        let parent_coin_id = parent_coin.coin_id();

        let recipient = Address::decode(req.recipient_address.trim())
            .map_err(|e| EngineError::InvalidParams(format!("recipient: {e}")))?;
        let recipient_inner_ph = recipient.puzzle_hash;

        // Derive SK + verify the XCH coin actually belongs to derivation_index.
        let master_sk = self.unlocked_sk(req.fingerprint)?;
        let intermediate =
            master_to_wallet_unhardened(&master_sk, req.input_coin.derivation_index);
        let synthetic_sk = intermediate.derive_synthetic();
        let synthetic_pk = synthetic_sk.public_key();
        let derived_ph: Bytes32 = StandardArgs::curry_tree_hash(synthetic_pk).into();
        if derived_ph != parent_ph {
            return Err(EngineError::InvalidParams(format!(
                "input_coin puzzle_hash {} doesn't match derivation_index {}",
                hex::encode(parent_ph),
                req.input_coin.derivation_index,
            )));
        }

        let change_intermediate_sk = master_to_wallet_unhardened(&master_sk, req.change_index);
        let change_synthetic_pk = change_intermediate_sk.derive_synthetic().public_key();
        let change_ph: Bytes32 = StandardArgs::curry_tree_hash(change_synthetic_pk).into();

        let mut ctx = SpendContext::new();

        // Inner conditions the eve CAT will run: forward the full minted
        // amount to the recipient's p2 inner_ph, hinted for indexing.
        let inner_memos = ctx
            .hint(recipient_inner_ph)
            .map_err(|e| EngineError::Internal(format!("hint memos: {e}")))?;
        let inner_conds =
            Conditions::new().create_coin(recipient_inner_ph, amount, inner_memos);

        let (issue_cat_conds, cats) =
            Cat::issue_with_coin(&mut ctx, parent_coin_id, amount, inner_conds)
                .map_err(|e| EngineError::Internal(format!("Cat::issue_with_coin: {e}")))?;
        let asset_id = cats[0].info.asset_id;

        // Stack reserve_fee and change onto the issue_cat conditions; they
        // form the XCH parent's spend's conditions in total.
        let mut head_conds = issue_cat_conds;
        if fee > 0 {
            head_conds = head_conds.reserve_fee(fee);
        }
        if change > 0 {
            head_conds = head_conds.create_coin(
                change_ph,
                change,
                ::chia_wallet_sdk::chia::puzzle_types::Memos::None,
            );
        }

        StandardLayer::new(synthetic_pk)
            .spend(&mut ctx, parent_coin, head_conds)
            .map_err(|e| EngineError::Internal(format!("StandardLayer::spend: {e}")))?;

        let coin_spends = ctx.take();
        let constants: &ConsensusConstants = &MAINNET_CONSTANTS;
        let agg_sig_consts = AggSigConstants::new(constants.agg_sig_me_additional_data);
        let required =
            RequiredSignature::from_coin_spends(&mut ctx, &coin_spends, &agg_sig_consts)
                .map_err(|e| EngineError::Internal(format!("required_signatures: {e}")))?;

        let mut aggregated = Signature::default();
        for req_sig in required {
            match req_sig {
                RequiredSignature::Bls(RequiredBlsSignature {
                    public_key,
                    raw_message,
                    appended_info,
                    domain_string,
                }) => {
                    if public_key.to_bytes() != synthetic_pk.to_bytes() {
                        return Err(EngineError::Internal(format!(
                            "unexpected signature for pk {}",
                            hex::encode(public_key.to_bytes())
                        )));
                    }
                    let mut msg = raw_message.to_vec();
                    msg.extend_from_slice(&appended_info);
                    if let Some(domain) = domain_string {
                        msg.extend_from_slice(&domain);
                    }
                    aggregated.aggregate(&sign(&synthetic_sk, &msg));
                }
                RequiredSignature::Secp(_) => {
                    return Err(EngineError::Internal(
                        "SECP signatures not supported in issue_cat".to_string(),
                    ));
                }
            }
        }
        let bundle = SpendBundle::new(coin_spends.clone(), aggregated);

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
            "asset_id": format!("0x{}", hex::encode(asset_id)),
            "status": status,
            "error": error,
            "spend_bundle": {
                "coin_spends": coin_spends.iter().map(serialize_coin_spend).collect::<Vec<_>>(),
                "aggregated_signature": format!("0x{}", hex::encode(bundle.aggregated_signature.to_bytes())),
            },
            "change_mojos": change.to_string(),
        })
        .to_string())
    }

    /// Create a new DID. Launches a singleton from one XCH input coin and
    /// returns the launcher_id (DID id) plus the standard DID coin info.
    ///
    /// Singletons consume 1 mojo for the launcher, so:
    ///   input_amt = 1 (launcher) + fee + change_back
    ///
    /// Recovery list / metadata are NOT exposed today — every DID is created
    /// in "simple" mode (no recovery list, 1 verification required, NIL
    /// metadata). Mirrors `launcher.create_simple_did(...)` upstream.
    ///
    /// Params:
    /// ```
    /// {
    ///   fingerprint: u32,
    ///   fee_mojos?: "0",
    ///   input_coin: { parent_coin_info, puzzle_hash, amount,
    ///                 derivation_index },     // XCH input
    ///   change_index?: u32,
    ///   endpoint?: "mainnet" | "testnet11" | "<url>",
    ///   broadcast?: true
    /// }
    /// ```
    ///
    /// Returns: `{ tx_id, did_id, launcher_id, status, error?, spend_bundle,
    ///             change_mojos }`. `did_id` and `launcher_id` are the same
    /// hex; we expose both names so dApps written against either Sage or
    /// Goby naming work uniformly.
    async fn create_did(&self, params_json: &str) -> Result<String, EngineError> {
        use chia_wallet_sdk::{
            chia::{
                bls::{sign, Signature},
                consensus::consensus_constants::ConsensusConstants,
                protocol::SpendBundle,
            },
            driver::{Launcher, SpendContext, StandardLayer},
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
            #[serde(default = "default_zero_mojos_did")]
            fee_mojos: String,
            input_coin: InputCoin,
            #[serde(default)]
            change_index: u32,
            #[serde(default)]
            endpoint: Option<String>,
            #[serde(default = "default_true_did")]
            broadcast: bool,
        }
        fn default_zero_mojos_did() -> String {
            "0".to_string()
        }
        fn default_true_did() -> bool {
            true
        }

        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;

        let fee: u64 = req
            .fee_mojos
            .parse()
            .map_err(|_| EngineError::InvalidParams("fee_mojos must be u64".to_string()))?;
        let input_amt: u64 = req
            .input_coin
            .amount
            .parse()
            .map_err(|_| EngineError::InvalidParams("input amount must be u64".to_string()))?;
        // Singleton launcher = 1 mojo, fixed by the puzzle.
        const LAUNCHER_AMOUNT: u64 = 1;
        let needed = LAUNCHER_AMOUNT
            .checked_add(fee)
            .ok_or_else(|| EngineError::InvalidParams("launcher + fee overflow".to_string()))?;
        if input_amt < needed {
            return Err(EngineError::InvalidParams(format!(
                "input coin {input_amt} mojos < {needed} (1 mojo launcher + fee)"
            )));
        }
        let change = input_amt - needed;

        let parent = parse_bytes32(&req.input_coin.parent_coin_info)?;
        let parent_ph = parse_bytes32(&req.input_coin.puzzle_hash)?;
        let parent_coin = Coin::new(parent, parent_ph, input_amt);
        let parent_coin_id = parent_coin.coin_id();

        let master_sk = self.unlocked_sk(req.fingerprint)?;
        let intermediate =
            master_to_wallet_unhardened(&master_sk, req.input_coin.derivation_index);
        let synthetic_sk = intermediate.derive_synthetic();
        let synthetic_pk = synthetic_sk.public_key();
        let derived_ph: Bytes32 = StandardArgs::curry_tree_hash(synthetic_pk).into();
        if derived_ph != parent_ph {
            return Err(EngineError::InvalidParams(format!(
                "input_coin puzzle_hash {} doesn't match derivation_index {}",
                hex::encode(parent_ph),
                req.input_coin.derivation_index,
            )));
        }

        let change_intermediate_sk = master_to_wallet_unhardened(&master_sk, req.change_index);
        let change_synthetic_pk = change_intermediate_sk.derive_synthetic().public_key();
        let change_ph: Bytes32 = StandardArgs::curry_tree_hash(change_synthetic_pk).into();

        let mut ctx = SpendContext::new();

        // Build the launcher spend + DID eve, owned by the wallet's own p2.
        let standard_layer = StandardLayer::new(synthetic_pk);
        let launcher = Launcher::new(parent_coin_id, LAUNCHER_AMOUNT);
        let (create_did_conds, did) = launcher
            .create_simple_did(&mut ctx, &standard_layer)
            .map_err(|e| EngineError::Internal(format!("Launcher::create_simple_did: {e}")))?;
        let launcher_id = did.info.launcher_id;

        // XCH parent's conditions: emit the launcher CREATE_COIN (inside
        // create_did_conds), reserve fee, return change.
        let mut head_conds = create_did_conds;
        if fee > 0 {
            head_conds = head_conds.reserve_fee(fee);
        }
        if change > 0 {
            head_conds = head_conds.create_coin(
                change_ph,
                change,
                ::chia_wallet_sdk::chia::puzzle_types::Memos::None,
            );
        }

        standard_layer
            .spend(&mut ctx, parent_coin, head_conds)
            .map_err(|e| EngineError::Internal(format!("StandardLayer::spend: {e}")))?;

        let coin_spends = ctx.take();
        let constants: &ConsensusConstants = &MAINNET_CONSTANTS;
        let agg_sig_consts = AggSigConstants::new(constants.agg_sig_me_additional_data);
        let required =
            RequiredSignature::from_coin_spends(&mut ctx, &coin_spends, &agg_sig_consts)
                .map_err(|e| EngineError::Internal(format!("required_signatures: {e}")))?;

        let mut aggregated = Signature::default();
        for req_sig in required {
            match req_sig {
                RequiredSignature::Bls(RequiredBlsSignature {
                    public_key,
                    raw_message,
                    appended_info,
                    domain_string,
                }) => {
                    if public_key.to_bytes() != synthetic_pk.to_bytes() {
                        return Err(EngineError::Internal(format!(
                            "unexpected signature for pk {}",
                            hex::encode(public_key.to_bytes())
                        )));
                    }
                    let mut msg = raw_message.to_vec();
                    msg.extend_from_slice(&appended_info);
                    if let Some(domain) = domain_string {
                        msg.extend_from_slice(&domain);
                    }
                    aggregated.aggregate(&sign(&synthetic_sk, &msg));
                }
                RequiredSignature::Secp(_) => {
                    return Err(EngineError::Internal(
                        "SECP signatures not supported in create_did".to_string(),
                    ));
                }
            }
        }
        let bundle = SpendBundle::new(coin_spends.clone(), aggregated);

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
            "did_id": format!("0x{}", hex::encode(launcher_id)),
            "launcher_id": format!("0x{}", hex::encode(launcher_id)),
            "status": status,
            "error": error,
            "spend_bundle": {
                "coin_spends": coin_spends.iter().map(serialize_coin_spend).collect::<Vec<_>>(),
                "aggregated_signature": format!("0x{}", hex::encode(bundle.aggregated_signature.to_bytes())),
            },
            "change_mojos": change.to_string(),
        })
        .to_string())
    }

    /// Transfer a DID singleton to a new owner.
    ///
    /// Caller passes the CURRENT unspent DID head coin id + the wallet's
    /// derivation_index that owns its p2 puzzle. We refetch the parent
    /// spend, reconstruct the `Did` via `Did::parse_child`, and emit a
    /// transfer to the recipient's p2 puzzle hash.
    ///
    /// Optional XCH fee via `fee_input_coins` mirrors transfer_nft exactly.
    ///
    /// Params:
    /// ```
    /// {
    ///   fingerprint: u32,
    ///   did_coin_id: "0x...",                // current unspent DID head
    ///   did_derivation_index: u32,           // OUR index that owns the DID
    ///   recipient_address: "xch1...",        // new p2 owner
    ///   fee_mojos?: "0",
    ///   fee_input_coins?: [{ parent_coin_info, puzzle_hash, amount,
    ///                        derivation_index }],
    ///   fee_change_index?: u32,
    ///   endpoint?: "mainnet" | "testnet11" | "<url>",
    ///   broadcast?: bool (default true),
    /// }
    /// ```
    ///
    /// Returns: `{ tx_id, launcher_id, status, error?, spend_bundle }`.
    async fn transfer_did(&self, params_json: &str) -> Result<String, EngineError> {
        use chia_wallet_sdk::{
            chia::{
                bls::{sign, Signature},
                consensus::consensus_constants::ConsensusConstants,
                protocol::SpendBundle,
            },
            clvmr::serde::node_from_bytes,
            driver::{Did, Puzzle, SpendContext, StandardLayer},
            signer::{AggSigConstants, RequiredBlsSignature, RequiredSignature},
            types::MAINNET_CONSTANTS,
        };

        #[derive(Deserialize)]
        struct FeeCoinJson {
            parent_coin_info: String,
            puzzle_hash: String,
            amount: String,
            derivation_index: u32,
        }
        #[derive(Deserialize)]
        struct Req {
            fingerprint: u32,
            did_coin_id: String,
            did_derivation_index: u32,
            recipient_address: String,
            #[serde(default = "default_zero_mojos_xferdid")]
            fee_mojos: String,
            #[serde(default)]
            fee_input_coins: Vec<FeeCoinJson>,
            #[serde(default)]
            fee_change_index: Option<u32>,
            #[serde(default)]
            endpoint: Option<String>,
            #[serde(default = "default_true_xferdid")]
            broadcast: bool,
        }
        fn default_zero_mojos_xferdid() -> String {
            "0".to_string()
        }
        fn default_true_xferdid() -> bool {
            true
        }

        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;

        let fee: u64 = req
            .fee_mojos
            .parse()
            .map_err(|_| EngineError::InvalidParams("fee_mojos u64".to_string()))?;
        if fee > 0 && req.fee_input_coins.is_empty() {
            return Err(EngineError::InvalidParams(
                "fee_input_coins required when fee_mojos > 0".to_string(),
            ));
        }

        let did_coin_id = parse_bytes32(&req.did_coin_id)?;
        let recipient = Address::decode(req.recipient_address.trim())
            .map_err(|e| EngineError::InvalidParams(format!("recipient: {e}")))?;
        let recipient_ph = recipient.puzzle_hash;

        let master_sk = self.unlocked_sk(req.fingerprint)?;
        let did_intermediate = master_to_wallet_unhardened(&master_sk, req.did_derivation_index);
        let did_synthetic_sk = did_intermediate.derive_synthetic();
        let did_synthetic_pk = did_synthetic_sk.public_key();
        let did_owner_ph: Bytes32 = StandardArgs::curry_tree_hash(did_synthetic_pk).into();

        // Refetch DID head + parent, parse_child.
        let client = make_client(req.endpoint.as_deref());
        let did_rec = client
            .get_coin_record_by_name(did_coin_id)
            .await
            .map_err(|e| EngineError::Internal(format!("did coin lookup: {e}")))?
            .coin_record
            .ok_or_else(|| {
                EngineError::InvalidParams(format!(
                    "did_coin_id {} not found on chain",
                    hex::encode(did_coin_id)
                ))
            })?;
        if did_rec.spent {
            return Err(EngineError::InvalidParams(format!(
                "did_coin_id {} is already spent — pass the current unspent head",
                hex::encode(did_coin_id)
            )));
        }
        let did_coin = did_rec.coin;

        let parent_rec = client
            .get_coin_record_by_name(did_coin.parent_coin_info)
            .await
            .map_err(|e| EngineError::Internal(format!("did parent lookup: {e}")))?
            .coin_record
            .ok_or_else(|| {
                EngineError::Internal(format!(
                    "did parent {} not found on chain",
                    hex::encode(did_coin.parent_coin_info)
                ))
            })?;
        if !parent_rec.spent {
            return Err(EngineError::Internal(
                "did parent coin not spent — singleton chain broken?".to_string(),
            ));
        }
        let parent_spend = client
            .get_puzzle_and_solution(
                did_coin.parent_coin_info,
                Some(parent_rec.spent_block_index),
            )
            .await
            .map_err(|e| EngineError::Internal(format!("did parent spend: {e}")))?
            .coin_solution
            .ok_or_else(|| EngineError::Internal("missing did parent solution".to_string()))?;

        let mut ctx = SpendContext::new();
        let parent_puzzle_ptr = node_from_bytes(&mut *ctx, parent_spend.puzzle_reveal.as_ref())
            .map_err(|e| EngineError::Internal(format!("did parent puzzle parse: {e}")))?;
        let parent_solution_ptr = node_from_bytes(&mut *ctx, parent_spend.solution.as_ref())
            .map_err(|e| EngineError::Internal(format!("did parent solution parse: {e}")))?;
        let parent_puzzle = Puzzle::parse(&ctx, parent_puzzle_ptr);

        let did: Did = Did::parse_child(
            &mut *ctx,
            parent_spend.coin,
            parent_puzzle,
            parent_solution_ptr,
            did_coin,
        )
        .map_err(|e| EngineError::Internal(format!("Did::parse_child: {e}")))?
        .ok_or_else(|| {
            EngineError::Internal(
                "did parent didn't produce a parseable DID child".to_string(),
            )
        })?;

        if did.info.p2_puzzle_hash != did_owner_ph {
            return Err(EngineError::InvalidParams(format!(
                "did_derivation_index {} doesn't own DID p2_puzzle_hash {} (derived {})",
                req.did_derivation_index,
                hex::encode(did.info.p2_puzzle_hash),
                hex::encode(did_owner_ph)
            )));
        }
        let launcher_id = did.info.launcher_id;

        // Transfer the DID to the recipient's p2 inner.
        let standard_layer = StandardLayer::new(did_synthetic_pk);
        let _new_did = did
            .transfer(&mut ctx, &standard_layer, recipient_ph, Conditions::new())
            .map_err(|e| EngineError::Internal(format!("Did::transfer: {e}")))?;

        // Pay the optional XCH fee (same flow as transfer_nft).
        struct FeeKey {
            sk: SecretKey,
            pk: PublicKey,
        }
        let mut fee_keys: Vec<FeeKey> = Vec::new();
        if fee > 0 {
            let total_in: u64 = req.fee_input_coins.iter().try_fold(0u64, |acc, c| {
                let amt: u64 = c
                    .amount
                    .parse()
                    .map_err(|_| EngineError::InvalidParams("fee coin amount u64".to_string()))?;
                acc.checked_add(amt)
                    .ok_or_else(|| EngineError::InvalidParams("fee sum overflow".to_string()))
            })?;
            if total_in < fee {
                return Err(EngineError::InvalidParams(format!(
                    "fee_input_coins sum {total_in} < fee {fee}"
                )));
            }
            let change_index = req.fee_change_index.unwrap_or(req.did_derivation_index);
            let change_intermediate = master_to_wallet_unhardened(&master_sk, change_index);
            let change_pk = change_intermediate.derive_synthetic().public_key();
            let change_ph: Bytes32 = StandardArgs::curry_tree_hash(change_pk).into();
            let change = total_in - fee;

            for (i, c) in req.fee_input_coins.iter().enumerate() {
                let parent = parse_bytes32(&c.parent_coin_info)?;
                let outer_ph = parse_bytes32(&c.puzzle_hash)?;
                let amt: u64 = c.amount.parse().unwrap();
                let coin = Coin::new(parent, outer_ph, amt);

                let fee_intermediate = master_to_wallet_unhardened(&master_sk, c.derivation_index);
                let fee_synthetic = fee_intermediate.derive_synthetic();
                let fee_pk = fee_synthetic.public_key();
                let derived_ph: Bytes32 = StandardArgs::curry_tree_hash(fee_pk).into();
                if derived_ph != outer_ph {
                    return Err(EngineError::InvalidParams(format!(
                        "fee_input_coins[{i}] puzzle_hash doesn't match derivation_index"
                    )));
                }

                let conditions = if i == 0 {
                    let mut c = Conditions::new().reserve_fee(fee);
                    if change > 0 {
                        c = c.create_coin(change_ph, change, ctx.hint(change_ph).unwrap());
                    }
                    c
                } else {
                    Conditions::new()
                };
                let p2_spend = StandardLayer::new(fee_pk)
                    .spend_with_conditions(&mut ctx, conditions)
                    .map_err(|e| EngineError::Internal(format!("fee p2 spend: {e}")))?;
                ctx.spend(coin, p2_spend)
                    .map_err(|e| EngineError::Internal(format!("fee spend: {e}")))?;
                fee_keys.push(FeeKey {
                    sk: fee_synthetic,
                    pk: fee_pk,
                });
            }
        }

        let coin_spends = ctx.take();
        let constants: &ConsensusConstants = &MAINNET_CONSTANTS;
        let agg_sig_consts = AggSigConstants::new(constants.agg_sig_me_additional_data);
        let required = RequiredSignature::from_coin_spends(
            &mut ctx,
            &coin_spends,
            &agg_sig_consts,
        )
        .map_err(|e| EngineError::Internal(format!("required_signatures: {e}")))?;

        let mut sks_by_pk: std::collections::HashMap<Vec<u8>, SecretKey> =
            std::collections::HashMap::new();
        sks_by_pk.insert(did_synthetic_pk.to_bytes().to_vec(), did_synthetic_sk.clone());
        for k in &fee_keys {
            sks_by_pk.insert(k.pk.to_bytes().to_vec(), k.sk.clone());
        }

        let mut aggregated = Signature::default();
        for r in required {
            match r {
                RequiredSignature::Bls(RequiredBlsSignature {
                    public_key,
                    raw_message,
                    appended_info,
                    domain_string,
                }) => {
                    let pk_bytes = public_key.to_bytes().to_vec();
                    let sk = sks_by_pk.get(&pk_bytes).ok_or_else(|| {
                        EngineError::Internal(format!(
                            "no secret key for pubkey {}",
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
                        "SECP not supported in transfer_did".to_string(),
                    ));
                }
            }
        }

        let bundle = SpendBundle::new(coin_spends.clone(), aggregated);
        let tx_id = bundle.name();

        let mut status = "DRY_RUN".to_string();
        let mut error: Option<String> = None;
        if req.broadcast {
            let res = client
                .push_tx(bundle.clone())
                .await
                .map_err(|e| EngineError::Internal(format!("push_tx: {e}")))?;
            status = res.status;
            error = res.error;
        }

        Ok(serde_json::json!({
            "tx_id": format!("0x{}", hex::encode(tx_id)),
            "launcher_id": format!("0x{}", hex::encode(launcher_id)),
            "status": status,
            "error": error,
            "spend_bundle": {
                "coin_spends": coin_spends.iter().map(serialize_coin_spend).collect::<Vec<_>>(),
                "aggregated_signature": format!("0x{}", hex::encode(bundle.aggregated_signature.to_bytes())),
            },
            "recipient_puzzle_hash": format!("0x{}", hex::encode(recipient_ph)),
        })
        .to_string())
    }

    /// Normalize a DID: re-spend it to itself with recovery_list_hash and
    /// num_verifications_required reset to the "simple-DID" defaults
    ///   recovery_list_hash = Some(tree_hash_atom(&[]))   // empty-list hash
    ///   num_verifications_required = 1
    /// Metadata is left untouched. Owner stays the same.
    ///
    /// Mirrors upstream `Wallet::normalize_dids` but operates on one DID at
    /// a time — dApps can call it in a loop if they need bulk normalization.
    ///
    /// Same DID resolution flow as `transfer_did` (parent re-fetch +
    /// Did::parse_child). Optional XCH fee via fee_input_coins.
    ///
    /// Params:
    /// ```
    /// {
    ///   fingerprint: u32,
    ///   did_coin_id: "0x...",
    ///   did_derivation_index: u32,
    ///   fee_mojos?: "0",
    ///   fee_input_coins?: [{ parent_coin_info, puzzle_hash, amount,
    ///                        derivation_index }],
    ///   fee_change_index?: u32,
    ///   endpoint?: "mainnet" | "testnet11" | "<url>",
    ///   broadcast?: bool (default true),
    /// }
    /// ```
    async fn normalize_did(&self, params_json: &str) -> Result<String, EngineError> {
        use chia_wallet_sdk::{
            chia::{
                bls::{sign, Signature},
                consensus::consensus_constants::ConsensusConstants,
                protocol::SpendBundle,
                puzzle_types::singleton::SingletonStruct,
            },
            clvm_utils::{tree_hash_atom, TreeHash},
            clvmr::serde::node_from_bytes,
            driver::{Did, DidInfo, Puzzle, SpendContext, StandardLayer, SpendWithConditions},
            signer::{AggSigConstants, RequiredBlsSignature, RequiredSignature},
            types::MAINNET_CONSTANTS,
        };

        #[derive(Deserialize)]
        struct FeeCoinJson {
            parent_coin_info: String,
            puzzle_hash: String,
            amount: String,
            derivation_index: u32,
        }
        #[derive(Deserialize)]
        struct Req {
            fingerprint: u32,
            did_coin_id: String,
            did_derivation_index: u32,
            #[serde(default = "default_zero_mojos_norm")]
            fee_mojos: String,
            #[serde(default)]
            fee_input_coins: Vec<FeeCoinJson>,
            #[serde(default)]
            fee_change_index: Option<u32>,
            #[serde(default)]
            endpoint: Option<String>,
            #[serde(default = "default_true_norm")]
            broadcast: bool,
        }
        fn default_zero_mojos_norm() -> String {
            "0".to_string()
        }
        fn default_true_norm() -> bool {
            true
        }

        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;

        let fee: u64 = req
            .fee_mojos
            .parse()
            .map_err(|_| EngineError::InvalidParams("fee_mojos u64".to_string()))?;
        if fee > 0 && req.fee_input_coins.is_empty() {
            return Err(EngineError::InvalidParams(
                "fee_input_coins required when fee_mojos > 0".to_string(),
            ));
        }

        let did_coin_id = parse_bytes32(&req.did_coin_id)?;

        let master_sk = self.unlocked_sk(req.fingerprint)?;
        let did_intermediate = master_to_wallet_unhardened(&master_sk, req.did_derivation_index);
        let did_synthetic_sk = did_intermediate.derive_synthetic();
        let did_synthetic_pk = did_synthetic_sk.public_key();
        let did_owner_ph: Bytes32 = StandardArgs::curry_tree_hash(did_synthetic_pk).into();

        let client = make_client(req.endpoint.as_deref());
        let did_rec = client
            .get_coin_record_by_name(did_coin_id)
            .await
            .map_err(|e| EngineError::Internal(format!("did coin lookup: {e}")))?
            .coin_record
            .ok_or_else(|| {
                EngineError::InvalidParams(format!(
                    "did_coin_id {} not found on chain",
                    hex::encode(did_coin_id)
                ))
            })?;
        if did_rec.spent {
            return Err(EngineError::InvalidParams(format!(
                "did_coin_id {} is already spent — pass the current unspent head",
                hex::encode(did_coin_id)
            )));
        }
        let did_coin = did_rec.coin;

        let parent_rec = client
            .get_coin_record_by_name(did_coin.parent_coin_info)
            .await
            .map_err(|e| EngineError::Internal(format!("did parent lookup: {e}")))?
            .coin_record
            .ok_or_else(|| {
                EngineError::Internal(format!(
                    "did parent {} not found on chain",
                    hex::encode(did_coin.parent_coin_info)
                ))
            })?;
        if !parent_rec.spent {
            return Err(EngineError::Internal(
                "did parent coin not spent — singleton chain broken?".to_string(),
            ));
        }
        let parent_spend = client
            .get_puzzle_and_solution(
                did_coin.parent_coin_info,
                Some(parent_rec.spent_block_index),
            )
            .await
            .map_err(|e| EngineError::Internal(format!("did parent spend: {e}")))?
            .coin_solution
            .ok_or_else(|| EngineError::Internal("missing did parent solution".to_string()))?;

        let mut ctx = SpendContext::new();
        let parent_puzzle_ptr = node_from_bytes(&mut *ctx, parent_spend.puzzle_reveal.as_ref())
            .map_err(|e| EngineError::Internal(format!("did parent puzzle parse: {e}")))?;
        let parent_solution_ptr = node_from_bytes(&mut *ctx, parent_spend.solution.as_ref())
            .map_err(|e| EngineError::Internal(format!("did parent solution parse: {e}")))?;
        let parent_puzzle = Puzzle::parse(&ctx, parent_puzzle_ptr);

        let did: Did = Did::parse_child(
            &mut *ctx,
            parent_spend.coin,
            parent_puzzle,
            parent_solution_ptr,
            did_coin,
        )
        .map_err(|e| EngineError::Internal(format!("Did::parse_child: {e}")))?
        .ok_or_else(|| {
            EngineError::Internal(
                "did parent didn't produce a parseable DID child".to_string(),
            )
        })?;

        if did.info.p2_puzzle_hash != did_owner_ph {
            return Err(EngineError::InvalidParams(format!(
                "did_derivation_index {} doesn't own DID p2_puzzle_hash {} (derived {})",
                req.did_derivation_index,
                hex::encode(did.info.p2_puzzle_hash),
                hex::encode(did_owner_ph)
            )));
        }
        let launcher_id = did.info.launcher_id;

        // Build a "normalized" DidInfo: empty-list recovery hash + 1
        // verification required. Metadata and p2 stay the same.
        let empty_list_hash: Bytes32 = Bytes32::from(<TreeHash>::from(tree_hash_atom(&[])));
        let normalized_info = DidInfo {
            recovery_list_hash: Some(empty_list_hash),
            num_verifications_required: 1,
            ..did.info
        };

        // Re-spend the DID with a CREATE_COIN to the normalized inner_puzzle_hash.
        // Use the same hint (p2_puzzle_hash) so the wallet can still find it.
        let memos = ctx
            .hint(did.info.p2_puzzle_hash)
            .map_err(|e| EngineError::Internal(format!("ctx.hint: {e}")))?;
        let new_inner_ph: Bytes32 = normalized_info.inner_puzzle_hash().into();
        let inner_conds =
            Conditions::new().create_coin(new_inner_ph, did_coin.amount, memos);

        let standard_layer = StandardLayer::new(did_synthetic_pk);
        let inner_spend = standard_layer
            .spend_with_conditions(&mut ctx, inner_conds)
            .map_err(|e| EngineError::Internal(format!("inner_spend: {e}")))?;
        did.spend(&mut ctx, inner_spend)
            .map_err(|e| EngineError::Internal(format!("did.spend: {e}")))?;

        // Silence unused-import lints if singleton struct isn't used elsewhere.
        let _ = SingletonStruct::new(launcher_id);

        // Pay the optional XCH fee (identical block to transfer_did).
        struct FeeKey {
            sk: SecretKey,
            pk: PublicKey,
        }
        let mut fee_keys: Vec<FeeKey> = Vec::new();
        if fee > 0 {
            let total_in: u64 = req.fee_input_coins.iter().try_fold(0u64, |acc, c| {
                let amt: u64 = c
                    .amount
                    .parse()
                    .map_err(|_| EngineError::InvalidParams("fee coin amount u64".to_string()))?;
                acc.checked_add(amt)
                    .ok_or_else(|| EngineError::InvalidParams("fee sum overflow".to_string()))
            })?;
            if total_in < fee {
                return Err(EngineError::InvalidParams(format!(
                    "fee_input_coins sum {total_in} < fee {fee}"
                )));
            }
            let change_index = req.fee_change_index.unwrap_or(req.did_derivation_index);
            let change_intermediate = master_to_wallet_unhardened(&master_sk, change_index);
            let change_pk = change_intermediate.derive_synthetic().public_key();
            let change_ph: Bytes32 = StandardArgs::curry_tree_hash(change_pk).into();
            let change = total_in - fee;

            for (i, c) in req.fee_input_coins.iter().enumerate() {
                let parent = parse_bytes32(&c.parent_coin_info)?;
                let outer_ph = parse_bytes32(&c.puzzle_hash)?;
                let amt: u64 = c.amount.parse().unwrap();
                let coin = Coin::new(parent, outer_ph, amt);

                let fee_intermediate = master_to_wallet_unhardened(&master_sk, c.derivation_index);
                let fee_synthetic = fee_intermediate.derive_synthetic();
                let fee_pk = fee_synthetic.public_key();
                let derived_ph: Bytes32 = StandardArgs::curry_tree_hash(fee_pk).into();
                if derived_ph != outer_ph {
                    return Err(EngineError::InvalidParams(format!(
                        "fee_input_coins[{i}] puzzle_hash doesn't match derivation_index"
                    )));
                }

                let conditions = if i == 0 {
                    let mut c = Conditions::new().reserve_fee(fee);
                    if change > 0 {
                        c = c.create_coin(change_ph, change, ctx.hint(change_ph).unwrap());
                    }
                    c
                } else {
                    Conditions::new()
                };
                let p2_spend = StandardLayer::new(fee_pk)
                    .spend_with_conditions(&mut ctx, conditions)
                    .map_err(|e| EngineError::Internal(format!("fee p2 spend: {e}")))?;
                ctx.spend(coin, p2_spend)
                    .map_err(|e| EngineError::Internal(format!("fee spend: {e}")))?;
                fee_keys.push(FeeKey {
                    sk: fee_synthetic,
                    pk: fee_pk,
                });
            }
        }

        let coin_spends = ctx.take();
        let constants: &ConsensusConstants = &MAINNET_CONSTANTS;
        let agg_sig_consts = AggSigConstants::new(constants.agg_sig_me_additional_data);
        let required = RequiredSignature::from_coin_spends(
            &mut ctx,
            &coin_spends,
            &agg_sig_consts,
        )
        .map_err(|e| EngineError::Internal(format!("required_signatures: {e}")))?;

        let mut sks_by_pk: std::collections::HashMap<Vec<u8>, SecretKey> =
            std::collections::HashMap::new();
        sks_by_pk.insert(did_synthetic_pk.to_bytes().to_vec(), did_synthetic_sk.clone());
        for k in &fee_keys {
            sks_by_pk.insert(k.pk.to_bytes().to_vec(), k.sk.clone());
        }

        let mut aggregated = Signature::default();
        for r in required {
            match r {
                RequiredSignature::Bls(RequiredBlsSignature {
                    public_key,
                    raw_message,
                    appended_info,
                    domain_string,
                }) => {
                    let pk_bytes = public_key.to_bytes().to_vec();
                    let sk = sks_by_pk.get(&pk_bytes).ok_or_else(|| {
                        EngineError::Internal(format!(
                            "no secret key for pubkey {}",
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
                        "SECP not supported in normalize_did".to_string(),
                    ));
                }
            }
        }

        let bundle = SpendBundle::new(coin_spends.clone(), aggregated);
        let tx_id = bundle.name();

        let mut status = "DRY_RUN".to_string();
        let mut error: Option<String> = None;
        if req.broadcast {
            let res = client
                .push_tx(bundle.clone())
                .await
                .map_err(|e| EngineError::Internal(format!("push_tx: {e}")))?;
            status = res.status;
            error = res.error;
        }

        Ok(serde_json::json!({
            "tx_id": format!("0x{}", hex::encode(tx_id)),
            "launcher_id": format!("0x{}", hex::encode(launcher_id)),
            "status": status,
            "error": error,
            "spend_bundle": {
                "coin_spends": coin_spends.iter().map(serialize_coin_spend).collect::<Vec<_>>(),
                "aggregated_signature": format!("0x{}", hex::encode(bundle.aggregated_signature.to_bytes())),
            },
            "normalized": {
                "recovery_list_hash": format!("0x{}", hex::encode(empty_list_hash)),
                "num_verifications_required": 1,
            },
        })
        .to_string())
    }

    /// Transfer an NFT to a new owner.
    ///
    /// We re-fetch the parent spend from coinset and reconstruct the `Nft`
    /// via `Nft::parse_child` — that's the authoritative source for the
    /// `Proof` / `NftInfo` (which we don't persist in the JS-side snapshot).
    ///
    /// Optional XCH fee: pass `fee_input_coins[]` in the same shape as
    /// `send_xch.input_coins`. If `fee_mojos == 0`, omit them.
    ///
    /// Params:
    /// ```
    /// {
    ///   fingerprint: u32,
    ///   coin_id: "0x...",
    ///   parent_coin_info: "0x...",
    ///   recipient_address: "xch1...",
    ///   derivation_index: u32,             // OUR index holding the NFT
    ///   fee_mojos?: "0",
    ///   fee_input_coins?: [{ parent_coin_info, puzzle_hash, amount,
    ///                        derivation_index }],
    ///   fee_change_index?: u32,
    ///   endpoint?: "mainnet" | "testnet11" | "<url>",
    ///   broadcast?: bool (default true),
    /// }
    /// ```
    async fn transfer_nft(&self, params_json: &str) -> Result<String, EngineError> {
        use chia_wallet_sdk::{
            chia::{
                bls::{sign, Signature},
                consensus::consensus_constants::ConsensusConstants,
                protocol::SpendBundle,
            },
            clvmr::serde::node_from_bytes,
            driver::{Nft, Puzzle, SpendContext, StandardLayer},
            signer::{AggSigConstants, RequiredBlsSignature, RequiredSignature},
            types::MAINNET_CONSTANTS,
        };

        #[derive(Deserialize)]
        struct FeeCoinJson {
            parent_coin_info: String,
            puzzle_hash: String,
            amount: String,
            derivation_index: u32,
        }
        #[derive(Deserialize)]
        struct Req {
            fingerprint: u32,
            coin_id: String,
            #[serde(default)]
            parent_coin_info: Option<String>,
            recipient_address: String,
            derivation_index: u32,
            #[serde(default = "default_zero_mojos_nft")]
            fee_mojos: String,
            #[serde(default)]
            fee_input_coins: Vec<FeeCoinJson>,
            #[serde(default)]
            fee_change_index: Option<u32>,
            #[serde(default)]
            endpoint: Option<String>,
            #[serde(default = "default_true_nft")]
            broadcast: bool,
        }
        fn default_zero_mojos_nft() -> String {
            "0".to_string()
        }
        fn default_true_nft() -> bool {
            true
        }

        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;

        let fee: u64 = req
            .fee_mojos
            .parse()
            .map_err(|_| EngineError::InvalidParams("fee_mojos u64".to_string()))?;
        if fee > 0 && req.fee_input_coins.is_empty() {
            return Err(EngineError::InvalidParams(
                "fee_input_coins required when fee_mojos > 0".to_string(),
            ));
        }

        let coin_id = parse_bytes32(&req.coin_id)?;
        let recipient = Address::decode(req.recipient_address.trim())
            .map_err(|e| EngineError::InvalidParams(format!("recipient: {e}")))?;
        let recipient_ph = recipient.puzzle_hash;

        // 1. Resolve the NFT's parent_coin_info, either from req or by
        //    looking up the coin record on-chain.
        let client = make_client(req.endpoint.as_deref());
        let parent_id: Bytes32 = match req.parent_coin_info.as_deref() {
            Some(s) => parse_bytes32(s)?,
            None => {
                let rec = client
                    .get_coin_record_by_name(coin_id)
                    .await
                    .map_err(|e| EngineError::Internal(format!("coin lookup: {e}")))?
                    .coin_record
                    .ok_or_else(|| {
                        EngineError::InvalidParams(format!(
                            "coin {} not found",
                            hex::encode(coin_id)
                        ))
                    })?;
                rec.coin.parent_coin_info
            }
        };

        // 2. Fetch the parent's spend to reconstruct the Nft via parse_child.
        let parent_rec = client
            .get_coin_record_by_name(parent_id)
            .await
            .map_err(|e| EngineError::Internal(format!("parent lookup: {e}")))?
            .coin_record
            .ok_or_else(|| {
                EngineError::InvalidParams(format!(
                    "parent coin {} not found",
                    hex::encode(parent_id)
                ))
            })?;
        if !parent_rec.spent {
            return Err(EngineError::InvalidParams(
                "parent coin not spent — NFT not yet on chain?".to_string(),
            ));
        }
        let parent_spend_res = client
            .get_puzzle_and_solution(parent_id, Some(parent_rec.spent_block_index))
            .await
            .map_err(|e| EngineError::Internal(format!("parent spend: {e}")))?;
        let parent_spend = parent_spend_res
            .coin_solution
            .ok_or_else(|| EngineError::Internal("missing parent coin solution".to_string()))?;

        let mut ctx = SpendContext::new();
        let parent_puzzle_ptr = node_from_bytes(&mut *ctx, parent_spend.puzzle_reveal.as_ref())
            .map_err(|e| EngineError::Internal(format!("parent puzzle parse: {e}")))?;
        let parent_solution_ptr = node_from_bytes(&mut *ctx, parent_spend.solution.as_ref())
            .map_err(|e| EngineError::Internal(format!("parent solution parse: {e}")))?;
        let parent_puzzle = Puzzle::parse(&ctx, parent_puzzle_ptr);

        let nft = Nft::parse_child(
            &mut *ctx,
            parent_spend.coin,
            parent_puzzle,
            parent_solution_ptr,
        )
        .map_err(|e| EngineError::Internal(format!("Nft::parse_child: {e}")))?
        .ok_or_else(|| {
            EngineError::Internal(
                "parent didn't produce a parseable NFT child".to_string(),
            )
        })?;

        if nft.coin.coin_id() != coin_id {
            return Err(EngineError::Internal(format!(
                "parent's NFT child coin {} != requested {}",
                hex::encode(nft.coin.coin_id()),
                hex::encode(coin_id)
            )));
        }

        // 3. Verify we own the NFT's p2 inner puzzle.
        let master_sk = self.unlocked_sk(req.fingerprint)?;
        let our_intermediate = master_to_wallet_unhardened(&master_sk, req.derivation_index);
        let our_synthetic = our_intermediate.derive_synthetic();
        let our_pk = our_synthetic.public_key();
        let our_inner_ph: Bytes32 = StandardArgs::curry_tree_hash(our_pk).into();
        if our_inner_ph != nft.info.p2_puzzle_hash {
            return Err(EngineError::InvalidParams(format!(
                "derivation_index {} doesn't match NFT's p2_puzzle_hash {}",
                req.derivation_index,
                hex::encode(nft.info.p2_puzzle_hash)
            )));
        }

        // 4. Build the inner spend that transfers + return the StandardLayer
        //    to be used as the inner layer of Nft::transfer.
        let standard_layer = StandardLayer::new(our_pk);
        let extra_conditions = Conditions::new();
        let _new_nft = nft
            .transfer(&mut ctx, &standard_layer, recipient_ph, extra_conditions)
            .map_err(|e| EngineError::Internal(format!("Nft::transfer: {e}")))?;

        // 5. Pay the optional XCH fee.
        struct FeeKey {
            sk: SecretKey,
            pk: PublicKey,
        }
        let mut fee_keys: Vec<FeeKey> = Vec::new();
        if fee > 0 {
            let total_in: u64 = req.fee_input_coins.iter().try_fold(0u64, |acc, c| {
                let amt: u64 = c
                    .amount
                    .parse()
                    .map_err(|_| EngineError::InvalidParams("fee coin amount u64".to_string()))?;
                acc.checked_add(amt)
                    .ok_or_else(|| EngineError::InvalidParams("fee sum overflow".to_string()))
            })?;
            if total_in < fee {
                return Err(EngineError::InvalidParams(format!(
                    "fee_input_coins sum {total_in} < fee {fee}"
                )));
            }
            let change_index = req.fee_change_index.unwrap_or(req.derivation_index);
            let change_intermediate = master_to_wallet_unhardened(&master_sk, change_index);
            let change_pk = change_intermediate.derive_synthetic().public_key();
            let change_ph: Bytes32 = StandardArgs::curry_tree_hash(change_pk).into();
            let change = total_in - fee;

            for (i, c) in req.fee_input_coins.iter().enumerate() {
                let parent = parse_bytes32(&c.parent_coin_info)?;
                let outer_ph = parse_bytes32(&c.puzzle_hash)?;
                let amt: u64 = c.amount.parse().unwrap();
                let coin = Coin::new(parent, outer_ph, amt);

                let fee_intermediate = master_to_wallet_unhardened(&master_sk, c.derivation_index);
                let fee_synthetic = fee_intermediate.derive_synthetic();
                let fee_pk = fee_synthetic.public_key();
                let derived_ph: Bytes32 = StandardArgs::curry_tree_hash(fee_pk).into();
                if derived_ph != outer_ph {
                    return Err(EngineError::InvalidParams(format!(
                        "fee_input_coins[{i}] puzzle_hash doesn't match derivation_index"
                    )));
                }

                let conditions = if i == 0 {
                    let mut c = Conditions::new().reserve_fee(fee);
                    if change > 0 {
                        c = c.create_coin(change_ph, change, ctx.hint(change_ph).unwrap());
                    }
                    c
                } else {
                    Conditions::new()
                };
                let p2_spend = StandardLayer::new(fee_pk)
                    .spend_with_conditions(&mut ctx, conditions)
                    .map_err(|e| {
                        EngineError::Internal(format!("fee p2 spend: {e}"))
                    })?;
                ctx.spend(coin, p2_spend)
                    .map_err(|e| EngineError::Internal(format!("fee spend: {e}")))?;
                fee_keys.push(FeeKey {
                    sk: fee_synthetic,
                    pk: fee_pk,
                });
            }
        }

        let coin_spends = ctx.take();

        // 6. Sign required AGG_SIGs.
        let constants: &ConsensusConstants = &MAINNET_CONSTANTS;
        let agg_sig_consts = AggSigConstants::new(constants.agg_sig_me_additional_data);
        let required = RequiredSignature::from_coin_spends(
            &mut ctx,
            &coin_spends,
            &agg_sig_consts,
        )
        .map_err(|e| EngineError::Internal(format!("required_signatures: {e}")))?;

        let mut sks_by_pk: std::collections::HashMap<Vec<u8>, SecretKey> =
            std::collections::HashMap::new();
        sks_by_pk.insert(our_pk.to_bytes().to_vec(), our_synthetic.clone());
        for k in &fee_keys {
            sks_by_pk.insert(k.pk.to_bytes().to_vec(), k.sk.clone());
        }

        let mut aggregated = Signature::default();
        for r in required {
            match r {
                RequiredSignature::Bls(RequiredBlsSignature {
                    public_key,
                    raw_message,
                    appended_info,
                    domain_string,
                }) => {
                    let pk_bytes = public_key.to_bytes().to_vec();
                    let sk = sks_by_pk.get(&pk_bytes).ok_or_else(|| {
                        EngineError::Internal(format!(
                            "no secret key for pubkey {}",
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
                        "SECP not supported in transfer_nft".to_string(),
                    ));
                }
            }
        }

        let bundle = SpendBundle::new(coin_spends.clone(), aggregated);
        let tx_id = bundle.name();

        let mut status = "DRY_RUN".to_string();
        let mut error: Option<String> = None;
        if req.broadcast {
            let res = client
                .push_tx(bundle.clone())
                .await
                .map_err(|e| EngineError::Internal(format!("push_tx: {e}")))?;
            status = res.status;
            error = res.error;
        }

        Ok(serde_json::json!({
            "tx_id": format!("0x{}", hex::encode(tx_id)),
            "status": status,
            "error": error,
            "spend_bundle": {
                "coin_spends": coin_spends.iter().map(serialize_coin_spend).collect::<Vec<_>>(),
                "aggregated_signature": format!("0x{}", hex::encode(bundle.aggregated_signature.to_bytes())),
            },
            "launcher_id": format!("0x{}", hex::encode(nft.info.launcher_id)),
            "recipient_puzzle_hash": format!("0x{}", hex::encode(recipient_ph)),
        })
        .to_string())
    }

    /// Append a new URI to an NFT's metadata. Re-spends the NFT singleton
    /// to itself (same p2 owner) with a MetadataUpdate inner condition.
    ///
    /// `uri_kind` selects which list the URI lands in:
    ///   - "data"     → data_uris (front-of-list)
    ///   - "metadata" → metadata_uris
    ///   - "license"  → license_uris
    ///
    /// The new URI is prepended in upstream metadata semantics; older URIs
    /// remain accessible. Hash fields are NOT changed by this op — set them
    /// at mint or via a separate spend.
    ///
    /// Params (same shape as transfer_nft, swapping recipient_address for
    /// the URI fields):
    /// ```
    /// {
    ///   fingerprint: u32,
    ///   coin_id: "0x...",
    ///   parent_coin_info?: "0x...",          // optional, looked up if absent
    ///   derivation_index: u32,
    ///   uri_kind: "data" | "metadata" | "license",
    ///   uri: "ipfs://...",
    ///   fee_mojos?: "0",
    ///   fee_input_coins?: [{ parent_coin_info, puzzle_hash, amount,
    ///                        derivation_index }],
    ///   fee_change_index?: u32,
    ///   endpoint?: "mainnet" | "testnet11" | "<url>",
    ///   broadcast?: true
    /// }
    /// ```
    async fn add_nft_uri(&self, params_json: &str) -> Result<String, EngineError> {
        use chia_wallet_sdk::{
            chia::{
                bls::{sign, Signature},
                consensus::consensus_constants::ConsensusConstants,
                protocol::SpendBundle,
            },
            clvmr::serde::node_from_bytes,
            driver::{MetadataUpdate, Nft, Puzzle, SpendContext, StandardLayer, UriKind},
            signer::{AggSigConstants, RequiredBlsSignature, RequiredSignature},
            types::MAINNET_CONSTANTS,
        };

        #[derive(Deserialize)]
        struct FeeCoinJson {
            parent_coin_info: String,
            puzzle_hash: String,
            amount: String,
            derivation_index: u32,
        }
        #[derive(Deserialize)]
        struct Req {
            fingerprint: u32,
            coin_id: String,
            #[serde(default)]
            parent_coin_info: Option<String>,
            derivation_index: u32,
            uri_kind: String,
            uri: String,
            #[serde(default = "default_zero_mojos_uri")]
            fee_mojos: String,
            #[serde(default)]
            fee_input_coins: Vec<FeeCoinJson>,
            #[serde(default)]
            fee_change_index: Option<u32>,
            #[serde(default)]
            endpoint: Option<String>,
            #[serde(default = "default_true_uri")]
            broadcast: bool,
        }
        fn default_zero_mojos_uri() -> String {
            "0".to_string()
        }
        fn default_true_uri() -> bool {
            true
        }

        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;

        let fee: u64 = req
            .fee_mojos
            .parse()
            .map_err(|_| EngineError::InvalidParams("fee_mojos u64".to_string()))?;
        if fee > 0 && req.fee_input_coins.is_empty() {
            return Err(EngineError::InvalidParams(
                "fee_input_coins required when fee_mojos > 0".to_string(),
            ));
        }
        if req.uri.trim().is_empty() {
            return Err(EngineError::InvalidParams(
                "uri must be a non-empty string".to_string(),
            ));
        }
        let uri_kind = match req.uri_kind.as_str() {
            "data" => UriKind::Data,
            "metadata" => UriKind::Metadata,
            "license" => UriKind::License,
            other => {
                return Err(EngineError::InvalidParams(format!(
                    "uri_kind must be \"data\", \"metadata\", or \"license\" — got {other:?}"
                )));
            }
        };

        let coin_id = parse_bytes32(&req.coin_id)?;

        // Resolve parent_id same as transfer_nft.
        let client = make_client(req.endpoint.as_deref());
        let parent_id: Bytes32 = match req.parent_coin_info.as_deref() {
            Some(s) => parse_bytes32(s)?,
            None => {
                let rec = client
                    .get_coin_record_by_name(coin_id)
                    .await
                    .map_err(|e| EngineError::Internal(format!("coin lookup: {e}")))?
                    .coin_record
                    .ok_or_else(|| {
                        EngineError::InvalidParams(format!(
                            "coin {} not found",
                            hex::encode(coin_id)
                        ))
                    })?;
                rec.coin.parent_coin_info
            }
        };

        let parent_rec = client
            .get_coin_record_by_name(parent_id)
            .await
            .map_err(|e| EngineError::Internal(format!("parent lookup: {e}")))?
            .coin_record
            .ok_or_else(|| {
                EngineError::InvalidParams(format!(
                    "parent coin {} not found",
                    hex::encode(parent_id)
                ))
            })?;
        if !parent_rec.spent {
            return Err(EngineError::InvalidParams(
                "parent coin not spent — NFT not yet on chain?".to_string(),
            ));
        }
        let parent_spend_res = client
            .get_puzzle_and_solution(parent_id, Some(parent_rec.spent_block_index))
            .await
            .map_err(|e| EngineError::Internal(format!("parent spend: {e}")))?;
        let parent_spend = parent_spend_res
            .coin_solution
            .ok_or_else(|| EngineError::Internal("missing parent coin solution".to_string()))?;

        let mut ctx = SpendContext::new();
        let parent_puzzle_ptr = node_from_bytes(&mut *ctx, parent_spend.puzzle_reveal.as_ref())
            .map_err(|e| EngineError::Internal(format!("parent puzzle parse: {e}")))?;
        let parent_solution_ptr = node_from_bytes(&mut *ctx, parent_spend.solution.as_ref())
            .map_err(|e| EngineError::Internal(format!("parent solution parse: {e}")))?;
        let parent_puzzle = Puzzle::parse(&ctx, parent_puzzle_ptr);

        let nft = Nft::parse_child(
            &mut *ctx,
            parent_spend.coin,
            parent_puzzle,
            parent_solution_ptr,
        )
        .map_err(|e| EngineError::Internal(format!("Nft::parse_child: {e}")))?
        .ok_or_else(|| {
            EngineError::Internal(
                "parent didn't produce a parseable NFT child".to_string(),
            )
        })?;

        if nft.coin.coin_id() != coin_id {
            return Err(EngineError::Internal(format!(
                "parent's NFT child coin {} != requested {}",
                hex::encode(nft.coin.coin_id()),
                hex::encode(coin_id)
            )));
        }

        // Verify ownership via the derivation_index our wallet thinks owns it.
        let master_sk = self.unlocked_sk(req.fingerprint)?;
        let our_intermediate = master_to_wallet_unhardened(&master_sk, req.derivation_index);
        let our_synthetic = our_intermediate.derive_synthetic();
        let our_pk = our_synthetic.public_key();
        let our_inner_ph: Bytes32 = StandardArgs::curry_tree_hash(our_pk).into();
        if our_inner_ph != nft.info.p2_puzzle_hash {
            return Err(EngineError::InvalidParams(format!(
                "derivation_index {} doesn't match NFT's p2_puzzle_hash {}",
                req.derivation_index,
                hex::encode(nft.info.p2_puzzle_hash)
            )));
        }

        // Build the metadata-update inner spend and re-spend the NFT to self.
        let metadata_update = MetadataUpdate {
            kind: uri_kind,
            uri: req.uri.clone(),
        }
        .spend(&mut ctx)
        .map_err(|e| EngineError::Internal(format!("MetadataUpdate::spend: {e}")))?;

        let standard_layer = StandardLayer::new(our_pk);
        let _new_nft = nft
            .transfer_with_metadata(
                &mut ctx,
                &standard_layer,
                our_inner_ph, // self-owner — only the metadata is changing
                metadata_update,
                Conditions::new(),
            )
            .map_err(|e| {
                EngineError::Internal(format!("Nft::transfer_with_metadata: {e}"))
            })?;

        // Pay the optional XCH fee (same flow as transfer_nft).
        struct FeeKey {
            sk: SecretKey,
            pk: PublicKey,
        }
        let mut fee_keys: Vec<FeeKey> = Vec::new();
        if fee > 0 {
            let total_in: u64 = req.fee_input_coins.iter().try_fold(0u64, |acc, c| {
                let amt: u64 = c
                    .amount
                    .parse()
                    .map_err(|_| EngineError::InvalidParams("fee coin amount u64".to_string()))?;
                acc.checked_add(amt)
                    .ok_or_else(|| EngineError::InvalidParams("fee sum overflow".to_string()))
            })?;
            if total_in < fee {
                return Err(EngineError::InvalidParams(format!(
                    "fee_input_coins sum {total_in} < fee {fee}"
                )));
            }
            let change_index = req.fee_change_index.unwrap_or(req.derivation_index);
            let change_intermediate = master_to_wallet_unhardened(&master_sk, change_index);
            let change_pk = change_intermediate.derive_synthetic().public_key();
            let change_ph: Bytes32 = StandardArgs::curry_tree_hash(change_pk).into();
            let change = total_in - fee;

            for (i, c) in req.fee_input_coins.iter().enumerate() {
                let parent = parse_bytes32(&c.parent_coin_info)?;
                let outer_ph = parse_bytes32(&c.puzzle_hash)?;
                let amt: u64 = c.amount.parse().unwrap();
                let coin = Coin::new(parent, outer_ph, amt);

                let fee_intermediate = master_to_wallet_unhardened(&master_sk, c.derivation_index);
                let fee_synthetic = fee_intermediate.derive_synthetic();
                let fee_pk = fee_synthetic.public_key();
                let derived_ph: Bytes32 = StandardArgs::curry_tree_hash(fee_pk).into();
                if derived_ph != outer_ph {
                    return Err(EngineError::InvalidParams(format!(
                        "fee_input_coins[{i}] puzzle_hash doesn't match derivation_index"
                    )));
                }

                let conditions = if i == 0 {
                    let mut c = Conditions::new().reserve_fee(fee);
                    if change > 0 {
                        c = c.create_coin(change_ph, change, ctx.hint(change_ph).unwrap());
                    }
                    c
                } else {
                    Conditions::new()
                };
                let p2_spend = StandardLayer::new(fee_pk)
                    .spend_with_conditions(&mut ctx, conditions)
                    .map_err(|e| EngineError::Internal(format!("fee p2 spend: {e}")))?;
                ctx.spend(coin, p2_spend)
                    .map_err(|e| EngineError::Internal(format!("fee spend: {e}")))?;
                fee_keys.push(FeeKey {
                    sk: fee_synthetic,
                    pk: fee_pk,
                });
            }
        }

        let coin_spends = ctx.take();

        let constants: &ConsensusConstants = &MAINNET_CONSTANTS;
        let agg_sig_consts = AggSigConstants::new(constants.agg_sig_me_additional_data);
        let required = RequiredSignature::from_coin_spends(
            &mut ctx,
            &coin_spends,
            &agg_sig_consts,
        )
        .map_err(|e| EngineError::Internal(format!("required_signatures: {e}")))?;

        let mut sks_by_pk: std::collections::HashMap<Vec<u8>, SecretKey> =
            std::collections::HashMap::new();
        sks_by_pk.insert(our_pk.to_bytes().to_vec(), our_synthetic.clone());
        for k in &fee_keys {
            sks_by_pk.insert(k.pk.to_bytes().to_vec(), k.sk.clone());
        }

        let mut aggregated = Signature::default();
        for r in required {
            match r {
                RequiredSignature::Bls(RequiredBlsSignature {
                    public_key,
                    raw_message,
                    appended_info,
                    domain_string,
                }) => {
                    let pk_bytes = public_key.to_bytes().to_vec();
                    let sk = sks_by_pk.get(&pk_bytes).ok_or_else(|| {
                        EngineError::Internal(format!(
                            "no secret key for pubkey {}",
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
                        "SECP not supported in add_nft_uri".to_string(),
                    ));
                }
            }
        }

        let bundle = SpendBundle::new(coin_spends.clone(), aggregated);
        let tx_id = bundle.name();

        let mut status = "DRY_RUN".to_string();
        let mut error: Option<String> = None;
        if req.broadcast {
            let res = client
                .push_tx(bundle.clone())
                .await
                .map_err(|e| EngineError::Internal(format!("push_tx: {e}")))?;
            status = res.status;
            error = res.error;
        }

        Ok(serde_json::json!({
            "tx_id": format!("0x{}", hex::encode(tx_id)),
            "status": status,
            "error": error,
            "spend_bundle": {
                "coin_spends": coin_spends.iter().map(serialize_coin_spend).collect::<Vec<_>>(),
                "aggregated_signature": format!("0x{}", hex::encode(bundle.aggregated_signature.to_bytes())),
            },
            "launcher_id": format!("0x{}", hex::encode(nft.info.launcher_id)),
            "uri_kind": req.uri_kind,
            "uri": req.uri,
        })
        .to_string())
    }

    /// Decode an "offer1..." string into its component spends and an
    /// arbitrage summary (what's offered, what's requested). Read-only —
    /// no signing, no network. UI uses this to display an offer before
    /// the user decides to accept it.
    ///
    /// Returns a JSON describing the offer's offered/requested coins +
    /// amounts. Note that full make/take of offers (with royalty handling
    /// and settlement-puzzle bookkeeping) is intentionally not yet
    /// implemented; the JS side should treat this as a parse-only call.
    async fn decode_offer(&self, params_json: &str) -> Result<String, EngineError> {
        use chia_wallet_sdk::{clvmr::Allocator, driver::{decode_offer, Offer}};

        #[derive(Deserialize)]
        struct Req {
            offer: String,
        }
        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;

        let bundle = decode_offer(req.offer.trim())
            .map_err(|e| EngineError::InvalidParams(format!("decode_offer: {e}")))?;

        let mut allocator = Allocator::new();
        let offer = Offer::from_spend_bundle(&mut allocator, &bundle)
            .map_err(|e| EngineError::Internal(format!("Offer::from_spend_bundle: {e}")))?;
        let arb = offer.arbitrage();

        // Summarise CAT amounts on each side.
        let offered_cats: Vec<_> = arb
            .offered
            .cats
            .iter()
            .map(|(k, v)| {
                serde_json::json!({
                    "asset_id": format!("0x{}", hex::encode(k)),
                    "amount": v.to_string(),
                })
            })
            .collect();
        let requested_cats: Vec<_> = arb
            .requested
            .cats
            .iter()
            .map(|(k, v)| {
                serde_json::json!({
                    "asset_id": format!("0x{}", hex::encode(k)),
                    "amount": v.to_string(),
                })
            })
            .collect();

        Ok(serde_json::json!({
            "offered": {
                "xch_mojos": arb.offered.xch.to_string(),
                "cats": offered_cats,
                "nft_launcher_ids": arb.offered.nfts.iter()
                    .map(|l| format!("0x{}", hex::encode(l)))
                    .collect::<Vec<_>>(),
            },
            "requested": {
                "xch_mojos": arb.requested.xch.to_string(),
                "cats": requested_cats,
                "nft_launcher_ids": arb.requested.nfts.iter()
                    .map(|l| format!("0x{}", hex::encode(l)))
                    .collect::<Vec<_>>(),
            },
            "coin_spends_count": bundle.coin_spends.len(),
            "offered_royalties": offer.requested_royalties().iter().map(|r| {
                serde_json::json!({
                    "nft_launcher_id": format!("0x{}", hex::encode(r.launcher_id)),
                    "royalty_basis_points": r.basis_points,
                    "royalty_puzzle_hash": format!("0x{}", hex::encode(r.puzzle_hash)),
                })
            }).collect::<Vec<_>>(),
        })
        .to_string())
    }

    /// Take an "offer1..." string by spending our own coins to fulfill the
    /// requested payments + the offered side's settlement assertions.
    ///
    /// Uses the SDK's high-level `Spends` action system: we add our taker
    /// inputs (XCH coins, optional CAT coins) alongside the offered coins,
    /// apply the maker's requested payment actions, and let the SDK figure
    /// out the change, royalties, and AGG_SIG bookkeeping. Royalty payouts
    /// for offered NFTs are handled automatically through `apply`.
    ///
    /// Note: `make_offer` is intentionally out-of-scope here — it lives in
    /// a separate endpoint to be added later. We also do *not* poll for
    /// transaction confirmation: callers should reuse the existing
    /// `check_coins_spent` flow that `send_xch` uses for status tracking.
    ///
    /// Params:
    /// ```
    /// {
    ///   fingerprint: u32,
    ///   offer: "offer1...",
    ///   input_coins: [{ parent_coin_info, puzzle_hash, amount,
    ///                   derivation_index }],
    ///   input_cats?: [{ parent_coin_info, puzzle_hash, amount,
    ///                   inner_puzzle_hash, derivation_index,
    ///                   lineage_proof: { parent_name, inner_puzzle_hash, amount },
    ///                   asset_id, hidden_puzzle_hash? }],
    ///   fee_mojos?: "0",
    ///   endpoint?: "mainnet"|"testnet11"|"<url>",
    ///   broadcast?: bool (default true)
    /// }
    /// ```
    async fn take_offer(&self, params_json: &str) -> Result<String, EngineError> {
        use chia_wallet_sdk::{
            chia::{
                bls::{sign, Signature},
                consensus::consensus_constants::ConsensusConstants,
                protocol::SpendBundle,
                puzzle_types::LineageProof,
            },
            clvmr::Allocator,
            driver::{
                decode_offer, Action, Cat, CatInfo, Offer, Relation, SpendContext, Spends,
            },
            signer::{AggSigConstants, RequiredBlsSignature, RequiredSignature},
            types::MAINNET_CONSTANTS,
        };
        use indexmap::IndexMap;

        #[derive(Deserialize)]
        struct InputCoinJson {
            parent_coin_info: String,
            puzzle_hash: String,
            amount: String,
            derivation_index: u32,
        }
        #[derive(Deserialize)]
        struct LineageJson {
            parent_name: String,
            inner_puzzle_hash: String,
            amount: String,
        }
        #[derive(Deserialize)]
        struct InputCatJson {
            parent_coin_info: String,
            puzzle_hash: String,
            amount: String,
            inner_puzzle_hash: String,
            derivation_index: u32,
            lineage_proof: LineageJson,
            asset_id: String,
            #[serde(default)]
            hidden_puzzle_hash: Option<String>,
        }
        #[derive(Deserialize)]
        struct Req {
            fingerprint: u32,
            offer: String,
            #[serde(default)]
            input_coins: Vec<InputCoinJson>,
            #[serde(default)]
            input_cats: Vec<InputCatJson>,
            #[serde(default = "default_zero_mojos_take")]
            fee_mojos: String,
            #[serde(default)]
            endpoint: Option<String>,
            #[serde(default = "default_true_take")]
            broadcast: bool,
        }
        fn default_zero_mojos_take() -> String {
            "0".to_string()
        }
        fn default_true_take() -> bool {
            true
        }

        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;

        let fee: u64 = req
            .fee_mojos
            .parse()
            .map_err(|_| EngineError::InvalidParams("fee_mojos must be u64".to_string()))?;

        if req.input_coins.is_empty() && req.input_cats.is_empty() {
            return Err(EngineError::InvalidParams(
                "need at least one input coin or input cat".to_string(),
            ));
        }

        // 1. Decode the offer + reconstruct Offer view.
        let bundle = decode_offer(req.offer.trim())
            .map_err(|e| EngineError::InvalidParams(format!("decode_offer: {e}")))?;

        let mut allocator = Allocator::new();
        let offer = Offer::from_spend_bundle(&mut allocator, &bundle)
            .map_err(|e| EngineError::Internal(format!("Offer::from_spend_bundle: {e}")))?;

        // 2. Derive synthetic keys for every taker input + build pk/sk maps.
        let master_sk = self.unlocked_sk(req.fingerprint)?;

        struct ParsedXchInput {
            coin: Coin,
            sk: SecretKey,
            pk: PublicKey,
            inner_ph: Bytes32,
        }
        struct ParsedCatInput {
            cat: Cat,
            sk: SecretKey,
            pk: PublicKey,
            inner_ph: Bytes32,
        }

        let mut parsed_xch: Vec<ParsedXchInput> = Vec::with_capacity(req.input_coins.len());
        for (i, c) in req.input_coins.iter().enumerate() {
            let amount_u: u64 = c.amount.parse().map_err(|_| {
                EngineError::InvalidParams(format!("input_coins[{i}].amount must be u64"))
            })?;
            let parent = parse_bytes32(&c.parent_coin_info)?;
            let coin_ph = parse_bytes32(&c.puzzle_hash)?;
            let coin = Coin::new(parent, coin_ph, amount_u);
            let intermediate = master_to_wallet_unhardened(&master_sk, c.derivation_index);
            let synthetic_sk = intermediate.derive_synthetic();
            let synthetic_pk = synthetic_sk.public_key();
            let derived_ph: Bytes32 = StandardArgs::curry_tree_hash(synthetic_pk).into();
            if derived_ph != coin_ph {
                return Err(EngineError::InvalidParams(format!(
                    "input_coins[{i}] puzzle_hash {} doesn't match derivation_index {}",
                    hex::encode(coin_ph),
                    c.derivation_index
                )));
            }
            parsed_xch.push(ParsedXchInput {
                coin,
                sk: synthetic_sk,
                pk: synthetic_pk,
                inner_ph: derived_ph,
            });
        }

        let mut parsed_cats: Vec<ParsedCatInput> = Vec::with_capacity(req.input_cats.len());
        for (i, c) in req.input_cats.iter().enumerate() {
            let amt: u64 = c.amount.parse().map_err(|_| {
                EngineError::InvalidParams(format!("input_cats[{i}].amount must be u64"))
            })?;
            let parent = parse_bytes32(&c.parent_coin_info)?;
            let outer_ph = parse_bytes32(&c.puzzle_hash)?;
            let inner_ph = parse_bytes32(&c.inner_puzzle_hash)?;
            let hidden_ph = c
                .hidden_puzzle_hash
                .as_deref()
                .map(parse_bytes32)
                .transpose()?;
            let asset_id = parse_bytes32(&c.asset_id)?;
            let lineage_parent_name = parse_bytes32(&c.lineage_proof.parent_name)?;
            let lineage_inner_ph = parse_bytes32(&c.lineage_proof.inner_puzzle_hash)?;
            let lineage_amount: u64 = c.lineage_proof.amount.parse().map_err(|_| {
                EngineError::InvalidParams(format!(
                    "input_cats[{i}].lineage_proof.amount must be u64"
                ))
            })?;

            let intermediate = master_to_wallet_unhardened(&master_sk, c.derivation_index);
            let synthetic_sk = intermediate.derive_synthetic();
            let synthetic_pk = synthetic_sk.public_key();
            let derived_inner: Bytes32 = StandardArgs::curry_tree_hash(synthetic_pk).into();
            if derived_inner != inner_ph {
                return Err(EngineError::InvalidParams(format!(
                    "input_cats[{i}].inner_puzzle_hash {} doesn't match derivation_index {}",
                    hex::encode(inner_ph),
                    c.derivation_index
                )));
            }

            let cat = Cat {
                coin: Coin::new(parent, outer_ph, amt),
                lineage_proof: Some(LineageProof {
                    parent_parent_coin_info: lineage_parent_name,
                    parent_inner_puzzle_hash: lineage_inner_ph,
                    parent_amount: lineage_amount,
                }),
                info: CatInfo {
                    asset_id,
                    hidden_puzzle_hash: hidden_ph,
                    p2_puzzle_hash: inner_ph,
                },
            };
            parsed_cats.push(ParsedCatInput {
                cat,
                sk: synthetic_sk,
                pk: synthetic_pk,
                inner_ph,
            });
        }

        // 3. Pick the taker's first p2 inner_ph as the change puzzle hash.
        let taker_first_p2_ph: Bytes32 = if let Some(first) = parsed_xch.first() {
            first.inner_ph
        } else {
            // No XCH inputs — fall back to first CAT input's p2 inner.
            parsed_cats
                .first()
                .map(|c| c.inner_ph)
                .ok_or_else(|| {
                    EngineError::InvalidParams("no taker inputs provided".to_string())
                })?
        };

        // 4. Build the Spends. We need a fresh allocator/ctx because the SDK
        //    `Offer::from_spend_bundle` borrowed `allocator`; for the taker
        //    spend we want a clean `SpendContext`.
        let mut ctx = SpendContext::new();
        let mut spends = Spends::new(taker_first_p2_ph);

        // Add the offered coins (settlement-paid by the maker side).
        spends.add(offer.offered_coins().clone());

        // Add taker XCH inputs.
        for p in &parsed_xch {
            spends.add(p.coin);
        }

        // Add taker CAT inputs.
        for p in &parsed_cats {
            spends.add(p.cat);
        }

        // 5. Apply maker's requested payments + optional fee as actions.
        let mut actions: Vec<Action> = offer.requested_payments().actions();
        if fee > 0 {
            actions.push(Action::fee(fee));
        }

        let deltas = spends
            .apply(&mut ctx, &actions)
            .map_err(|e| EngineError::Internal(format!("Spends::apply: {e}")))?;

        // 6. Build pk lookup table keyed by p2_puzzle_hash for finish_with_keys
        //    and parallel sk lookup keyed by pk bytes for signing.
        let mut synthetic_keys: IndexMap<Bytes32, PublicKey> = IndexMap::new();
        let mut sks_by_pk: std::collections::HashMap<Vec<u8>, SecretKey> =
            std::collections::HashMap::new();
        for p in &parsed_xch {
            synthetic_keys.insert(p.inner_ph, p.pk);
            sks_by_pk.insert(p.pk.to_bytes().to_vec(), p.sk.clone());
        }
        for p in &parsed_cats {
            synthetic_keys.insert(p.inner_ph, p.pk);
            sks_by_pk.insert(p.pk.to_bytes().to_vec(), p.sk.clone());
        }

        spends
            .finish_with_keys(&mut ctx, &deltas, Relation::AssertConcurrent, &synthetic_keys)
            .map_err(|e| EngineError::Internal(format!("Spends::finish_with_keys: {e}")))?;

        let coin_spends = ctx.take();

        // 7. Sign all required AGG_SIG signatures from our taker spends.
        //    Maker-side settlement coins don't need signatures (their sigs
        //    are already in the offer's input spend bundle).
        let constants: &ConsensusConstants = &MAINNET_CONSTANTS;
        let agg_sig_consts = AggSigConstants::new(constants.agg_sig_me_additional_data);
        let required = RequiredSignature::from_coin_spends(
            &mut ctx,
            &coin_spends,
            &agg_sig_consts,
        )
        .map_err(|e| EngineError::Internal(format!("required_signatures: {e}")))?;

        let mut aggregated = Signature::default();
        for r in required {
            match r {
                RequiredSignature::Bls(RequiredBlsSignature {
                    public_key,
                    raw_message,
                    appended_info,
                    domain_string,
                }) => {
                    let pk_bytes = public_key.to_bytes().to_vec();
                    let sk = sks_by_pk.get(&pk_bytes).ok_or_else(|| {
                        EngineError::Internal(format!(
                            "no secret key for pubkey {} (not among taker inputs)",
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
                        "SECP signatures not supported in take_offer".to_string(),
                    ));
                }
            }
        }

        // 8. Combine maker's settlement spends with our taker spends + sig.
        let taker_bundle = SpendBundle::new(coin_spends, aggregated);
        let spend_bundle = offer.take(taker_bundle);

        // 9. Optionally push to coinset.
        let mut status = "DRY_RUN".to_string();
        let mut error: Option<String> = None;
        if req.broadcast {
            let client = make_client(req.endpoint.as_deref());
            let res = client
                .push_tx(spend_bundle.clone())
                .await
                .map_err(|e| EngineError::Internal(format!("push_tx: {e}")))?;
            status = res.status;
            error = res.error;
        }

        let tx_id = spend_bundle.name();
        Ok(serde_json::json!({
            "tx_id": format!("0x{}", hex::encode(tx_id)),
            "status": status,
            "error": error,
            "spend_bundle": {
                "coin_spends": spend_bundle.coin_spends.iter().map(serialize_coin_spend).collect::<Vec<_>>(),
                "aggregated_signature": format!("0x{}", hex::encode(spend_bundle.aggregated_signature.to_bytes())),
            },
            "input_xch_count": parsed_xch.len(),
            "input_cat_count": parsed_cats.len(),
        })
        .to_string())
    }

    /// Build an offer1... string from the maker side.
    ///
    /// Caller (JS handler) already selected input coins to cover the offered
    /// XCH + offered CATs + fee. We:
    ///   1. Derive synthetic keys per input coin (same as take_offer).
    ///   2. Build a Spends with all maker inputs.
    ///   3. Apply Actions: Action::send to SETTLEMENT_PAYMENT_HASH for each
    ///      offered asset, plus Action::fee for the network fee.
    ///   4. Build RequestedPayments (XCH/CAT) targeted at our own p2_ph so the
    ///      taker pays us. Nonce = hash of our non-settlement input coin ids.
    ///   5. Add the requested-payments assertions to the maker spend so the
    ///      maker-side bundle only validates if the taker actually pays.
    ///   6. finish_with_keys → maker coin_spends. Sign them. Wrap into Offer
    ///      via from_input_spend_bundle + encode_offer.
    ///
    /// Returns `{ offer: "offer1...", offer_id: "0x<hex>" }`.
    ///
    /// Out of scope today: NFTs/options on either side, royalty calc. CAT and
    /// XCH cover what dexie/tibet need for AIR-style swaps; NFT support can
    /// land later by extending Offered/Requested.
    async fn make_offer(&self, params_json: &str) -> Result<String, EngineError> {
        use chia_wallet_sdk::{
            chia::{
                bls::{sign, Signature},
                consensus::consensus_constants::ConsensusConstants,
                protocol::SpendBundle,
                puzzle_types::{
                    LineageProof, Memos,
                    offer::{NotarizedPayment, Payment},
                },
            },
            driver::{
                encode_offer, Action, AssetInfo, Cat, CatAssetInfo, CatInfo, Id, Offer, Relation,
                RequestedPayments, SpendContext, Spends,
            },
            puzzles::SETTLEMENT_PAYMENT_HASH,
            signer::{AggSigConstants, RequiredBlsSignature, RequiredSignature},
            types::MAINNET_CONSTANTS,
        };
        use indexmap::IndexMap;

        #[derive(Deserialize)]
        struct InputCoinJson {
            parent_coin_info: String,
            puzzle_hash: String,
            amount: String,
            derivation_index: u32,
        }
        #[derive(Deserialize)]
        struct LineageJson {
            parent_name: String,
            inner_puzzle_hash: String,
            amount: String,
        }
        #[derive(Deserialize)]
        struct InputCatJson {
            parent_coin_info: String,
            puzzle_hash: String,
            amount: String,
            inner_puzzle_hash: String,
            derivation_index: u32,
            lineage_proof: LineageJson,
            asset_id: String,
            #[serde(default)]
            hidden_puzzle_hash: Option<String>,
        }
        #[derive(Deserialize)]
        struct AssetAmount {
            asset_id: String,
            amount: String,
        }
        #[derive(Deserialize)]
        struct Req {
            fingerprint: u32,
            #[serde(default = "default_zero_mojos_make")]
            offered_xch_mojos: String,
            #[serde(default)]
            offered_cats: Vec<AssetAmount>,
            #[serde(default = "default_zero_mojos_make")]
            requested_xch_mojos: String,
            #[serde(default)]
            requested_cats: Vec<AssetAmount>,
            #[serde(default = "default_zero_mojos_make")]
            fee_mojos: String,
            #[serde(default)]
            input_coins: Vec<InputCoinJson>,
            #[serde(default)]
            input_cats: Vec<InputCatJson>,
        }
        fn default_zero_mojos_make() -> String {
            "0".to_string()
        }

        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;

        let offered_xch: u64 = req.offered_xch_mojos.parse().map_err(|_| {
            EngineError::InvalidParams("offered_xch_mojos must be u64".to_string())
        })?;
        let requested_xch: u64 = req.requested_xch_mojos.parse().map_err(|_| {
            EngineError::InvalidParams("requested_xch_mojos must be u64".to_string())
        })?;
        let fee: u64 = req
            .fee_mojos
            .parse()
            .map_err(|_| EngineError::InvalidParams("fee_mojos must be u64".to_string()))?;

        let has_offered = offered_xch > 0 || !req.offered_cats.is_empty();
        let has_requested = requested_xch > 0 || !req.requested_cats.is_empty();
        if !has_offered {
            return Err(EngineError::InvalidParams(
                "make_offer requires at least one offered asset (xch or cat)".to_string(),
            ));
        }
        if !has_requested {
            return Err(EngineError::InvalidParams(
                "make_offer requires at least one requested asset (xch or cat)".to_string(),
            ));
        }
        if req.input_coins.is_empty() && req.input_cats.is_empty() {
            return Err(EngineError::InvalidParams(
                "make_offer needs at least one input coin or cat to spend from"
                    .to_string(),
            ));
        }

        // 1. Derive synthetic keys per input (same routine as take_offer).
        let master_sk = self.unlocked_sk(req.fingerprint)?;

        struct ParsedXchInput {
            coin: Coin,
            sk: SecretKey,
            pk: PublicKey,
            inner_ph: Bytes32,
        }
        struct ParsedCatInput {
            cat: Cat,
            sk: SecretKey,
            pk: PublicKey,
            inner_ph: Bytes32,
        }

        let mut parsed_xch: Vec<ParsedXchInput> = Vec::with_capacity(req.input_coins.len());
        for (i, c) in req.input_coins.iter().enumerate() {
            let amount_u: u64 = c.amount.parse().map_err(|_| {
                EngineError::InvalidParams(format!("input_coins[{i}].amount must be u64"))
            })?;
            let parent = parse_bytes32(&c.parent_coin_info)?;
            let coin_ph = parse_bytes32(&c.puzzle_hash)?;
            let coin = Coin::new(parent, coin_ph, amount_u);
            let intermediate = master_to_wallet_unhardened(&master_sk, c.derivation_index);
            let synthetic_sk = intermediate.derive_synthetic();
            let synthetic_pk = synthetic_sk.public_key();
            let derived_ph: Bytes32 = StandardArgs::curry_tree_hash(synthetic_pk).into();
            if derived_ph != coin_ph {
                return Err(EngineError::InvalidParams(format!(
                    "input_coins[{i}] puzzle_hash {} doesn't match derivation_index {}",
                    hex::encode(coin_ph),
                    c.derivation_index
                )));
            }
            parsed_xch.push(ParsedXchInput {
                coin,
                sk: synthetic_sk,
                pk: synthetic_pk,
                inner_ph: derived_ph,
            });
        }

        let mut parsed_cats: Vec<ParsedCatInput> = Vec::with_capacity(req.input_cats.len());
        for (i, c) in req.input_cats.iter().enumerate() {
            let amt: u64 = c.amount.parse().map_err(|_| {
                EngineError::InvalidParams(format!("input_cats[{i}].amount must be u64"))
            })?;
            let parent = parse_bytes32(&c.parent_coin_info)?;
            let outer_ph = parse_bytes32(&c.puzzle_hash)?;
            let inner_ph = parse_bytes32(&c.inner_puzzle_hash)?;
            let hidden_ph = c
                .hidden_puzzle_hash
                .as_deref()
                .map(parse_bytes32)
                .transpose()?;
            let asset_id = parse_bytes32(&c.asset_id)?;
            let lineage_parent_name = parse_bytes32(&c.lineage_proof.parent_name)?;
            let lineage_inner_ph = parse_bytes32(&c.lineage_proof.inner_puzzle_hash)?;
            let lineage_amount: u64 = c.lineage_proof.amount.parse().map_err(|_| {
                EngineError::InvalidParams(format!(
                    "input_cats[{i}].lineage_proof.amount must be u64"
                ))
            })?;

            let intermediate = master_to_wallet_unhardened(&master_sk, c.derivation_index);
            let synthetic_sk = intermediate.derive_synthetic();
            let synthetic_pk = synthetic_sk.public_key();
            let derived_inner: Bytes32 = StandardArgs::curry_tree_hash(synthetic_pk).into();
            if derived_inner != inner_ph {
                return Err(EngineError::InvalidParams(format!(
                    "input_cats[{i}].inner_puzzle_hash {} doesn't match derivation_index {}",
                    hex::encode(inner_ph),
                    c.derivation_index
                )));
            }

            let cat = Cat {
                coin: Coin::new(parent, outer_ph, amt),
                lineage_proof: Some(LineageProof {
                    parent_parent_coin_info: lineage_parent_name,
                    parent_inner_puzzle_hash: lineage_inner_ph,
                    parent_amount: lineage_amount,
                }),
                info: CatInfo {
                    asset_id,
                    hidden_puzzle_hash: hidden_ph,
                    p2_puzzle_hash: inner_ph,
                },
            };
            parsed_cats.push(ParsedCatInput {
                cat,
                sk: synthetic_sk,
                pk: synthetic_pk,
                inner_ph,
            });
        }

        // 2. Pick the maker's first inner_ph for both change + receive-of-
        //    requested-payments. The wallet only needs ANY ph it controls.
        let maker_p2_ph: Bytes32 = if let Some(first) = parsed_xch.first() {
            first.inner_ph
        } else {
            parsed_cats
                .first()
                .map(|c| c.inner_ph)
                .ok_or_else(|| {
                    EngineError::InvalidParams("no maker inputs provided".to_string())
                })?
        };

        // 3. Build Spends + actions.
        let mut ctx = SpendContext::new();
        let mut spends = Spends::new(maker_p2_ph);

        for p in &parsed_xch {
            spends.add(p.coin);
        }
        for p in &parsed_cats {
            spends.add(p.cat);
        }

        let mut actions: Vec<Action> = Vec::new();
        if fee > 0 {
            actions.push(Action::fee(fee));
        }
        if offered_xch > 0 {
            actions.push(Action::send(
                Id::Xch,
                SETTLEMENT_PAYMENT_HASH.into(),
                offered_xch,
                Memos::None,
            ));
        }
        for entry in &req.offered_cats {
            let amount: u64 = entry.amount.parse().map_err(|_| {
                EngineError::InvalidParams(format!(
                    "offered_cats[{}].amount must be u64",
                    entry.asset_id
                ))
            })?;
            let asset_id = parse_bytes32(&entry.asset_id)?;
            actions.push(Action::send(
                Id::Existing(asset_id),
                SETTLEMENT_PAYMENT_HASH.into(),
                amount,
                Memos::None,
            ));
        }

        // 4. Build RequestedPayments + AssetInfo for everything we expect back.
        //    Nonce = hash of our non-settlement input coin ids so the taker's
        //    spend can be tied to ours (Offer's standard nonce convention).
        let nonce = Offer::nonce(spends.non_settlement_coin_ids());
        let hint = ctx
            .hint(maker_p2_ph)
            .map_err(|e| EngineError::Internal(format!("ctx.hint: {e}")))?;

        let mut requested_payments = RequestedPayments::new();
        let mut asset_info = AssetInfo::new();

        if requested_xch > 0 {
            requested_payments.xch.push(NotarizedPayment::new(
                nonce,
                vec![Payment::new(maker_p2_ph, requested_xch, hint)],
            ));
        }
        for entry in &req.requested_cats {
            let amount: u64 = entry.amount.parse().map_err(|_| {
                EngineError::InvalidParams(format!(
                    "requested_cats[{}].amount must be u64",
                    entry.asset_id
                ))
            })?;
            let asset_id = parse_bytes32(&entry.asset_id)?;
            requested_payments
                .cats
                .entry(asset_id)
                .or_default()
                .push(NotarizedPayment::new(
                    nonce,
                    vec![Payment::new(maker_p2_ph, amount, hint)],
                ));
            asset_info
                .insert_cat(asset_id, CatAssetInfo::new(None))
                .map_err(|e| EngineError::Internal(format!("insert_cat: {e}")))?;
        }

        // 5. Add the requested-payments assertions so the maker bundle only
        //    validates when the taker's bundle is concurrent and pays us.
        spends.conditions.required = spends
            .conditions
            .required
            .extend(
                requested_payments
                    .assertions(&mut ctx, &asset_info)
                    .map_err(|e| EngineError::Internal(format!("rp.assertions: {e}")))?,
            );

        // 6. Apply + settle the maker spends, sign them, wrap into Offer.
        let deltas = spends
            .apply(&mut ctx, &actions)
            .map_err(|e| EngineError::Internal(format!("Spends::apply: {e}")))?;

        let mut synthetic_keys: IndexMap<Bytes32, PublicKey> = IndexMap::new();
        let mut sks_by_pk: std::collections::HashMap<Vec<u8>, SecretKey> =
            std::collections::HashMap::new();
        for p in &parsed_xch {
            synthetic_keys.insert(p.inner_ph, p.pk);
            sks_by_pk.insert(p.pk.to_bytes().to_vec(), p.sk.clone());
        }
        for p in &parsed_cats {
            synthetic_keys.insert(p.inner_ph, p.pk);
            sks_by_pk.insert(p.pk.to_bytes().to_vec(), p.sk.clone());
        }

        spends
            .finish_with_keys(&mut ctx, &deltas, Relation::AssertConcurrent, &synthetic_keys)
            .map_err(|e| EngineError::Internal(format!("Spends::finish_with_keys: {e}")))?;

        let coin_spends = ctx.take();

        let constants: &ConsensusConstants = &MAINNET_CONSTANTS;
        let agg_sig_consts = AggSigConstants::new(constants.agg_sig_me_additional_data);
        let required = RequiredSignature::from_coin_spends(
            &mut ctx,
            &coin_spends,
            &agg_sig_consts,
        )
        .map_err(|e| EngineError::Internal(format!("required_signatures: {e}")))?;

        let mut aggregated = Signature::default();
        for r in required {
            match r {
                RequiredSignature::Bls(RequiredBlsSignature {
                    public_key,
                    raw_message,
                    appended_info,
                    domain_string,
                }) => {
                    let pk_bytes = public_key.to_bytes().to_vec();
                    let sk = sks_by_pk.get(&pk_bytes).ok_or_else(|| {
                        EngineError::Internal(format!(
                            "no secret key for pubkey {} (not among maker inputs)",
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
                        "SECP signatures not supported in make_offer".to_string(),
                    ));
                }
            }
        }

        // 7. Wrap maker bundle + requested payments into an Offer, then
        //    encode to "offer1...". offer_id == sha256(spend_bundle.name()).
        let offer = Offer::from_input_spend_bundle(
            &mut ctx,
            SpendBundle::new(coin_spends, aggregated),
            requested_payments,
            asset_info,
        )
        .map_err(|e| EngineError::Internal(format!("Offer::from_input_spend_bundle: {e}")))?;

        let final_bundle = offer
            .to_spend_bundle(&mut ctx)
            .map_err(|e| EngineError::Internal(format!("Offer::to_spend_bundle: {e}")))?;

        let offer_str = encode_offer(&final_bundle)
            .map_err(|e| EngineError::Internal(format!("encode_offer: {e}")))?;
        let offer_id = final_bundle.name();

        Ok(serde_json::json!({
            "offer": offer_str,
            "offer_id": format!("0x{}", hex::encode(offer_id)),
            "input_xch_count": parsed_xch.len(),
            "input_cat_count": parsed_cats.len(),
        })
        .to_string())
    }

    /// Bulk-mint NFTs against an existing DID.
    ///
    /// Wraps sage-wallet's `bulk_mint_nfts` logic without the DB layer:
    /// the JS caller passes the DID's current head coin_id + the wallet
    /// derivation_index that owns its p2_puzzle_hash, and we fetch the
    /// parent's spend from coinset to reconstruct the `Did` via
    /// `Did::parse_child`. Same resolution pattern as `transfer_nft`.
    ///
    /// Action chain per mint (matches `sage_wallet::nfts::bulk_mint_nfts`):
    ///   1. `Action::mint_nft_from_did` — create the NFT under the DID's
    ///      authority so the launcher's birth_certificate is signed by it.
    ///   2. `Action::update_nft(Id::New(i), [], Some(TransferNftById::new(
    ///      Some(Id::Existing(did_id)), [])))` — set the new NFT's owner_did.
    ///   3. Optional `Action::send` — if `mints[i].p2_puzzle_hash` is set,
    ///      transfer the NFT to that p2 in the same bundle. Without it the
    ///      NFT lands at the DID's change_p2 (default royalty target).
    ///
    /// Params:
    /// ```
    /// {
    ///   fingerprint: u32,
    ///   did_coin_id: "0x...",            // current unspent DID head
    ///   did_derivation_index: u32,       // OUR index owning the DID p2
    ///   mints: [{
    ///     p2_puzzle_hash?: "0x..." | null,
    ///     royalty_puzzle_hash?: "0x..." | null,
    ///     royalty_basis_points?: u16,    // 0..10000 = %*100, default 0
    ///     data_uris?: [string],
    ///     data_hash?: "0x...",
    ///     metadata_uris?: [string],
    ///     metadata_hash?: "0x...",
    ///     license_uris?: [string],
    ///     license_hash?: "0x...",
    ///     edition_number?: u64,          // default 1
    ///     edition_total?: u64,           // default 1
    ///   }],
    ///   fee_mojos: "0",
    ///   fee_input_coins: [{ parent_coin_info, puzzle_hash, amount,
    ///                       derivation_index }],  // required if fee > 0
    ///   change_index: u32,               // for XCH change + default royalty
    ///   endpoint?: "mainnet"|"testnet11"|"<url>",
    ///   broadcast?: bool (default true),
    /// }
    /// ```
    ///
    /// Returns:
    /// `{ nft_launcher_ids: ["0x..."], tx_id, status, error?,
    ///    spend_bundle, fee_change_mojos }`.
    async fn bulk_mint_nfts(&self, params_json: &str) -> Result<String, EngineError> {
        use chia_wallet_sdk::{
            chia::{
                bls::{sign, Signature},
                consensus::consensus_constants::ConsensusConstants,
                protocol::SpendBundle,
                puzzle_types::nft::NftMetadata,
            },
            clvmr::serde::node_from_bytes,
            driver::{
                Action, Did, Id, Puzzle, Relation, SpendContext, Spends, TransferNftById,
            },
            puzzles::NFT_METADATA_UPDATER_DEFAULT_HASH,
            signer::{AggSigConstants, RequiredBlsSignature, RequiredSignature},
            types::MAINNET_CONSTANTS,
        };
        use indexmap::IndexMap;

        #[derive(Deserialize)]
        struct FeeCoinJson {
            parent_coin_info: String,
            puzzle_hash: String,
            amount: String,
            derivation_index: u32,
        }
        #[derive(Deserialize)]
        struct MintJson {
            #[serde(default)]
            p2_puzzle_hash: Option<String>,
            #[serde(default)]
            royalty_puzzle_hash: Option<String>,
            #[serde(default)]
            royalty_basis_points: u16,
            #[serde(default)]
            data_uris: Vec<String>,
            #[serde(default)]
            data_hash: Option<String>,
            #[serde(default)]
            metadata_uris: Vec<String>,
            #[serde(default)]
            metadata_hash: Option<String>,
            #[serde(default)]
            license_uris: Vec<String>,
            #[serde(default)]
            license_hash: Option<String>,
            #[serde(default)]
            edition_number: Option<u64>,
            #[serde(default)]
            edition_total: Option<u64>,
        }
        #[derive(Deserialize)]
        struct Req {
            fingerprint: u32,
            did_coin_id: String,
            did_derivation_index: u32,
            mints: Vec<MintJson>,
            #[serde(default = "default_zero_mojos_bm")]
            fee_mojos: String,
            #[serde(default)]
            fee_input_coins: Vec<FeeCoinJson>,
            #[serde(default)]
            change_index: u32,
            #[serde(default)]
            endpoint: Option<String>,
            #[serde(default = "default_true_bm")]
            broadcast: bool,
        }
        fn default_zero_mojos_bm() -> String {
            "0".to_string()
        }
        fn default_true_bm() -> bool {
            true
        }

        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;

        if req.mints.is_empty() {
            return Err(EngineError::InvalidParams(
                "bulk_mint_nfts requires at least one mint".to_string(),
            ));
        }
        if req.mints.len() > 25 {
            return Err(EngineError::InvalidParams(format!(
                "too many mints ({}), max 25 per bundle",
                req.mints.len()
            )));
        }

        let fee: u64 = req
            .fee_mojos
            .parse()
            .map_err(|_| EngineError::InvalidParams("fee_mojos u64".to_string()))?;
        if fee > 0 && req.fee_input_coins.is_empty() {
            return Err(EngineError::InvalidParams(
                "fee_input_coins required when fee_mojos > 0".to_string(),
            ));
        }

        let did_coin_id = parse_bytes32(&req.did_coin_id)?;
        let master_sk = self.unlocked_sk(req.fingerprint)?;

        // 1. Derive the wallet's p2 puzzle hashes we'll need: the DID owner
        //    (must match the on-chain DID) and the change/default-royalty hash.
        let did_intermediate = master_to_wallet_unhardened(&master_sk, req.did_derivation_index);
        let did_synthetic_sk = did_intermediate.derive_synthetic();
        let did_synthetic_pk = did_synthetic_sk.public_key();
        let did_owner_ph: Bytes32 = StandardArgs::curry_tree_hash(did_synthetic_pk).into();

        let change_intermediate = master_to_wallet_unhardened(&master_sk, req.change_index);
        let change_synthetic_sk = change_intermediate.derive_synthetic();
        let change_synthetic_pk = change_synthetic_sk.public_key();
        let change_ph: Bytes32 = StandardArgs::curry_tree_hash(change_synthetic_pk).into();

        // 2. Fetch DID's current coin + its parent's spend, parse_child to
        //    reconstruct the full Did struct.
        let client = make_client(req.endpoint.as_deref());
        let did_rec = client
            .get_coin_record_by_name(did_coin_id)
            .await
            .map_err(|e| EngineError::Internal(format!("did coin lookup: {e}")))?
            .coin_record
            .ok_or_else(|| {
                EngineError::InvalidParams(format!(
                    "did_coin_id {} not found on chain",
                    hex::encode(did_coin_id)
                ))
            })?;
        if did_rec.spent {
            return Err(EngineError::InvalidParams(format!(
                "did_coin_id {} is already spent — pass the current unspent head",
                hex::encode(did_coin_id)
            )));
        }
        let did_coin = did_rec.coin;

        let parent_rec = client
            .get_coin_record_by_name(did_coin.parent_coin_info)
            .await
            .map_err(|e| EngineError::Internal(format!("did parent lookup: {e}")))?
            .coin_record
            .ok_or_else(|| {
                EngineError::Internal(format!(
                    "did parent {} not found on chain",
                    hex::encode(did_coin.parent_coin_info)
                ))
            })?;
        if !parent_rec.spent {
            return Err(EngineError::Internal(
                "did parent coin not spent — singleton chain broken?".to_string(),
            ));
        }
        let parent_spend = client
            .get_puzzle_and_solution(did_coin.parent_coin_info, Some(parent_rec.spent_block_index))
            .await
            .map_err(|e| EngineError::Internal(format!("did parent spend: {e}")))?
            .coin_solution
            .ok_or_else(|| EngineError::Internal("missing did parent solution".to_string()))?;

        let mut ctx = SpendContext::new();
        let parent_puzzle_ptr = node_from_bytes(&mut *ctx, parent_spend.puzzle_reveal.as_ref())
            .map_err(|e| EngineError::Internal(format!("did parent puzzle parse: {e}")))?;
        let parent_solution_ptr = node_from_bytes(&mut *ctx, parent_spend.solution.as_ref())
            .map_err(|e| EngineError::Internal(format!("did parent solution parse: {e}")))?;
        let parent_puzzle = Puzzle::parse(&ctx, parent_puzzle_ptr);

        let did: Did = Did::parse_child(
            &mut *ctx,
            parent_spend.coin,
            parent_puzzle,
            parent_solution_ptr,
            did_coin,
        )
        .map_err(|e| EngineError::Internal(format!("Did::parse_child: {e}")))?
        .ok_or_else(|| {
            EngineError::Internal(
                "did parent didn't produce a parseable DID child".to_string(),
            )
        })?;

        if did.info.p2_puzzle_hash != did_owner_ph {
            return Err(EngineError::InvalidParams(format!(
                "did_derivation_index {} doesn't own DID p2_puzzle_hash {} (derived {})",
                req.did_derivation_index,
                hex::encode(did.info.p2_puzzle_hash),
                hex::encode(did_owner_ph)
            )));
        }
        let did_launcher_id = did.info.launcher_id;

        // 3. Parse fee input coins (XCH) + verify ownership.
        struct ParsedXchInput {
            coin: Coin,
            sk: SecretKey,
            pk: PublicKey,
            inner_ph: Bytes32,
        }
        let mut parsed_xch: Vec<ParsedXchInput> = Vec::with_capacity(req.fee_input_coins.len());
        let mut total_fee_input: u64 = 0;
        for (i, c) in req.fee_input_coins.iter().enumerate() {
            let amount_u: u64 = c.amount.parse().map_err(|_| {
                EngineError::InvalidParams(format!("fee_input_coins[{i}].amount u64"))
            })?;
            total_fee_input = total_fee_input.checked_add(amount_u).ok_or_else(|| {
                EngineError::InvalidParams("fee input sum overflow".to_string())
            })?;
            let parent = parse_bytes32(&c.parent_coin_info)?;
            let coin_ph = parse_bytes32(&c.puzzle_hash)?;
            let coin = Coin::new(parent, coin_ph, amount_u);
            let inter = master_to_wallet_unhardened(&master_sk, c.derivation_index);
            let synth_sk = inter.derive_synthetic();
            let synth_pk = synth_sk.public_key();
            let derived_ph: Bytes32 = StandardArgs::curry_tree_hash(synth_pk).into();
            if derived_ph != coin_ph {
                return Err(EngineError::InvalidParams(format!(
                    "fee_input_coins[{i}] puzzle_hash {} doesn't match derivation_index {}",
                    hex::encode(coin_ph),
                    c.derivation_index
                )));
            }
            parsed_xch.push(ParsedXchInput {
                coin,
                sk: synth_sk,
                pk: synth_pk,
                inner_ph: derived_ph,
            });
        }
        if fee > 0 && total_fee_input < fee {
            return Err(EngineError::InvalidParams(format!(
                "fee_input_coins sum {total_fee_input} < fee {fee}"
            )));
        }

        // 4. Set up Spends with our change p2 as the change target. Add DID +
        //    fee inputs.
        let mut spends = Spends::new(change_ph);
        spends.add(did.clone());
        for p in &parsed_xch {
            spends.add(p.coin);
        }

        // 5. Build the action chain per mint.
        let mut actions: Vec<Action> = Vec::new();
        if fee > 0 {
            actions.push(Action::fee(fee));
        }

        for (mint_i, m) in req.mints.iter().enumerate() {
            let royalty_ph: Bytes32 = match m.royalty_puzzle_hash.as_deref() {
                Some(s) => parse_bytes32(s)?,
                None => change_ph,
            };

            let data_hash = m
                .data_hash
                .as_deref()
                .map(parse_bytes32)
                .transpose()?;
            let metadata_hash = m
                .metadata_hash
                .as_deref()
                .map(parse_bytes32)
                .transpose()?;
            let license_hash = m
                .license_hash
                .as_deref()
                .map(parse_bytes32)
                .transpose()?;

            let metadata = NftMetadata {
                edition_number: m.edition_number.unwrap_or(1),
                edition_total: m.edition_total.unwrap_or(1),
                data_uris: m.data_uris.clone(),
                data_hash,
                metadata_uris: m.metadata_uris.clone(),
                metadata_hash,
                license_uris: m.license_uris.clone(),
                license_hash,
            };
            let metadata_hashed = ctx
                .alloc_hashed(&metadata)
                .map_err(|e| EngineError::Internal(format!("alloc metadata: {e}")))?;

            // After this push, the new NFT's logical Id is `Id::New(index)`
            // where `index = actions.len()` at this point.
            let new_nft_index = actions.len();
            actions.push(Action::mint_nft_from_did(
                Id::Existing(did_launcher_id),
                metadata_hashed,
                NFT_METADATA_UPDATER_DEFAULT_HASH.into(),
                royalty_ph,
                m.royalty_basis_points,
                1,
            ));

            // Assign newly-minted NFT to the DID (sets owner_did so future
            // royalty assertions resolve, matches sage-wallet behavior).
            actions.push(Action::update_nft(
                Id::New(new_nft_index),
                vec![],
                Some(TransferNftById::new(Some(Id::Existing(did_launcher_id)), vec![])),
            ));

            // Optional final send: transfer the new NFT to a recipient p2.
            // If absent, the NFT stays at the DID's change_p2 (== change_ph).
            if let Some(p2_str) = m.p2_puzzle_hash.as_deref() {
                let p2 = parse_bytes32(p2_str).map_err(|e| {
                    EngineError::InvalidParams(format!("mints[{mint_i}].p2_puzzle_hash: {e:?}"))
                })?;
                let hint = ctx
                    .hint(p2)
                    .map_err(|e| EngineError::Internal(format!("mints[{mint_i}] hint: {e}")))?;
                actions.push(Action::send(Id::New(new_nft_index), p2, 1, hint));
            }
        }

        // 6. Apply actions + finalize coin spends via finish_with_keys.
        let deltas = spends
            .apply(&mut ctx, &actions)
            .map_err(|e| EngineError::Internal(format!("Spends::apply: {e}")))?;

        let mut synthetic_keys: IndexMap<Bytes32, PublicKey> = IndexMap::new();
        let mut sks_by_pk: std::collections::HashMap<Vec<u8>, SecretKey> =
            std::collections::HashMap::new();
        synthetic_keys.insert(did_owner_ph, did_synthetic_pk);
        sks_by_pk.insert(did_synthetic_pk.to_bytes().to_vec(), did_synthetic_sk.clone());
        for p in &parsed_xch {
            synthetic_keys.insert(p.inner_ph, p.pk);
            sks_by_pk.insert(p.pk.to_bytes().to_vec(), p.sk.clone());
        }
        // change_ph might equal one of the above; insert if missing so any
        // intermediate XCH spend the SDK creates at the change inner can sign.
        synthetic_keys.entry(change_ph).or_insert(change_synthetic_pk);
        sks_by_pk
            .entry(change_synthetic_pk.to_bytes().to_vec())
            .or_insert(change_synthetic_sk.clone());

        let outputs = spends
            .finish_with_keys(&mut ctx, &deltas, Relation::AssertConcurrent, &synthetic_keys)
            .map_err(|e| EngineError::Internal(format!("Spends::finish_with_keys: {e}")))?;

        let coin_spends = ctx.take();

        // 7. Sign all required AGG_SIGs.
        let constants: &ConsensusConstants = &MAINNET_CONSTANTS;
        let agg_sig_consts = AggSigConstants::new(constants.agg_sig_me_additional_data);
        let required = RequiredSignature::from_coin_spends(
            &mut ctx,
            &coin_spends,
            &agg_sig_consts,
        )
        .map_err(|e| EngineError::Internal(format!("required_signatures: {e}")))?;

        let mut aggregated = Signature::default();
        for r in required {
            match r {
                RequiredSignature::Bls(RequiredBlsSignature {
                    public_key,
                    raw_message,
                    appended_info,
                    domain_string,
                }) => {
                    let pk_bytes = public_key.to_bytes().to_vec();
                    let sk = sks_by_pk.get(&pk_bytes).ok_or_else(|| {
                        EngineError::Internal(format!(
                            "no secret key for pubkey {} (not among bulk_mint inputs)",
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
                        "SECP not supported in bulk_mint_nfts".to_string(),
                    ));
                }
            }
        }

        let bundle = SpendBundle::new(coin_spends.clone(), aggregated);
        let tx_id = bundle.name();

        // 8. Broadcast (unless dry-run).
        let mut status = "DRY_RUN".to_string();
        let mut error: Option<String> = None;
        if req.broadcast {
            let res = client
                .push_tx(bundle.clone())
                .await
                .map_err(|e| EngineError::Internal(format!("push_tx: {e}")))?;
            status = res.status;
            error = res.error;
        }

        // 9. Pull each minted NFT's launcher_id from outputs.nfts. The output
        //    map is keyed by Id::New(action_index) per mint.
        let nft_launcher_ids: Vec<String> = outputs
            .nfts
            .values()
            .map(|n| format!("0x{}", hex::encode(n.info.launcher_id)))
            .collect();
        let fee_change = total_fee_input.saturating_sub(fee);

        Ok(serde_json::json!({
            "nft_launcher_ids": nft_launcher_ids,
            "tx_id": format!("0x{}", hex::encode(tx_id)),
            "status": status,
            "error": error,
            "spend_bundle": {
                "coin_spends": coin_spends.iter().map(serialize_coin_spend).collect::<Vec<_>>(),
                "aggregated_signature": format!("0x{}", hex::encode(bundle.aggregated_signature.to_bytes())),
            },
            "fee_change_mojos": fee_change.to_string(),
            "did_launcher_id": format!("0x{}", hex::encode(did_launcher_id)),
        })
        .to_string())
    }

    /// Decode a list of CoinSpends into a human-readable summary the popup
    /// can show the user BEFORE they consent to sign.
    ///
    /// This is the anti-blind-signing endpoint: dApps that call
    /// `signCoinSpends` historically just got "N coin spends" in the
    /// approval popup, so a malicious bundle could move arbitrary value
    /// past an inattentive user. Here we:
    ///   1. For each coin, parse the puzzle to detect its kind
    ///      (Standard XCH / CAT / unknown).
    ///   2. Run the inner puzzle + solution through CLVM to extract the
    ///      emitted Conditions.
    ///   3. For every CREATE_COIN, classify the destination puzzle_hash
    ///      against `owner_puzzle_hashes` (our derived p2_puzzle_hash
    ///      window): outputs to one of our addresses are "change" /
    ///      "ours", everything else is "external".
    ///   4. Sum RESERVE_FEE conditions as the network fee.
    ///
    /// NFT / DID / option spends are returned as `kind: "unknown"` with
    /// the raw inner_puzzle_hash so the popup can fall back to "complex
    /// spend — review raw params" instead of mis-claiming the bundle's
    /// effect. Future passes can add Singleton+NFT parsing.
    ///
    /// Params:
    /// ```
    /// {
    ///   coin_spends: [{ coin: {parent_coin_info, puzzle_hash, amount},
    ///                   puzzle_reveal: "0x...", solution: "0x..." }],
    ///   owner_puzzle_hashes: ["0x..."]   // derived p2 puzzle hashes
    /// }
    /// ```
    ///
    /// Returns:
    /// ```
    /// {
    ///   spends: [{
    ///     coin_id, kind: "xch"|"cat"|"unknown",
    ///     asset_id?: "0x...",        // present for CAT
    ///     input_amount,              // mojos
    ///     input_is_ours: bool,
    ///     fee_mojos,
    ///     outputs: [{
    ///       puzzle_hash,
    ///       amount,                  // mojos
    ///       is_ours,                 // dest is in owner_puzzle_hashes
    ///       hint?                    // first memo if it looks like a 32B hint
    ///     }]
    ///   }],
    ///   summary: {
    ///     total_xch_out_external,    // sum of XCH CREATE_COIN to non-ours
    ///     total_xch_change,          // sum of XCH CREATE_COIN to ours
    ///     total_cat_out_by_asset: { "0x<asset_id>": "<mojos>" },  // external only
    ///     total_fee_mojos,
    ///     unknown_spend_count        // bundles can't be safely auto-summarised
    ///   }
    /// }
    /// ```
    async fn analyze_coin_spends(&self, params_json: &str) -> Result<String, EngineError> {
        use chia_wallet_sdk::{
            chia::puzzle_types::{Memos, cat::CatSolution},
            clvm_traits::FromClvm,
            clvm_utils::tree_hash,
            clvmr::{Allocator, serde::node_from_bytes},
            driver::{CatLayer, Layer, Puzzle},
            types::{Condition, run_puzzle},
        };

        #[derive(Deserialize)]
        struct CoinJson {
            parent_coin_info: String,
            puzzle_hash: String,
            amount: serde_json::Value, // accept string or number
        }
        #[derive(Deserialize)]
        struct CoinSpendJson {
            coin: CoinJson,
            puzzle_reveal: String,
            solution: String,
        }
        #[derive(Deserialize)]
        struct Req {
            coin_spends: Vec<CoinSpendJson>,
            #[serde(default)]
            owner_puzzle_hashes: Vec<String>,
        }

        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;

        let mut owner_set: std::collections::HashSet<Bytes32> = std::collections::HashSet::new();
        for ph in &req.owner_puzzle_hashes {
            owner_set.insert(parse_bytes32(ph)?);
        }

        fn amount_as_u64(v: &serde_json::Value) -> Result<u64, EngineError> {
            if let Some(s) = v.as_str() {
                return s.parse().map_err(|_| {
                    EngineError::InvalidParams(format!("amount string not u64: {s}"))
                });
            }
            if let Some(n) = v.as_u64() {
                return Ok(n);
            }
            Err(EngineError::InvalidParams(
                "coin.amount must be u64 (string or number)".to_string(),
            ))
        }

        let mut spends_out: Vec<serde_json::Value> = Vec::with_capacity(req.coin_spends.len());
        let mut total_xch_out_external: u128 = 0;
        let mut total_xch_change: u128 = 0;
        let mut total_fee: u128 = 0;
        let mut total_cat_out_by_asset: std::collections::HashMap<Bytes32, u128> =
            std::collections::HashMap::new();
        let mut unknown_count: u32 = 0;

        for (i, cs) in req.coin_spends.iter().enumerate() {
            let parent = parse_bytes32(&cs.coin.parent_coin_info)?;
            let puzzle_hash = parse_bytes32(&cs.coin.puzzle_hash)?;
            let amount = amount_as_u64(&cs.coin.amount)?;
            let coin = Coin::new(parent, puzzle_hash, amount);
            let coin_id = coin.coin_id();

            let puzzle_bytes = hex::decode(cs.puzzle_reveal.trim_start_matches("0x"))
                .map_err(|e| {
                    EngineError::InvalidParams(format!("puzzle_reveal[{i}] hex: {e}"))
                })?;
            let solution_bytes = hex::decode(cs.solution.trim_start_matches("0x"))
                .map_err(|e| EngineError::InvalidParams(format!("solution[{i}] hex: {e}")))?;

            let mut allocator = Allocator::new();
            let puzzle_ptr = node_from_bytes(&mut allocator, &puzzle_bytes)
                .map_err(|e| EngineError::Internal(format!("puzzle[{i}] clvm: {e}")))?;
            let solution_ptr = node_from_bytes(&mut allocator, &solution_bytes)
                .map_err(|e| EngineError::Internal(format!("solution[{i}] clvm: {e}")))?;

            let puzzle = Puzzle::parse(&allocator, puzzle_ptr);

            // Layer detection. Try CAT outer first; if that succeeds we know
            // (a) it's a CAT and (b) the asset_id. Standard XCH is the
            // common "everything else" — we recognise it by the outer
            // puzzle_hash matching one of our owner derivations. Anything
            // else (NFT, DID, option, custom puzzle) falls through to
            // "unknown" with a flag so the popup can warn.
            let cat_parsed = CatLayer::<Puzzle>::parse_puzzle(&allocator, puzzle)
                .ok()
                .flatten();

            let (kind_str, asset_id_opt, inner_solution_ptr) =
                if let Some(cat) = cat_parsed.as_ref() {
                    let inner_sol = CatSolution::<NodePtr>::from_clvm(&allocator, solution_ptr)
                        .map(|s| s.inner_puzzle_solution)
                        .unwrap_or(solution_ptr);
                    ("cat", Some(cat.asset_id), inner_sol)
                } else if owner_set.contains(&puzzle_hash) {
                    ("xch", None, solution_ptr)
                } else {
                    unknown_count = unknown_count.saturating_add(1);
                    ("unknown", None, solution_ptr)
                };

            // For ownership of the CURRENT coin: XCH is direct ph match;
            // CAT is inner-hash match (parsed from the CatLayer).
            let input_is_ours = match kind_str {
                "xch" => owner_set.contains(&puzzle_hash),
                "cat" => cat_parsed
                    .as_ref()
                    .map(|c| {
                        let inner_ph: Bytes32 =
                            tree_hash(&allocator, c.inner_puzzle.ptr()).into();
                        owner_set.contains(&inner_ph)
                    })
                    .unwrap_or(false),
                _ => false,
            };

            // Run the inner puzzle (or outer for XCH) against the inner
            // solution to extract Conditions. We use the OUTER puzzle for
            // XCH (no wrapping) and the CAT inner puzzle for CAT.
            let conditions_ptr = if kind_str == "cat" {
                let inner_node = cat_parsed
                    .as_ref()
                    .map(|c| c.inner_puzzle.ptr())
                    .unwrap_or(puzzle_ptr);
                run_puzzle(&mut allocator, inner_node, inner_solution_ptr)
                    .map_err(|e| EngineError::Internal(format!("run cat inner[{i}]: {e}")))?
            } else {
                run_puzzle(&mut allocator, puzzle_ptr, solution_ptr)
                    .map_err(|e| EngineError::Internal(format!("run puzzle[{i}]: {e}")))?
            };
            let conditions: Vec<Condition> =
                Vec::<Condition>::from_clvm(&allocator, conditions_ptr).unwrap_or_default();

            let mut outputs_json: Vec<serde_json::Value> = Vec::new();
            let mut spend_fee: u128 = 0;
            for cond in conditions {
                if let Some(cc) = cond.clone().into_create_coin() {
                    let dest_ph = cc.puzzle_hash;
                    let is_ours = owner_set.contains(&dest_ph);
                    let hint_hex = match cc.memos {
                        Memos::Some(m) => {
                            <(Bytes32, NodePtr)>::from_clvm(&allocator, m)
                                .ok()
                                .map(|(h, _)| format!("0x{}", hex::encode(h)))
                        }
                        Memos::None => None,
                    };
                    outputs_json.push(serde_json::json!({
                        "puzzle_hash": format!("0x{}", hex::encode(dest_ph)),
                        "amount": cc.amount.to_string(),
                        "is_ours": is_ours,
                        "hint": hint_hex,
                    }));
                    match kind_str {
                        "xch" => {
                            if is_ours {
                                total_xch_change =
                                    total_xch_change.saturating_add(u128::from(cc.amount));
                            } else {
                                total_xch_out_external = total_xch_out_external
                                    .saturating_add(u128::from(cc.amount));
                            }
                        }
                        "cat" => {
                            if !is_ours {
                                if let Some(aid) = asset_id_opt {
                                    let entry =
                                        total_cat_out_by_asset.entry(aid).or_insert(0);
                                    *entry = entry.saturating_add(u128::from(cc.amount));
                                }
                            }
                        }
                        _ => {}
                    }
                } else if let Some(rf) = cond.into_reserve_fee() {
                    spend_fee = spend_fee.saturating_add(u128::from(rf.amount));
                    total_fee = total_fee.saturating_add(u128::from(rf.amount));
                }
            }

            spends_out.push(serde_json::json!({
                "coin_id": format!("0x{}", hex::encode(coin_id)),
                "kind": kind_str,
                "asset_id": asset_id_opt.map(|a| format!("0x{}", hex::encode(a))),
                "input_amount": amount.to_string(),
                "input_is_ours": input_is_ours,
                "fee_mojos": spend_fee.to_string(),
                "outputs": outputs_json,
            }));
        }

        let total_cat_out_json: serde_json::Value = serde_json::Value::Object(
            total_cat_out_by_asset
                .into_iter()
                .map(|(aid, amt)| (format!("0x{}", hex::encode(aid)), amt.to_string().into()))
                .collect(),
        );

        Ok(serde_json::json!({
            "spends": spends_out,
            "summary": {
                "total_xch_out_external": total_xch_out_external.to_string(),
                "total_xch_change": total_xch_change.to_string(),
                "total_cat_out_by_asset": total_cat_out_json,
                "total_fee_mojos": total_fee.to_string(),
                "unknown_spend_count": unknown_count,
            },
        })
        .to_string())
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
        // Backwards-compat wrapper: run phase-1 (hint scan) then phase-2
        // (parent fetch + CLVM parse) in sequence and merge the outputs to
        // match the legacy response shape. JS callers that have not yet
        // migrated to the split endpoints keep working identically.
        let hints_json = self.asset_scan_hints(params_json).await?;
        let hints_val: serde_json::Value = serde_json::from_str(&hints_json)
            .map_err(|e| EngineError::Internal(format!("asset_scan_hints output: {e}")))?;

        let candidates = hints_val
            .get("candidates")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([]));
        let peak_height = hints_val.get("peak_height").cloned().unwrap_or(serde_json::Value::Null);
        let failed_hints = hints_val
            .get("failed_hints")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([]));
        let scanned_inner_hashes = hints_val
            .get("scanned_inner_hashes")
            .cloned()
            .unwrap_or_else(|| serde_json::json!(0));

        // Forward the original endpoint into the parse call so the parent
        // get_puzzle_and_solution requests hit the same network. Pull
        // `testnet` out of the inbound params so the wrapper response can
        // echo it back as before.
        #[derive(Deserialize)]
        struct EndpointAndTestnet {
            #[serde(default)]
            endpoint: Option<String>,
            #[serde(default)]
            testnet: bool,
        }
        let et: EndpointAndTestnet = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;

        let parse_req = serde_json::json!({
            "endpoint": et.endpoint,
            "candidates": candidates,
        });
        let parsed_json = self.nft_parse_candidates(&parse_req.to_string()).await?;
        let parsed_val: serde_json::Value = serde_json::from_str(&parsed_json)
            .map_err(|e| EngineError::Internal(format!("nft_parse_candidates output: {e}")))?;
        let nfts = parsed_val
            .get("nfts")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([]));

        Ok(serde_json::json!({
            "nfts": nfts,
            "scanned_inner_hashes": scanned_inner_hashes,
            "peak_height": peak_height,
            "testnet": et.testnet,
            "failed_hints": failed_hints,
        })
        .to_string())
    }

    /// Phase 1 of asset sync — discover unspent coins matched by the
    /// wallet's derived inner puzzle hashes, EXCLUDING XCH receives
    /// (which `scan_puzzle_hashes` handles separately).
    ///
    /// The returned `candidates[]` are asset-type-agnostic: each one is
    /// just a hint-matched coin record carrying the minimum data Phase 2
    /// needs (hint, coin, coin_id, confirmation status, derivation_index
    /// + derivation_kind). Phase-2 parsers (`nft_parse_candidates`,
    /// `cat_parse_candidates`) fetch the parent spend and try their
    /// respective SDK parser. Candidates that don't match either primitive
    /// are reported in `unparseable_coin_ids[]` so JS can drop them.
    ///
    /// Supersedes the legacy `nft_scan_hints` + `cat_scan_hints`, which
    /// were byte-identical apart from the log tag and made coinset fetch
    /// the same hints twice per sync cycle. Both legacy names still route
    /// here for backwards-compat.
    ///
    /// Designed to finish under Chrome MV3's 60-second service-worker
    /// cap even on deep wallets so JS can persist the raw candidate set
    /// before the SW gets killed and re-spawned for Phase 2.
    async fn asset_scan_hints(&self, params_json: &str) -> Result<String, EngineError> {
        #[derive(Deserialize)]
        struct ExtraInnerPh {
            puzzle_hash: String,
            derivation_index: u32,
            /// "unhardened" | "hardened" — defaults to "hardened" since the
            /// only reason JS pre-derives + injects is to cover the hardened
            /// path that the engine can't derive from `master_public_key`.
            #[serde(default = "default_hardened_kind")]
            kind: String,
        }
        fn default_hardened_kind() -> String {
            "hardened".to_string()
        }
        #[derive(Deserialize)]
        struct Req {
            #[serde(default)]
            fingerprint: Option<u32>,
            #[serde(default)]
            master_public_key: Option<String>,
            #[serde(default)]
            start: u32,
            #[serde(default = "default_asset_scan_count")]
            count: u32,
            #[serde(default)]
            testnet: bool,
            #[serde(default)]
            endpoint: Option<String>,
            /// Optional per-hint cursor map (`{ "0x<hint_hex>": <start_height> }`).
            /// Missing keys → full sweep from genesis (legacy behavior).
            #[serde(default)]
            hint_start_heights: Option<std::collections::HashMap<String, u32>>,
            /// Pre-derived inner puzzle hashes to fan out IN ADDITION to the
            /// ones the engine derives unhardened from `master_public_key`.
            #[serde(default)]
            extra_inner_phs: Vec<ExtraInnerPh>,
        }
        fn default_asset_scan_count() -> u32 {
            50
        }

        let _ = params_json; // suppress unused warning in case of early return
        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;
        if req.count == 0 || req.count > 200 {
            return Err(EngineError::InvalidParams(format!(
                "count must be 1..=200, got {}",
                req.count
            )));
        }
        let _ = req.testnet; // echo-back lives on the wrapper, not here
        let master_pk =
            self.resolve_master_pk(req.fingerprint, req.master_public_key.as_deref())?;

        // Inner puzzle hashes — same set used for XCH/CAT detection. Build a
        // parallel `ph → (index, kind)` map so candidates carry the
        // derivation hint forward.
        let mut inner_phs: Vec<Bytes32> = Vec::with_capacity(req.count as usize);
        let mut ph_meta: std::collections::HashMap<Bytes32, (u32, &'static str)> =
            std::collections::HashMap::new();
        for i in 0..req.count {
            let idx = req.start + i;
            let intermediate_pk = master_to_wallet_unhardened(&master_pk, idx);
            let synthetic_pk = intermediate_pk.derive_synthetic();
            let inner_ph: Bytes32 = StandardArgs::curry_tree_hash(synthetic_pk).into();
            inner_phs.push(inner_ph);
            ph_meta.entry(inner_ph).or_insert((idx, "unhardened"));
        }
        for extra in &req.extra_inner_phs {
            let ph = parse_bytes32(&extra.puzzle_hash)?;
            let kind: &'static str = match extra.kind.as_str() {
                "hardened" => "hardened",
                "unhardened" => "unhardened",
                other => {
                    return Err(EngineError::InvalidParams(format!(
                        "extra_inner_phs.kind must be 'hardened' or 'unhardened', got {other}"
                    )));
                }
            };
            if ph_meta.insert(ph, (extra.derivation_index, kind)).is_none() {
                inner_phs.push(ph);
            }
        }
        let inner_phs_set: std::collections::HashSet<Bytes32> =
            inner_phs.iter().copied().collect();

        let client = make_client(req.endpoint.as_deref());

        let hint_starts: &Option<std::collections::HashMap<String, u32>> =
            &req.hint_start_heights;
        let peak_opt: Option<u32> = client
            .get_blockchain_state()
            .await
            .ok()
            .and_then(|s| s.blockchain_state)
            .map(|bs| bs.peak.height);
        let extra_count: usize = req.extra_inner_phs.len();
        wlog(&format!(
            "[asset_scan_hints] start: req.start={} count={} extra_inner_phs={} inner_phs_total={}",
            req.start,
            req.count,
            extra_count,
            inner_phs.len()
        ));
        // Sequential per-hint fetch.
        //
        // Previously we used futures_util::future::join_all to fan all 5–10
        // hint requests out concurrently. In WASM that fan-out turned out to
        // be the root cause of mid-tick SW deaths: reqwest's fetch-backed
        // client allocates per-request buffers, and N concurrent requests
        // briefly pin Nx the working set. On long chains of chunks (each
        // chunk leaks a little to the WASM heap) we'd eventually hit the
        // wasm-bindgen 4 GiB cap and the runtime traps silently — no panic
        // hook fires, the SW just vanishes. Serializing the fetches caps
        // peak memory at one in-flight request and made the bug disappear.
        // Per-hint cost ~50 ms × 5 = 250 ms per chunk, which is fine since
        // the only "slow" thing was the unbounded concurrency.
        let mut hint_results: Vec<(Bytes32, Result<Vec<chia_wallet_sdk::coinset::CoinRecord>, String>)> =
            Vec::with_capacity(inner_phs.len());
        for hint in &inner_phs {
            let key = format!("0x{}", hex::encode(hint));
            let start_h = hint_starts.as_ref().and_then(|m| m.get(&key).copied());
            let res = fetch_hint_with_retry(
                &client,
                *hint,
                start_h,
                peak_opt,
                Some(false),
                false,
            )
            .await;
            hint_results.push((*hint, res));
        }

        let mut failed_hints: Vec<String> = Vec::new();
        let mut candidates: Vec<serde_json::Value> = Vec::new();
        for (hint, res) in hint_results {
            let recs = match res {
                Ok(r) => r,
                Err(e) => {
                    let hex_hint = format!("0x{}", hex::encode(hint));
                    tracing::warn!(
                        "asset_scan_hints: giving up on hint {} after {} attempts: {}",
                        hex_hint,
                        COINSET_RETRY_ATTEMPTS,
                        e
                    );
                    failed_hints.push(hex_hint);
                    continue;
                }
            };
            let mut per_hint_count = 0u32;
            for rec in recs {
                if inner_phs_set.contains(&rec.coin.puzzle_hash) {
                    continue; // XCH receive — covered elsewhere
                }
                if rec.spent {
                    continue;
                }
                let (deriv_idx, deriv_kind) = match ph_meta.get(&hint).copied() {
                    Some((i, k)) => (
                        serde_json::Value::from(i),
                        serde_json::Value::from(k),
                    ),
                    None => (serde_json::Value::Null, serde_json::Value::Null),
                };
                candidates.push(serde_json::json!({
                    "hint": format!("0x{}", hex::encode(hint)),
                    "coin": {
                        "parent_coin_info": format!("0x{}", hex::encode(rec.coin.parent_coin_info)),
                        "puzzle_hash": format!("0x{}", hex::encode(rec.coin.puzzle_hash)),
                        "amount": rec.coin.amount.to_string(),
                    },
                    "coin_id": format!("0x{}", hex::encode(rec.coin.coin_id())),
                    "confirmed_block_index": rec.confirmed_block_index,
                    "spent": rec.spent,
                    "spent_block_index": rec.spent_block_index,
                    "derivation_index": deriv_idx,
                    "derivation_kind": deriv_kind,
                }));
                per_hint_count += 1;
            }
            if per_hint_count > 0 {
                wlog(&format!(
                    "[asset_scan_hints] hint 0x{}: {} unspent candidates",
                    hex::encode(hint),
                    per_hint_count
                ));
            }
        }
        wlog(&format!(
            "[asset_scan_hints] total candidates: {}, wasm_heap={:.2}MB",
            candidates.len(),
            wasm_memory_bytes() as f64 / (1024.0 * 1024.0),
        ));

        Ok(serde_json::json!({
            "candidates": candidates,
            "peak_height": peak_opt,
            "failed_hints": failed_hints,
            "scanned_inner_hashes": inner_phs.len(),
        })
        .to_string())
    }

    /// Phase 2 of the split NFT scan — parse a list of pre-fetched
    /// candidates into NFT views.
    ///
    /// Input is the `candidates[]` array produced by `nft_scan_hints` (or
    /// a subset of it persisted by JS between SW lifetimes). The endpoint
    /// is taken from the request so JS can target the same network even
    /// though phase 1 may have run hours earlier on a different SW.
    ///
    /// Output mirrors the legacy `scan_nfts` `nfts[]` per-NFT shape so the
    /// downstream JSON writer doesn't have to know which phase produced
    /// each NFT. `unparseable_coin_ids[]` lets JS drop hinted coins that
    /// turned out to not be NFTs (e.g. CATs / DIDs) from its pending queue
    /// so it doesn't keep re-trying them on every wake.
    async fn nft_parse_candidates(
        &self,
        params_json: &str,
    ) -> Result<String, EngineError> {
        use chia_wallet_sdk::{
            chia::puzzle_types::nft::NftMetadata,
            clvm_traits::FromClvm,
            clvmr::serde::node_from_bytes,
            driver::{Nft, Puzzle, SpendContext},
        };

        #[derive(Deserialize)]
        struct CandidateCoin {
            parent_coin_info: String,
            puzzle_hash: String,
            amount: String,
        }
        #[derive(Deserialize)]
        struct Candidate {
            hint: String,
            coin: CandidateCoin,
            #[serde(default)]
            coin_id: Option<String>,
            #[serde(default)]
            confirmed_block_index: u32,
            #[serde(default)]
            spent: bool,
            #[serde(default)]
            spent_block_index: u32,
            #[serde(default)]
            derivation_index: serde_json::Value,
            #[serde(default)]
            derivation_kind: serde_json::Value,
        }
        #[derive(Deserialize)]
        struct Req {
            #[serde(default)]
            endpoint: Option<String>,
            candidates: Vec<Candidate>,
        }

        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;

        // Decode candidates into typed form once so we don't repeat hex
        // parsing in the spend loop.
        struct ParsedCandidate {
            hint: Bytes32,
            coin: chia_wallet_sdk::chia::protocol::Coin,
            coin_id: Bytes32,
            confirmed_block_index: u32,
            spent: bool,
            spent_block_index: u32,
            derivation_index: serde_json::Value,
            derivation_kind: serde_json::Value,
        }
        let mut parsed: Vec<ParsedCandidate> = Vec::with_capacity(req.candidates.len());
        for c in req.candidates {
            let hint = parse_bytes32(&c.hint)?;
            let parent = parse_bytes32(&c.coin.parent_coin_info)?;
            let puzzle_hash = parse_bytes32(&c.coin.puzzle_hash)?;
            let amount: u64 = c.coin.amount.parse().map_err(|e| {
                EngineError::InvalidParams(format!("coin.amount: {e}"))
            })?;
            let coin = chia_wallet_sdk::chia::protocol::Coin {
                parent_coin_info: parent,
                puzzle_hash,
                amount,
            };
            let coin_id = match c.coin_id.as_deref() {
                Some(s) => parse_bytes32(s)?,
                None => coin.coin_id(),
            };
            parsed.push(ParsedCandidate {
                hint,
                coin,
                coin_id,
                confirmed_block_index: c.confirmed_block_index,
                spent: c.spent,
                spent_block_index: c.spent_block_index,
                derivation_index: c.derivation_index,
                derivation_kind: c.derivation_kind,
            });
        }

        let client = make_client(req.endpoint.as_deref());
        wlog(&format!(
            "[nft_parse_candidates] {} candidates",
            parsed.len()
        ));

        // Batched parent record fetch.
        let parent_id_list: Vec<Bytes32> =
            parsed.iter().map(|p| p.coin.parent_coin_info).collect();
        let parent_map: std::collections::HashMap<
            Bytes32,
            chia_wallet_sdk::coinset::CoinRecord,
        > = if parent_id_list.is_empty() {
            std::collections::HashMap::new()
        } else {
            let recs = fetch_names_with_retry(&client, parent_id_list.clone(), Some(true))
                .await
                .map_err(|e| EngineError::Internal(format!("coinset parents: {e}")))?;
            recs.into_iter().map(|r| (r.coin.coin_id(), r)).collect()
        };

        let mut spend_fetches: Vec<(usize, Bytes32, u32)> = Vec::new();
        for (idx, p) in parsed.iter().enumerate() {
            let Some(parent_rec) = parent_map.get(&p.coin.parent_coin_info) else {
                continue;
            };
            if !parent_rec.spent {
                continue;
            }
            spend_fetches.push((idx, p.coin.parent_coin_info, parent_rec.spent_block_index));
        }

        let spends_results = futures_util::future::join_all(spend_fetches.iter().map(
            |(_, pid, h)| {
                let client = &client;
                let pid = *pid;
                let height = *h;
                async move { (pid, client.get_puzzle_and_solution(pid, Some(height)).await) }
            },
        ))
        .await;

        let mut nfts: Vec<serde_json::Value> = Vec::new();
        // Track which candidates produced a successful NFT parse — anything
        // not in this set ends up in `unparseable_coin_ids` for JS to drop.
        let mut parsed_ok: std::collections::HashSet<Bytes32> =
            std::collections::HashSet::new();

        for ((idx, _pid, _h), (_, spend_res)) in
            spend_fetches.into_iter().zip(spends_results.into_iter())
        {
            let p = &parsed[idx];
            let coin_id_hex = hex::encode(p.coin_id);
            let spend = match spend_res {
                Ok(s) => s,
                Err(_) => continue,
            };
            let Some(coin_spend) = spend.coin_solution else {
                continue;
            };
            wlog(&format!(
                "[nft_parse_candidates]   parse coin 0x{} (puzzle_reveal {}B, solution {}B)",
                &coin_id_hex[..16.min(coin_id_hex.len())],
                coin_spend.puzzle_reveal.as_ref().len(),
                coin_spend.solution.as_ref().len()
            ));

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
                _ => {
                    wlog(&format!(
                        "[nft_parse_candidates]   parse_child returned None for 0x{}",
                        &coin_id_hex[..16.min(coin_id_hex.len())]
                    ));
                    continue;
                }
            };

            // Match on coin_id — Nft::parse_child returns one child but its
            // coin should be the one we're looking at.
            if nft.coin.coin_id() != p.coin_id {
                continue;
            }

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
                "parent_coin_info": format!("0x{}", hex::encode(p.coin.parent_coin_info)),
                "puzzle_hash": format!("0x{}", hex::encode(p.coin.puzzle_hash)),
                "amount": p.coin.amount.to_string(),
                "metadata": metadata_json,
                "metadata_updater_puzzle_hash": format!("0x{}", hex::encode(nft.info.metadata_updater_puzzle_hash)),
                "current_owner_did": nft.info.current_owner.map(|d| format!("0x{}", hex::encode(d))),
                "royalty_puzzle_hash": format!("0x{}", hex::encode(nft.info.royalty_puzzle_hash)),
                "royalty_basis_points": nft.info.royalty_basis_points,
                "p2_puzzle_hash": format!("0x{}", hex::encode(nft.info.p2_puzzle_hash)),
                "hint": format!("0x{}", hex::encode(p.hint)),
                "derivation_index": p.derivation_index.clone(),
                "derivation_kind": p.derivation_kind.clone(),
                "confirmed_block_index": p.confirmed_block_index,
                "spent": p.spent,
                "spent_block_index": p.spent_block_index,
            }));
            parsed_ok.insert(p.coin_id);
        }

        let unparseable_coin_ids: Vec<String> = parsed
            .iter()
            .filter(|p| !parsed_ok.contains(&p.coin_id))
            .map(|p| format!("0x{}", hex::encode(p.coin_id)))
            .collect();

        let mem_mb = wasm_memory_bytes() as f64 / (1024.0 * 1024.0);
        wlog(&format!(
            "[nft_parse_candidates] DONE: {} nfts, {} unparseable; wasm_heap={:.2}MB",
            nfts.len(),
            unparseable_coin_ids.len(),
            mem_mb,
        ));

        Ok(serde_json::json!({
            "nfts": nfts,
            "unparseable_coin_ids": unparseable_coin_ids,
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
        // Backwards-compat wrapper: run phase-1 (hint scan) then phase-2
        // (parent fetch + Cat::parse_children) in sequence and merge the
        // outputs to match the legacy response shape.
        let hints_json = self.asset_scan_hints(params_json).await?;
        let hints_val: serde_json::Value = serde_json::from_str(&hints_json)
            .map_err(|e| EngineError::Internal(format!("asset_scan_hints output: {e}")))?;

        let candidates = hints_val
            .get("candidates")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([]));
        let peak_height = hints_val.get("peak_height").cloned().unwrap_or(serde_json::Value::Null);
        let failed_hints = hints_val
            .get("failed_hints")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([]));
        let scanned_inner_hashes = hints_val
            .get("scanned_inner_hashes")
            .cloned()
            .unwrap_or_else(|| serde_json::json!(0));

        #[derive(Deserialize)]
        struct EndpointAndTestnet {
            #[serde(default)]
            endpoint: Option<String>,
            #[serde(default)]
            testnet: bool,
        }
        let et: EndpointAndTestnet = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;

        let parse_req = serde_json::json!({
            "endpoint": et.endpoint,
            "candidates": candidates,
        });
        let parsed_json = self.cat_parse_candidates(&parse_req.to_string()).await?;
        let parsed_val: serde_json::Value = serde_json::from_str(&parsed_json)
            .map_err(|e| EngineError::Internal(format!("cat_parse_candidates output: {e}")))?;
        let cats = parsed_val
            .get("cats")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([]));

        Ok(serde_json::json!({
            "cats": cats,
            "scanned_inner_hashes": scanned_inner_hashes,
            "peak_height": peak_height,
            "testnet": et.testnet,
            "failed_hints": failed_hints,
        })
        .to_string())
    }


    /// Phase 2 of the split CAT scan — parse pre-fetched candidates into
    /// per-asset rollups.
    ///
    /// Does the batched parent record fetch, the concurrent
    /// `get_puzzle_and_solution` fanout over spent parents, and the
    /// `Cat::parse_children` decode. Candidates that can't be matched to a
    /// parsed CAT child (no lineage_proof, parent unparseable, etc.) end up
    /// in `unparseable_coin_ids` so JS can drop them from its pending queue.
    async fn cat_parse_candidates(
        &self,
        params_json: &str,
    ) -> Result<String, EngineError> {
        use chia_wallet_sdk::{
            clvmr::serde::node_from_bytes,
            driver::{Cat, Puzzle, SpendContext},
        };

        #[derive(Deserialize)]
        struct CandidateCoin {
            parent_coin_info: String,
            puzzle_hash: String,
            amount: String,
        }
        #[derive(Deserialize)]
        struct Candidate {
            hint: String,
            coin: CandidateCoin,
            #[serde(default)]
            coin_id: Option<String>,
            #[serde(default)]
            confirmed_block_index: u32,
            #[serde(default)]
            spent: bool,
            #[serde(default)]
            spent_block_index: u32,
            #[serde(default)]
            derivation_index: serde_json::Value,
            #[serde(default)]
            derivation_kind: serde_json::Value,
        }
        #[derive(Deserialize)]
        struct Req {
            #[serde(default)]
            endpoint: Option<String>,
            candidates: Vec<Candidate>,
        }

        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;

        struct ParsedCandidate {
            hint: Bytes32,
            coin: chia_wallet_sdk::chia::protocol::Coin,
            coin_id: Bytes32,
            confirmed_block_index: u32,
            spent: bool,
            spent_block_index: u32,
            derivation_index: serde_json::Value,
            derivation_kind: serde_json::Value,
        }
        let mut parsed_cands: Vec<ParsedCandidate> =
            Vec::with_capacity(req.candidates.len());
        for c in req.candidates {
            let hint = parse_bytes32(&c.hint)?;
            let parent = parse_bytes32(&c.coin.parent_coin_info)?;
            let puzzle_hash = parse_bytes32(&c.coin.puzzle_hash)?;
            let amount: u64 = c.coin.amount.parse().map_err(|e| {
                EngineError::InvalidParams(format!("coin.amount: {e}"))
            })?;
            let coin = chia_wallet_sdk::chia::protocol::Coin {
                parent_coin_info: parent,
                puzzle_hash,
                amount,
            };
            let coin_id = match c.coin_id.as_deref() {
                Some(s) => parse_bytes32(s)?,
                None => coin.coin_id(),
            };
            parsed_cands.push(ParsedCandidate {
                hint,
                coin,
                coin_id,
                confirmed_block_index: c.confirmed_block_index,
                spent: c.spent,
                spent_block_index: c.spent_block_index,
                derivation_index: c.derivation_index,
                derivation_kind: c.derivation_kind,
            });
        }

        let client = make_client(req.endpoint.as_deref());
        wlog(&format!(
            "[cat_parse_candidates] {} candidates",
            parsed_cands.len()
        ));

        // Batched parent record fetch over the deduped parent_id set.
        let unique_parent_ids: Vec<Bytes32> = {
            let mut seen = std::collections::HashSet::new();
            let mut out = Vec::new();
            for p in &parsed_cands {
                let pid = p.coin.parent_coin_info;
                if seen.insert(pid) {
                    out.push(pid);
                }
            }
            out
        };
        let parent_rec_map: std::collections::HashMap<
            Bytes32,
            chia_wallet_sdk::coinset::CoinRecord,
        > = if unique_parent_ids.is_empty() {
            std::collections::HashMap::new()
        } else {
            let recs = fetch_names_with_retry(&client, unique_parent_ids.clone(), Some(true))
                .await
                .map_err(|e| EngineError::Internal(format!("coinset parents: {e}")))?;
            recs.into_iter().map(|r| (r.coin.coin_id(), r)).collect()
        };

        let spent_parents: Vec<(Bytes32, u32)> = unique_parent_ids
            .iter()
            .filter_map(|pid| {
                let prec = parent_rec_map.get(pid)?;
                if !prec.spent {
                    return None;
                }
                Some((*pid, prec.spent_block_index))
            })
            .collect();
        let spend_results = futures_util::future::join_all(spent_parents.iter().map(
            |(pid, h)| {
                let client = &client;
                let pid = *pid;
                let height = *h;
                async move {
                    let r = client.get_puzzle_and_solution(pid, Some(height)).await;
                    (pid, r)
                }
            },
        ))
        .await;

        let mut by_asset: std::collections::HashMap<Bytes32, CatBucket> =
            std::collections::HashMap::new();
        let mut parent_cache: std::collections::HashMap<Bytes32, Option<Vec<Cat>>> =
            std::collections::HashMap::new();
        for pid in &unique_parent_ids {
            parent_cache.insert(*pid, None);
        }
        for (pid, spend_res) in spend_results {
            let spend = match spend_res {
                Ok(s) => s,
                Err(e) => {
                    return Err(EngineError::Internal(format!("coinset puzzle: {e}")));
                }
            };
            let Some(coin_spend) = spend.coin_solution else {
                continue;
            };
            let mut ctx = SpendContext::new();
            let puzzle_ptr = node_from_bytes(&mut *ctx, coin_spend.puzzle_reveal.as_ref())
                .map_err(|e| EngineError::Internal(format!("clvm puzzle: {e}")))?;
            let solution_ptr = node_from_bytes(&mut *ctx, coin_spend.solution.as_ref())
                .map_err(|e| EngineError::Internal(format!("clvm solution: {e}")))?;
            let parent_puzzle = Puzzle::parse(&ctx, puzzle_ptr);
            let parsed = Cat::parse_children(
                &mut *ctx,
                coin_spend.coin,
                parent_puzzle,
                solution_ptr,
            )
            .map_err(|e| EngineError::Internal(format!("Cat::parse_children: {e}")))?;
            parent_cache.insert(pid, parsed);
        }

        // Track which candidates produced a successful child match — anything
        // not in this set ends up in `unparseable_coin_ids` for JS to drop.
        let mut parsed_ok: std::collections::HashSet<Bytes32> =
            std::collections::HashSet::new();

        // Per-candidate carry of (deriv_idx, deriv_kind) — used by the
        // emission loop below since by_asset has already lost the link to
        // the original candidate index.
        let mut coin_deriv: std::collections::HashMap<
            Bytes32,
            (serde_json::Value, serde_json::Value),
        > = std::collections::HashMap::new();

        for p in &parsed_cands {
            let parent_id = p.coin.parent_coin_info;
            let children = parent_cache.get(&parent_id).cloned().flatten();
            let Some(children) = children else { continue };
            let Some(child) = children.iter().find(|c| c.coin.coin_id() == p.coin_id)
            else {
                continue;
            };
            let Some(lineage) = child.lineage_proof else {
                continue;
            };
            let bucket = by_asset
                .entry(child.info.asset_id)
                .or_insert_with(|| CatBucket {
                    asset_id: child.info.asset_id,
                    coins: Vec::new(),
                });
            bucket.coins.push(CatCoinView {
                coin_id: p.coin_id,
                parent_coin_info: p.coin.parent_coin_info,
                puzzle_hash: p.coin.puzzle_hash,
                amount: p.coin.amount,
                inner_puzzle_hash: child.info.p2_puzzle_hash,
                hidden_puzzle_hash: child.info.hidden_puzzle_hash,
                hint: p.hint,
                confirmed_block_index: p.confirmed_block_index,
                spent: p.spent,
                spent_block_index: p.spent_block_index,
                lineage_parent_name: lineage.parent_parent_coin_info,
                lineage_inner_puzzle_hash: lineage.parent_inner_puzzle_hash,
                lineage_amount: lineage.parent_amount,
            });
            coin_deriv.insert(
                p.coin_id,
                (p.derivation_index.clone(), p.derivation_kind.clone()),
            );
            parsed_ok.insert(p.coin_id);
        }

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
                        // Prefer the per-candidate derivation echo (carried
                        // verbatim through phase 1 → phase 2). Null when the
                        // candidate didn't carry it (legacy callers).
                        let (deriv_idx_v, deriv_kind_v) = coin_deriv
                            .get(&c.coin_id)
                            .cloned()
                            .unwrap_or((
                                serde_json::Value::Null,
                                serde_json::Value::Null,
                            ));
                        serde_json::json!({
                            "coin_id": format!("0x{}", hex::encode(c.coin_id)),
                            "parent_coin_info": format!("0x{}", hex::encode(c.parent_coin_info)),
                            "puzzle_hash": format!("0x{}", hex::encode(c.puzzle_hash)),
                            "amount": c.amount.to_string(),
                            "inner_puzzle_hash": format!("0x{}", hex::encode(c.inner_puzzle_hash)),
                            "hidden_puzzle_hash": c.hidden_puzzle_hash
                                .map(|h| format!("0x{}", hex::encode(h))),
                            "hint": format!("0x{}", hex::encode(c.hint)),
                            "derivation_index": deriv_idx_v,
                            "derivation_kind": deriv_kind_v,
                            "confirmed_block_index": c.confirmed_block_index,
                            "spent": c.spent,
                            "spent_block_index": c.spent_block_index,
                            "lineage_proof": {
                                "parent_name": format!("0x{}", hex::encode(c.lineage_parent_name)),
                                "inner_puzzle_hash": format!("0x{}", hex::encode(c.lineage_inner_puzzle_hash)),
                                "amount": c.lineage_amount.to_string(),
                            },
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

        let unparseable_coin_ids: Vec<String> = parsed_cands
            .iter()
            .filter(|p| !parsed_ok.contains(&p.coin_id))
            .map(|p| format!("0x{}", hex::encode(p.coin_id)))
            .collect();

        wlog(&format!(
            "[cat_parse_candidates] DONE: {} assets, {} unparseable",
            cats.len(),
            unparseable_coin_ids.len(),
        ));

        Ok(serde_json::json!({
            "cats": cats,
            "unparseable_coin_ids": unparseable_coin_ids,
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
        // Oleada-2 multi-output: each entry maps 1:1 to a CREATE_COIN on the
        // head spend. No memos here — callers that need memos use the legacy
        // single-output mode (recipient_address + amount_mojos).
        #[derive(Deserialize)]
        struct OutputSpec {
            address: String,
            amount: String,
        }
        #[derive(Deserialize)]
        struct Req {
            fingerprint: u32,
            // Legacy single-output mode. Either (recipient_address+amount_mojos)
            // or `outputs` MUST be present, never both.
            #[serde(default)]
            recipient_address: Option<String>,
            #[serde(default)]
            amount_mojos: Option<String>,
            // New multi-output mode (Oleada 2). Each entry becomes one
            // CREATE_COIN on the head spend. Use for bulkSendXch/combine/split.
            #[serde(default)]
            outputs: Option<Vec<OutputSpec>>,
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
        // Resolve to a unified Vec<(recipient_ph, amount, memos)> regardless
        // of which input shape the caller used.
        struct ParsedOutput {
            ph: Bytes32,
            amount: u64,
        }
        let mut outputs: Vec<ParsedOutput> = Vec::new();
        match (&req.outputs, &req.recipient_address, &req.amount_mojos) {
            (Some(outs), None, None) => {
                if outs.is_empty() {
                    return Err(EngineError::InvalidParams(
                        "outputs is empty — provide at least one entry".to_string(),
                    ));
                }
                if outs.len() > 25 {
                    return Err(EngineError::InvalidParams(format!(
                        "too many outputs ({}), max 25 per bundle",
                        outs.len()
                    )));
                }
                for (i, o) in outs.iter().enumerate() {
                    let amt: u64 = o.amount.parse().map_err(|_| {
                        EngineError::InvalidParams(format!(
                            "outputs[{i}].amount must be u64"
                        ))
                    })?;
                    if amt == 0 {
                        return Err(EngineError::InvalidParams(format!(
                            "outputs[{i}].amount must be > 0"
                        )));
                    }
                    let addr = Address::decode(o.address.trim()).map_err(|e| {
                        EngineError::InvalidParams(format!("outputs[{i}].address: {e}"))
                    })?;
                    outputs.push(ParsedOutput {
                        ph: addr.puzzle_hash,
                        amount: amt,
                    });
                }
            }
            (None, Some(addr), Some(amount_str)) => {
                let amt: u64 = amount_str.parse().map_err(|_| {
                    EngineError::InvalidParams("amount_mojos must be u64".to_string())
                })?;
                if amt == 0 {
                    return Err(EngineError::InvalidParams(
                        "amount_mojos must be > 0".to_string(),
                    ));
                }
                let recipient = Address::decode(addr.trim())
                    .map_err(|e| EngineError::InvalidParams(format!("recipient: {e}")))?;
                outputs.push(ParsedOutput {
                    ph: recipient.puzzle_hash,
                    amount: amt,
                });
            }
            (Some(_), Some(_), _) | (Some(_), _, Some(_)) => {
                return Err(EngineError::InvalidParams(
                    "send_xch: pass either `outputs` OR (`recipient_address` + `amount_mojos`), not both"
                        .to_string(),
                ));
            }
            _ => {
                return Err(EngineError::InvalidParams(
                    "send_xch needs `outputs` or (`recipient_address` + `amount_mojos`)"
                        .to_string(),
                ));
            }
        };

        let fee: u64 = req
            .fee_mojos
            .parse()
            .map_err(|_| EngineError::InvalidParams("fee_mojos must be u64".to_string()))?;
        // total_output_amount + fee = what we need from inputs.
        let mut total_output: u64 = 0;
        for o in &outputs {
            total_output = total_output
                .checked_add(o.amount)
                .ok_or_else(|| EngineError::InvalidParams("output sum overflow".to_string()))?;
        }
        let needed = total_output
            .checked_add(fee)
            .ok_or_else(|| EngineError::InvalidParams("total + fee overflow".to_string()))?;

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

        let change_intermediate_sk = master_to_wallet_unhardened(&master_sk, req.change_index);
        let change_synthetic_pk = change_intermediate_sk.derive_synthetic().public_key();
        let change_ph: Bytes32 = StandardArgs::curry_tree_hash(change_synthetic_pk).into();

        // 2. Build conditions
        // First coin: every output + reserve_fee + assert_concurrent_spend for the rest.
        // Other coins: assert_concurrent_spend back to the first.
        let mut ctx = SpendContext::new();

        let (head_coin, head_sk, head_pk, _) = parsed[0].clone();
        let head_coin_id = head_coin.coin_id();

        let mut head_conditions = Conditions::new();
        for o in &outputs {
            head_conditions = head_conditions.create_coin(
                o.ph,
                o.amount,
                ::chia_wallet_sdk::chia::puzzle_types::Memos::None,
            );
        }
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

    /// Hardened variant of `derive_addresses`. Requires the wallet to be
    /// unlocked because hardened derivation needs the SECRET key (you
    /// cannot derive a hardened child from a public key alone).
    ///
    /// Mirrors `derive_addresses` but uses `master_to_wallet_hardened(sk, idx)`
    /// → `derive_synthetic()` → `StandardArgs::curry_tree_hash`. The Sage
    /// reference wallet stores BOTH the hardened and unhardened sets in its
    /// derivation table (see
    /// `vendor/sage/crates/sage-wallet/src/wallet/signing.rs` lines 52-53),
    /// and on-chain receives can land at either kind of puzzle hash.
    ///
    /// Params: `{ "fingerprint": N, "start": K, "count": M, "testnet": bool }`.
    /// Returns: `{ "addresses": [{ index, address, puzzle_hash, public_key }] }`.
    ///
    /// Errors:
    /// - `Unauthorized` (code 4001) if the wallet is locked or `fingerprint`
    ///   is missing — `"wallet not unlocked"`.
    async fn derive_addresses_hardened(
        &self,
        params_json: &str,
    ) -> Result<String, EngineError> {
        #[derive(Deserialize)]
        struct Req {
            #[serde(default)]
            fingerprint: Option<u32>,
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
        let fp = req
            .fingerprint
            .ok_or_else(|| EngineError::Unauthorized("wallet not unlocked".to_string()))?;
        let master_sk = self
            .unlocked
            .lock()
            .map_err(|_| EngineError::Internal("unlocked-cache mutex poisoned".to_string()))?
            .get(&fp)
            .cloned()
            .ok_or_else(|| EngineError::Unauthorized("wallet not unlocked".to_string()))?;
        let prefix = if req.testnet { "txch" } else { "xch" };
        let mut out = Vec::with_capacity(req.count as usize);
        for i in 0..req.count {
            let idx = req.start + i;
            let intermediate_sk = master_to_wallet_hardened(&master_sk, idx);
            let synthetic_sk = intermediate_sk.derive_synthetic();
            let synthetic_pk = synthetic_sk.public_key();
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

    /// Import a wallet from a raw BLS master secret key (32-byte hex).
    /// Encrypts it with the password into a new keychain blob, returns the
    /// fingerprint + master_public_key + blob the same way `import_key` does.
    ///
    /// Params: `{ "secret_key": "0x<64 hex>", "password": "...", "testnet"?: bool, "name"?: "..." }`
    async fn import_secret_key(&self, params_json: &str) -> Result<String, EngineError> {
        #[derive(Deserialize)]
        struct Req {
            secret_key: String,
            password: String,
            #[serde(default)]
            testnet: bool,
            #[serde(default)]
            name: Option<String>,
        }
        let req: Req = serde_json::from_str(params_json)
            .map_err(|e| EngineError::InvalidParams(e.to_string()))?;

        let sk_bytes = hex::decode(req.secret_key.trim().trim_start_matches("0x"))
            .map_err(|e| EngineError::InvalidParams(format!("secret_key hex: {e}")))?;
        if sk_bytes.len() != 32 {
            return Err(EngineError::InvalidParams(format!(
                "secret_key must be 32 bytes, got {}",
                sk_bytes.len()
            )));
        }
        let master_sk = SecretKey::from_bytes(
            sk_bytes
                .as_slice()
                .try_into()
                .map_err(|_| EngineError::InvalidParams("secret_key length".to_string()))?,
        )
        .map_err(|e| EngineError::InvalidParams(format!("secret_key parse: {e}")))?;

        let mut keychain = Keychain::default();
        let fingerprint = keychain
            .add_secret_key(&master_sk, req.password.as_bytes())
            .map_err(|e| EngineError::Internal(e.to_string()))?;
        let blob = keychain
            .to_bytes()
            .map_err(|e| EngineError::Internal(e.to_string()))?;

        let intermediate_pk = master_to_wallet_unhardened(&master_sk.public_key(), 0);
        let synthetic_pk = intermediate_pk.derive_synthetic();
        let puzzle_hash: Bytes32 = StandardArgs::curry_tree_hash(synthetic_pk).into();
        let prefix = if req.testnet { "txch" } else { "xch" };
        let address_0 = Address::new(puzzle_hash, prefix.to_string())
            .encode()
            .map_err(|e| EngineError::Internal(format!("bech32m: {e}")))?;

        Ok(serde_json::json!({
            "fingerprint": fingerprint,
            "master_public_key": format!("0x{}", hex::encode(master_sk.public_key().to_bytes())),
            "keychain_blob": hex::encode(&blob),
            "address_0": address_0,
            "name": req.name,
            "has_mnemonic": false,
        })
        .to_string())
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

/// Number of attempts for transient coinset HTTP errors. Coinset will return
/// "error decoding response body" mid-stream for hints with very deep
/// history; an immediate retry usually clears it. We don't sleep between
/// attempts — adding a sleep primitive that works in WASM would require a
/// new dep (futures-timer / wasm-timer), and 3 back-to-back retries
/// already deflakes the vast majority of transient errors we've seen.
const COINSET_RETRY_ATTEMPTS: usize = 3;

/// Block window size (in heights) used to paginate `get_coin_records_by_hint`
/// per hint. Even with `include_spent_coins: false`, a single hint that has
/// been receiving CATs / NFTs for years can produce a giant response and
/// OOM the WASM heap (or trigger coinset's "error decoding response body"
/// mid-stream). Walking the height range in chunks bounds each HTTP
/// response. ~500k blocks ≈ 50 days @ ~6s/block on mainnet — tune later
/// based on observed response sizes.
const HEIGHT_WINDOW: u32 = 500_000;

/// Fetch coin records for a single hint.
///
/// When `windowed == false` (NFT scans): a single open-ended call to
/// `get_coin_records_by_hint(hint, start_h, None, include_spent)`. NFTs
/// are singletons (one coin per launcher), so the response size is
/// bounded regardless of history depth and windowing only adds
/// round-trips. This is the original fast path.
///
/// When `windowed == true` (CAT scans): walks the height range
/// **newest-first** (peak → floor) in `HEIGHT_WINDOW`-sized chunks, and
/// fires all chunks **in parallel** via `join_all`. The floor is
/// `start_h.unwrap_or(0)` — i.e. the cursor JS persisted from a
/// previous scan, or genesis on first run. Windowing is needed for CATs
/// because a hint with years of receipts can return thousands of
/// records and OOM the WASM heap (or trigger coinset's "error decoding
/// response body" mid-stream); parallelizing the windows keeps the
/// scan latency-bounded by the slowest window rather than the sum of
/// all windows.
///
/// Each window gets up to 3 attempts. On total failure of ANY window
/// returns `Err(last_error_string)` so the caller can decide how to
/// surface the failure (e.g. push the hint into `failed_hints` rather
/// than killing the whole chunk). When multiple windows fail, the
/// first error (newest window) is reported — matches the existing
/// "bail on first failed window" behavior from the previous serial
/// implementation.
///
/// Records are aggregated peak-first so the UX "newest receipts appear
/// first" feel still holds even though the underlying fetches finish
/// out of order.
async fn fetch_hint_with_retry(
    client: &CoinsetClient,
    hint: Bytes32,
    start_h: Option<u32>,
    peak: Option<u32>,
    include_spent: Option<bool>,
    windowed: bool,
) -> Result<Vec<chia_wallet_sdk::coinset::CoinRecord>, String> {
    wlog(&format!(
        "[scan_nfts/fetch] 0x{} start={:?} windowed={}",
        hex::encode(hint),
        start_h,
        windowed,
    ));
    if !windowed || peak.is_none() {
        let r = fetch_hint_window_with_retry(client, hint, start_h, None, include_spent).await;
        wlog(&format!(
            "[scan_nfts/fetch] 0x{} done: {}",
            hex::encode(hint),
            match &r { Ok(v) => format!("{} records", v.len()), Err(e) => format!("ERR {e}") },
        ));
        return r;
    }
    let peak = peak.expect("peak checked above");

    let floor = start_h.unwrap_or(0);
    // Build the [from, to] ranges peak → floor newest-first. Order is
    // preserved through aggregation so the caller still sees newest
    // records first.
    let mut ranges: Vec<(u32, u32)> = Vec::new();
    let mut to = peak;
    while to > floor {
        let from = to.saturating_sub(HEIGHT_WINDOW).max(floor);
        ranges.push((from, to));
        if from == floor {
            break;
        }
        // Step one block past the window edge so we don't double-count
        // `from` on the next iteration.
        to = from.saturating_sub(1);
    }

    // Serialize windowed fetches.
    //
    // We used to fan all windows out via join_all, but concurrent reqwest
    // calls in wasm32 turned out to push the heap past wasm-bindgen's
    // 4 GiB ceiling on long sync runs — the SW would die silently with no
    // panic-hook output. See nft_scan_hints for the full diagnosis. The
    // throughput cost is small because each window still has its own
    // 3-retry budget and the per-window response is normally tiny.
    let mut window_results: Vec<Result<Vec<chia_wallet_sdk::coinset::CoinRecord>, String>> =
        Vec::with_capacity(ranges.len());
    for (from, to) in &ranges {
        let res =
            fetch_hint_window_with_retry(client, hint, Some(*from), Some(*to), include_spent)
                .await;
        window_results.push(res);
    }

    // Aggregate in peak-first order; propagate the first (newest)
    // window error if any window exhausted retries.
    let mut all_records: Vec<chia_wallet_sdk::coinset::CoinRecord> = Vec::new();
    for ((from, to), res) in ranges.iter().zip(window_results.into_iter()) {
        match res {
            Ok(recs) => all_records.extend(recs),
            Err(e) => return Err(format!("window [{from}..{to}]: {e}")),
        }
    }
    Ok(all_records)
}

/// Inner helper: single windowed call to `get_coin_records_by_hint` with
/// up to 3 attempts. Pulled out of `fetch_hint_with_retry` so the retry
/// loop is shared between the windowed path and the (rare) "no peak"
/// fallback.
async fn fetch_hint_window_with_retry(
    client: &CoinsetClient,
    hint: Bytes32,
    start_h: Option<u32>,
    end_h: Option<u32>,
    include_spent: Option<bool>,
) -> Result<Vec<chia_wallet_sdk::coinset::CoinRecord>, String> {
    let mut last_err = String::new();
    for attempt in 0..COINSET_RETRY_ATTEMPTS {
        match client
            .get_coin_records_by_hint(hint, start_h, end_h, include_spent)
            .await
        {
            Ok(res) => return Ok(res.coin_records.unwrap_or_default()),
            Err(e) => {
                last_err = format!("{e}");
                tracing::debug!(
                    "get_coin_records_by_hint attempt {} failed for hint 0x{} [{:?}..{:?}]: {}",
                    attempt + 1,
                    hex::encode(hint),
                    start_h,
                    end_h,
                    last_err
                );
            }
        }
    }
    Err(last_err)
}

/// Batched parent-record fetch with up to 3 attempts. Same rationale as
/// `fetch_hint_with_retry`: a single transient HTTP error on the parents
/// call would otherwise nuke the whole chunk after we just spent N
/// round-trips on hints. On total failure returns the last error string.
async fn fetch_names_with_retry(
    client: &CoinsetClient,
    names: Vec<Bytes32>,
    include_spent: Option<bool>,
) -> Result<Vec<chia_wallet_sdk::coinset::CoinRecord>, String> {
    let mut last_err = String::new();
    for attempt in 0..COINSET_RETRY_ATTEMPTS {
        match client
            .get_coin_records_by_names(names.clone(), None, None, include_spent)
            .await
        {
            Ok(res) => return Ok(res.coin_records.unwrap_or_default()),
            Err(e) => {
                last_err = format!("{e}");
                tracing::debug!(
                    "get_coin_records_by_names attempt {} failed ({} names): {}",
                    attempt + 1,
                    names.len(),
                    last_err
                );
            }
        }
    }
    Err(last_err)
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
    hidden_puzzle_hash: Option<Bytes32>,
    hint: Bytes32,
    confirmed_block_index: u32,
    spent: bool,
    spent_block_index: u32,
    /// LineageProof needed to spend this CAT. Captured at parse time so the
    /// JS side can hand it back to `send_cat` without re-fetching the parent.
    lineage_parent_name: Bytes32,
    lineage_inner_puzzle_hash: Bytes32,
    lineage_amount: u64,
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
