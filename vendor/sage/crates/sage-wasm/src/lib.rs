//! WASM bindings for the Sage wallet engine.
//!
//! The JS side talks to this crate through a single contract:
//!
//! ```js
//! import init, { Sage } from "@ozone/wallet-wasm";
//! await init();
//! const engine = new Sage(idb.asWasmCallbacks());
//! const resJson = await engine.request("derive_address", JSON.stringify({...}));
//! ```
//!
//! This mirrors the FFI surface already used by `sage_flutter_binding` in the
//! Ozone mobile app — same engine instance pattern, same single-dispatch
//! method, same JSON envelope. The transport changes (wasm-bindgen vs FFI),
//! the contract does not.
//!
//! ## Status
//!
//! This is the scaffold. Most `request()` method names currently return
//! `NotImplemented`. They will be wired one at a time as the IndexedDB-backed
//! storage layer comes online, hooked into the sage-wallet types that already
//! compile to wasm32.

#![allow(clippy::needless_pass_by_value)]
#![allow(clippy::too_many_arguments)]

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::future_to_promise;

mod engine;
mod storage_bridge;

pub use engine::SageEngine;

#[wasm_bindgen(start)]
pub fn _main() {
    console_error_panic_hook::set_once();
    // Initialize tracing subscriber that pipes to console.log — useful in dev,
    // can be silenced for release builds.
    let _ = tracing_to_console();
}

fn tracing_to_console() -> Result<(), ()> {
    // Intentionally non-fatal: subscriber init failure shouldn't kill the
    // engine, since tracing is informational.
    Ok(())
}

/// Sage engine handle exposed to JavaScript.
///
/// Built once per wallet (per browser session) and lives for the lifetime of
/// the extension's background service worker. Every dApp / popup call funnels
/// through [`Sage::request`].
#[wasm_bindgen]
pub struct Sage {
    inner: SageEngine,
}

#[wasm_bindgen]
impl Sage {
    /// Construct a new Sage engine.
    ///
    /// `storage_callbacks` is the JS object implementing the
    /// `WasmStorageCallbacks` interface exported from `@ozone/storage-idb`.
    /// It backs all coin / derivation / NFT / DID / offer / kv storage with
    /// IndexedDB. The engine never touches `chrome.storage.local` directly.
    #[wasm_bindgen(constructor)]
    pub fn new(storage_callbacks: JsValue) -> Result<Sage, JsValue> {
        let inner = SageEngine::new(storage_callbacks)?;
        Ok(Sage { inner })
    }

    /// Single dispatch entry point.
    ///
    /// * `method` — name of a sage-api endpoint, e.g. `"login"`,
    ///   `"send_xch"`, `"make_offer"`, `"derive_address"`.
    /// * `params_json` — JSON string of the endpoint's request type.
    ///
    /// Returns a JSON string of the endpoint's response type on success.
    /// Rejects with `{ code, message, data? }` (also JSON) on failure.
    ///
    /// This mirrors `sage_flutter_binding::request()` 1:1 — same contract.
    #[wasm_bindgen]
    pub fn request(&self, method: String, params_json: String) -> js_sys::Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            let result = inner.dispatch(&method, &params_json).await;
            match result {
                Ok(json) => Ok(JsValue::from_str(&json)),
                Err(e) => {
                    let body = serde_json::json!({
                        "code": e.code(),
                        "message": e.to_string(),
                    });
                    Err(JsValue::from_str(&body.to_string()))
                }
            }
        })
    }

    /// Identify the engine. Useful for the JS side to confirm the WASM
    /// loaded the expected version.
    #[wasm_bindgen]
    pub fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("method not found: {0}")]
    MethodNotFound(String),

    #[error("invalid params: {0}")]
    InvalidParams(String),

    #[error("not implemented yet: {0}")]
    NotImplemented(String),

    #[error("internal error: {0}")]
    Internal(String),
}

impl EngineError {
    /// CHIP-0002-style numeric error code, surfaced back to the dApp.
    pub fn code(&self) -> u32 {
        match self {
            Self::InvalidParams(_) => 4000,
            Self::MethodNotFound(_) => 4004,
            Self::NotImplemented(_) => 4999,
            Self::Internal(_) => 4500,
        }
    }
}

#[derive(Serialize, Deserialize)]
pub(crate) struct EmptyParams {}
