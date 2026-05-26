// CHIP-0002 method router. Maps Goby methods → sage-api endpoints exposed by
// the WASM engine.

import { Errors } from "@ozone/goby-provider/errors";
import type { ChiaMethod, ChiaMethodMap } from "@ozone/goby-provider/types";
import { requestApproval } from "./approval.js";
import { readCoinStore } from "./coin-store.js";
import { callEngine } from "./engine.js";
import { grantConnection, isConnected } from "./permissions.js";

/** How many derived XCH addresses we expose to dApps via `accounts`. */
const ACCOUNTS_COUNT = 5;

interface StoredWalletEntry {
  fingerprint: number;
  masterPublicKey?: string;
  label: string;
  createdAt: number;
}

async function loadActiveMasterPk(): Promise<string | null> {
  const session = await chrome.storage.session.get("activeFingerprint");
  const fp = session.activeFingerprint as number | undefined;
  if (typeof fp !== "number") return null;
  const local = await chrome.storage.local.get("wallets");
  const wallets = (local.wallets as Record<string, StoredWalletEntry> | undefined) ?? {};
  return wallets[fp.toString()]?.masterPublicKey ?? null;
}

async function loadActiveFingerprint(): Promise<number | null> {
  const session = await chrome.storage.session.get("activeFingerprint");
  const fp = session.activeFingerprint;
  return typeof fp === "number" ? fp : null;
}

async function deriveActiveAddresses(count = ACCOUNTS_COUNT): Promise<string[]> {
  const masterPk = await loadActiveMasterPk();
  if (!masterPk) throw Errors.unauthorized("No active wallet");
  const res = await callEngine<{ addresses: { address: string }[] }>("derive_addresses", {
    master_public_key: masterPk,
    start: 0,
    count,
    testnet: false,
  });
  return res.addresses.map((a) => a.address);
}

const APPROVAL_REQUIRED = new Set<ChiaMethod>([
  "connect",
  "signCoinSpends",
  "signMessage",
  "transfer",
  "sendTransaction",
  "createOffer",
  "takeOffer",
  "walletSwitchChain",
  "walletWatchAsset",
]);

type Handler<M extends ChiaMethod> = (
  origin: string,
  params: ChiaMethodMap[M]["params"],
) => Promise<ChiaMethodMap[M]["result"]>;

/**
 * Maps each CHIP-0002 / Goby method to a sage-api engine endpoint plus a
 * lightweight transform on the response (most methods just pass through).
 * `null` means "handled inline by a dedicated function below".
 */
const ENGINE_METHOD: Partial<Record<ChiaMethod, string | null>> = {
  chainId: "get_network",
  connect: null,
  walletSwitchChain: "switch_network",
  walletWatchAsset: "add_cat",

  getPublicKeys: "get_derivations",
  filterUnlockedCoins: "filter_unlocked_coins",
  getAssetCoins: "get_spendable_coins",
  getAssetBalance: "get_sync_status",

  signCoinSpends: "sign_coin_spends",
  signMessage: "sign_message_by_public_key",

  transfer: null, // routed inline to send_xch or send_cat based on params
  sendTransaction: "submit_transaction",
  createOffer: "make_offer",
  takeOffer: "take_offer",
};

