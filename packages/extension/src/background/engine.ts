// Lazy WASM engine bootstrap.
//
// The service worker is killed after ~30s of idle in MV3, so we instantiate
// the engine on-demand and cache it as a module-scoped singleton. When the SW
// wakes up, the first call to `getEngine()` re-loads the WASM module.
//
// We always boot SOMETHING: stateless methods (ping, generate_mnemonic,
// decode_address, sync_tick, etc.) must work before any wallet is unlocked,
// so we use a "_bootstrap_" placeholder IndexedDB until the user picks /
// creates a wallet. Once `setActiveWallet(fingerprint)` is called we tear
// the bootstrap engine down and recreate it bound to that wallet's DB.

import init, { Sage } from "@ozone/wallet-wasm";
import { IdbStorage } from "@ozone/storage-idb";

const BOOTSTRAP_WALLET_ID = "_bootstrap_";

let enginePromise: Promise<Sage> | null = null;
let currentWalletId: string = BOOTSTRAP_WALLET_ID;

/**
 * Bind the engine to a wallet id. For now we keep ONE engine instance for
 * the lifetime of the SW — the unlocked SecretKey is keyed by fingerprint
 * inside the WASM module itself, so the same engine serves multiple wallets
 * cleanly without losing unlock state. The walletId tracking here exists so
 * a future multi-wallet IndexedDB swap can hook in without rewiring callers.
 */
export function setActiveWallet(walletId: string | null): void {
  currentWalletId = walletId ?? BOOTSTRAP_WALLET_ID;
}

export async function getEngine(): Promise<Sage> {
  if (!enginePromise) {
    const walletId = currentWalletId;
    enginePromise = (async () => {
      await init();
      const storage = await IdbStorage.open(walletId);
      return new Sage(storage.asWasmCallbacks());
    })();
  }
  return enginePromise;
}

/**
 * Convenience wrapper: serialize params, call request(), parse the response.
 * Errors thrown by the WASM side carry { code, message } as JSON; we re-throw
 * an Error subclass with the same shape so the rpc-router can forward it.
 */
export async function callEngine<T = unknown>(
  method: string,
  params: unknown,
): Promise<T> {
  const engine = await getEngine();
  try {
    const json = await engine.request(method, JSON.stringify(params ?? {}));
    return JSON.parse(json) as T;
  } catch (rejected) {
    // wasm-bindgen rejects with a JsValue. Could be a string, an Error, or a
    // plain object — depending on the wasm-bindgen version + how the engine
    // serialized. Normalize to an Error with the inner {code, message} so
    // dApps see real CHIP-0002 error codes instead of a wrapped -32603.
    const tryParse = (s: string) => {
      try {
        return JSON.parse(s) as { code?: number; message?: string };
      } catch {
        return null;
      }
    };

    let parsed: { code?: number; message?: string } | null = null;
    let raw: string;
    if (typeof rejected === "string") {
      raw = rejected;
      parsed = tryParse(rejected);
    } else if (rejected instanceof Error) {
      raw = rejected.message;
      // Engine often throws `new Error("{...json...}")`.
      parsed = tryParse(rejected.message);
    } else if (typeof rejected === "object" && rejected !== null) {
      raw = String(rejected);
      // wasm-bindgen may serialize a struct {code, message} as a plain object.
      const obj = rejected as { code?: number; message?: string };
      if (typeof obj.message === "string") {
        parsed = { code: obj.code, message: obj.message };
      }
    } else {
      raw = String(rejected);
    }

    const err = new Error(parsed?.message ?? raw) as Error & { code?: number };
    if (typeof parsed?.code === "number") err.code = parsed.code;
    throw err;
  }
}
