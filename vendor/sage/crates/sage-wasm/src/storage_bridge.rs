//! Bridge from the WASM engine to JS-side IndexedDB storage callbacks.
//!
//! Mirrors the trait `WasmStorageCallbacks` defined in
//! `ozone-web-extension/packages/storage-idb/`. Each method on the JS callbacks
//! object is invoked through wasm-bindgen's `Reflect::get` / `Reflect::apply`,
//! and the returned Promise is awaited.
//!
//! ## Why callbacks instead of a Rust trait
//!
//! sage-wallet's existing `Database` API is concrete (`Database` struct), not
//! a trait. Rather than refactor every call site to be generic, we keep the
//! struct and replace its body with delegate calls into this bridge. That
//! lets the JS side own the SQLite-replacement (IndexedDB) without sage-wallet
//! needing to know.
//!
//! ## Status
//!
//! Skeleton. The actual delegation functions live alongside the
//! `#[cfg(not(feature = "sqlite"))] impl Database { ... }` stubs in
//! sage-database. As each stub gets a real JS-callback delegation, the
//! corresponding wrapper goes here.

use wasm_bindgen::prelude::*;

/// Opaque handle wrapping the JS callbacks object.
///
/// Cloning is cheap — `JsValue` is reference-counted from JS's side.
#[derive(Debug, Clone)]
pub struct JsStorage {
    callbacks: JsValue,
}

impl JsStorage {
    /// Wrap the JS callbacks object handed in from `new Sage(callbacks)`.
    pub fn from_js(callbacks: JsValue) -> Result<Self, JsValue> {
        if !callbacks.is_object() {
            return Err(JsValue::from_str(
                "Sage::new: storage_callbacks must be an object",
            ));
        }
        Ok(Self { callbacks })
    }

    /// Raw access to the underlying JS handle, for direct `Reflect::get` calls
    /// from individual delegate implementations.
    pub fn handle(&self) -> &JsValue {
        &self.callbacks
    }
}