const handlers: { [M in ChiaMethod]?: Handler<M> } = {
  async chainId() {
    return "mainnet" as ChiaMethodMap["chainId"]["result"];
  },

  async connect(origin, params) {
    void params;
    const approved = await requestApproval(origin, "connect", params);
    if (!approved) throw Errors.userRejected();
    await grantConnection(origin);
    return true;
  },

  // Goby-legacy: `requestAccounts` prompts for approval (if not already
  // connected) then returns derived XCH addresses. Treated as the modern
  // CHIP-0002 `connect` followed by a `getPublicKeys`-shaped read, but
  // returning bech32 xch1 addresses instead of pubkey hex (Goby's contract).
  async requestAccounts(origin) {
    if (!(await isConnected(origin))) {
      const approved = await requestApproval(origin, "requestAccounts", undefined);
      if (!approved) throw Errors.userRejected();
      await grantConnection(origin);
    }
    return deriveActiveAddresses();
  },

  // Goby-legacy: `accounts` returns the current accounts WITHOUT prompting.
  // dApps probe this on mount to hydrate "already connected" state. Throw
  // 4900 (we re-use Unauthorized) when not connected so the dApp can fall
  // back to its disconnected UI.
  async accounts(origin) {
    if (!(await isConnected(origin))) throw Errors.unauthorized("Not connected");
    return deriveActiveAddresses();
  },

  async transfer(_origin, params) {
    const assetId = (params as { assetId?: string | null }).assetId;
    const endpoint = assetId && assetId !== "" ? "send_xch" : "send_xch"; // FIXME: send_cat once storage wired
    return callEngine(endpoint, params) as Promise<ChiaMethodMap["transfer"]["result"]>;
  },

  // Take an existing offer: enrich the dApp's `{offer, fee}` params with the
  // wallet's input coins so the engine has everything it needs to build the
  // taker side of the spend bundle.
  async takeOffer(_origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const masterPk = await loadActiveMasterPk();
    if (!masterPk) throw Errors.unauthorized("Active wallet missing master_public_key");
    const p = params as { offer?: string; fee?: number | string } | undefined;
    if (!p?.offer) throw Errors.invalidParams("Missing 'offer' parameter");
    const feeMojos = BigInt(p.fee ?? 0).toString();

    // 1. Decode so we know what assets the offer asks us to provide.
    const decoded = await callEngine<{
      requested: {
        xch_mojos: string;
        cats: Array<{ asset_id: string; amount: string }>;
        nft_launcher_ids: string[];
      };
    }>("decode_offer", { offer: p.offer });

    const xchNeeded = BigInt(decoded.requested.xch_mojos) + BigInt(feeMojos);
    const catsNeeded = new Map<string, bigint>();
    for (const c of decoded.requested.cats) {
      const id = c.asset_id.startsWith("0x") ? c.asset_id : `0x${c.asset_id}`;
      catsNeeded.set(id, BigInt(c.amount));
    }

    // 2. Derive a generous set of our addresses so the engine can match each
    //    input coin's puzzle_hash back to a derivation index.
    const derived = await callEngine<{
      addresses: { index: number; puzzle_hash: string }[];
    }>("derive_addresses", {
      master_public_key: masterPk,
      start: 0,
      count: 50,
      testnet: false,
    });
    const phToIdx: Record<string, number> = {};
    for (const a of derived.addresses) phToIdx[a.puzzle_hash] = a.index;

    // 3. Pull the local coin store and pick inputs to cover the requested side.
    const store = await readCoinStore(fp);

    const xchInputs: Array<{
      parent_coin_info: string;
      puzzle_hash: string;
      amount: string;
      derivation_index: number;
    }> = [];
    if (xchNeeded > 0n) {
      const candidates = Object.values(store.coins)
        .filter((c) => !c.spent && phToIdx[c.puzzle_hash] !== undefined)
        .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
      let running = 0n;
      for (const c of candidates) {
        if (running >= xchNeeded) break;
        xchInputs.push({
          parent_coin_info: c.parent_coin_info,
          puzzle_hash: c.puzzle_hash,
          amount: c.amount,
          derivation_index: phToIdx[c.puzzle_hash]!,
        });
        running += BigInt(c.amount);
      }
      if (running < xchNeeded) {
        throw Errors.spendableBalanceExceeded(
          `Need ${xchNeeded} XCH mojos (incl. fee), only ${running} available across owned inputs`,
        );
      }
    }

    const catInputs: Array<{
      asset_id: string;
      parent_coin_info: string;
      puzzle_hash: string;
      amount: string;
      inner_puzzle_hash: string;
      derivation_index: number;
      lineage_proof: { parent_name: string; inner_puzzle_hash: string; amount: string };
    }> = [];
    for (const [assetId, need] of catsNeeded) {
      const cat = (store.cats ?? {})[assetId];
      if (!cat) {
        throw Errors.spendableBalanceExceeded(`Offer requests CAT ${assetId} we don't own`);
      }
      const candidates = cat.coins
        .filter((c) => !c.spent && phToIdx[c.inner_puzzle_hash] !== undefined)
        .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
      let running = 0n;
      for (const c of candidates) {
        if (running >= need) break;
        catInputs.push({
          asset_id: assetId,
          parent_coin_info: c.parent_coin_info,
          puzzle_hash: c.puzzle_hash,
          amount: c.amount,
          inner_puzzle_hash: c.inner_puzzle_hash,
          derivation_index: phToIdx[c.inner_puzzle_hash]!,
          lineage_proof: c.lineage_proof,
        });
        running += BigInt(c.amount);
      }
      if (running < need) {
        throw Errors.spendableBalanceExceeded(
          `Offer requests ${need} of CAT ${assetId}, only ${running} available`,
        );
      }
    }

    const res = await callEngine<{ tx_id: string; status: string; error?: string }>("take_offer", {
      fingerprint: fp,
      offer: p.offer,
      input_coins: xchInputs,
      input_cats: catInputs,
      fee_mojos: feeMojos,
      broadcast: true,
      endpoint: "mainnet",
    });
    return { id: res.tx_id } as ChiaMethodMap["takeOffer"]["result"];
  },
};

export async function handleRpc<M extends ChiaMethod>(
  origin: string,
  method: M,
  params: ChiaMethodMap[M]["params"],
): Promise<ChiaMethodMap[M]["result"]> {
  // Approval gate for methods that mutate state or sign things
  if (APPROVAL_REQUIRED.has(method) && method !== "connect") {
    const approved = await requestApproval(origin, method, params);
    if (!approved) throw Errors.userRejected();
  }

  // Inline handler wins
  const inline = handlers[method] as Handler<M> | undefined;
  if (inline) return inline(origin, params);

  // Engine passthrough
  const endpoint = ENGINE_METHOD[method];
  if (typeof endpoint === "string") {
    return callEngine<ChiaMethodMap[M]["result"]>(endpoint, params);
  }

  throw Errors.methodNotFound(method);
}
