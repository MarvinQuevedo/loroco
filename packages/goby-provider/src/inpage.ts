// Inpage script — runs in MAIN world of every page. Defines window.chia.
// Talks to the content script via window.postMessage.

import {
  type ChainId,
  type ChiaEvent,
  type ChiaMethod,
  type ChiaMethodMap,
  type ChiaWallet,
  CONTENT_TARGET,
  PAGE_TARGET,
  type PageEventMessage,
  type PageResponseMessage,
  type RequestArguments,
} from "./types.js";

const NAME = "Loroco";
const VERSION = "0.0.1";
const API_VERSION = "1.0.0";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

const pending = new Map<number, Pending>();
const listeners = new Map<ChiaEvent, Set<(...args: any[]) => void>>();
let nextId = 1;

let _chainId: ChainId | undefined;
let _selectedAddress: string | undefined;
let _connected = false;

function postRequest<M extends ChiaMethod>(
  method: M,
  params: ChiaMethodMap[M]["params"],
): Promise<ChiaMethodMap[M]["result"]> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    window.postMessage(
      {
        target: CONTENT_TARGET,
        id,
        origin: window.location.origin,
        method,
        params,
      },
      window.location.origin,
    );
  });
}

window.addEventListener("message", (ev: MessageEvent) => {
  if (ev.source !== window) return;
  const data = ev.data;
  if (!data || data.target !== PAGE_TARGET) return;

  // Response to a request
  if (typeof (data as PageResponseMessage).id === "number") {
    const msg = data as PageResponseMessage;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) {
      const err = new Error(msg.error.message) as Error & {
        code?: number;
        data?: unknown;
      };
      err.code = msg.error.code;
      err.data = msg.error.data;
      p.reject(err);
    } else {
      p.resolve(msg.result);
    }
    return;
  }

  // Server-pushed event
  if ((data as PageEventMessage).event) {
    const msg = data as PageEventMessage;
    if (msg.event === "chainChanged") {
      _chainId = (msg.payload as { chainId: ChainId }).chainId;
    }
    if (msg.event === "accountChanged") {
      _selectedAddress = undefined; // dApp must re-fetch
    }
    const set = listeners.get(msg.event);
    if (set) {
      for (const fn of set) {
        try {
          fn(msg.payload);
        } catch (e) {
          console.error("[Loroco] event listener threw", e);
        }
      }
    }
  }
});

// Helper used by both `request()` and the Goby-legacy direct methods.
async function call<M extends ChiaMethod>(
  method: M,
  params?: ChiaMethodMap[M]["params"],
): Promise<ChiaMethodMap[M]["result"]> {
  const result = (await postRequest(method, params as ChiaMethodMap[M]["params"])) as
    ChiaMethodMap[M]["result"];
  if (method === "connect") _connected = Boolean(result);
  return result;
}

/**
 * The provider object.
 *
 * Surfaces THREE shapes for maximum dApp compatibility:
 *   1. CHIP-0002 standard: `provider.request({method, params})`.
 *   2. EVM-style discovery flags: `isGoby`, `isLoroco`, `name`, `version`.
 *   3. Goby-legacy direct methods: `provider.connect()`, `provider.getPublicKeys()`,
 *      `provider.signMessage()`, etc. These mirror Goby's pre-CHIP-0002 API and
 *      are required by dApps (dexie.space, tibetswap, …) whose integration code
 *      calls the methods directly instead of through `request()`.
 */
const provider: ChiaWallet = {
  name: NAME,
  version: VERSION,
  apiVersion: API_VERSION,
  isGoby: true,
  isLoroco: true,

  get chainId() {
    return _chainId;
  },
  get selectedAddress() {
    return _selectedAddress;
  },
  isConnected() {
    return _connected;
  },

  async request<M extends ChiaMethod>(args: RequestArguments<M>) {
    return call(args.method, args.params as ChiaMethodMap[typeof args.method]["params"]);
  },

  // ── Goby-legacy direct methods ──────────────────────────────────────────
  // Each is a thin wrapper around `request({method, params})`. Goby's older
  // (pre-CHIP-0002) API exposed these as object methods, and integrations
  // built against that surface still call them directly.
  connect(params?: ChiaMethodMap["connect"]["params"]) {
    return call("connect", params);
  },
  walletSwitchChain(params: ChiaMethodMap["walletSwitchChain"]["params"]) {
    return call("walletSwitchChain", params);
  },
  walletWatchAsset(params: ChiaMethodMap["walletWatchAsset"]["params"]) {
    return call("walletWatchAsset", params);
  },
  getPublicKeys(params?: ChiaMethodMap["getPublicKeys"]["params"]) {
    return call("getPublicKeys", params);
  },
  filterUnlockedCoins(params: ChiaMethodMap["filterUnlockedCoins"]["params"]) {
    return call("filterUnlockedCoins", params);
  },
  getAssetCoins(params: ChiaMethodMap["getAssetCoins"]["params"]) {
    return call("getAssetCoins", params);
  },
  getAssetBalance(params: ChiaMethodMap["getAssetBalance"]["params"]) {
    return call("getAssetBalance", params);
  },
  signCoinSpends(params: ChiaMethodMap["signCoinSpends"]["params"]) {
    return call("signCoinSpends", params);
  },
  signMessage(params: ChiaMethodMap["signMessage"]["params"]) {
    return call("signMessage", params);
  },
  transfer(params: ChiaMethodMap["transfer"]["params"]) {
    return call("transfer", params);
  },
  sendTransaction(params: ChiaMethodMap["sendTransaction"]["params"]) {
    return call("sendTransaction", params);
  },
  createOffer(params: ChiaMethodMap["createOffer"]["params"]) {
    return call("createOffer", params);
  },
  takeOffer(params: ChiaMethodMap["takeOffer"]["params"]) {
    return call("takeOffer", params);
  },
  signMessageByAddress(params: ChiaMethodMap["signMessageByAddress"]["params"]) {
    return call("signMessageByAddress", params);
  },
  getNFTs(params?: ChiaMethodMap["getNFTs"]["params"]) {
    return call("getNFTs", params);
  },
  getNFTInfo(params: ChiaMethodMap["getNFTInfo"]["params"]) {
    return call("getNFTInfo", params);
  },
  cancelOffer(params: ChiaMethodMap["cancelOffer"]["params"]) {
    return call("cancelOffer", params);
  },

  on(event, listener) {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(listener);
  },

  off(event, listener) {
    listeners.get(event)?.delete(listener);
  },

  removeListener(event, listener) {
    listeners.get(event)?.delete(listener);
  },
};

// Inject. Don't clobber an existing wallet — let the user / dApp pick.
//
// We expose THREE names pointing to the same provider:
//   • window.chia   — Goby-compatible (CHIP-0002). dApps already shipping
//     Goby integrations (dexie.space, tibetswap, …) work unchanged.
//   • window.loroco — first-party name for forward-looking integrations
//     that want to detect us specifically (set `isLoroco: true`).
//   • window.ozone  — legacy alias kept for the early-access period while
//     we transitioned the brand. Will be removed in a future release.
if (!window.chia) {
  Object.defineProperty(window, "chia", { value: provider, writable: false, configurable: false });
}
Object.defineProperty(window, "loroco", { value: provider, writable: false, configurable: false });
Object.defineProperty(window, "ozone", { value: provider, writable: false, configurable: false });
