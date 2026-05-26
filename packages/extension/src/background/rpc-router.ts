// CHIP-0002 + Goby method router.
//
// Every method below either:
//   • returns a value derived from the local coin-store / chrome.storage (no
//     engine call required),
//   • forwards to a sage-wasm endpoint that actually exists (verified against
//     vendor/sage/crates/sage-wasm/src/engine.rs `dispatch`), OR
//   • throws a clear CHIP-0002 error so dApps know the operation isn't
//     available yet (e.g. raw spend-bundle signing).
//
// Security gates:
//   • The `chrome.runtime.onMessage` handler in entrypoints/background.ts
//     calls `ensurePermissions(origin, method)` BEFORE we ever dispatch.
//     That function rejects any non-`connect`/`requestAccounts` call from an
//     origin that hasn't been granted a connection — so an unconnected app
//     literally can't reach any code below.
//   • Methods that mutate state, sign data, or transmit a transaction also
//     pop an explicit approval prompt (see APPROVAL_REQUIRED + handler-level
//     `requestApproval`). The user is always the last hand on the keyboard
//     for anything sensitive.
//
// Non-approval read methods (chainId, getPublicKeys, getAssetBalance, …)
// still require a prior `connect` — they just don't pop a per-call prompt.

import { Errors } from "@ozone/goby-provider/errors";
import type {
  AssetBalance,
  ChiaMethod,
  ChiaMethodMap,
  Coin,
  Hex,
  SpendableCoin,
} from "@ozone/goby-provider/types";
import { requestApproval } from "./approval.js";
import { readCoinStore } from "./coin-store.js";
import { callEngine } from "./engine.js";
import { grantConnection, isConnected } from "./permissions.js";

/** How many derived XCH addresses we expose to dApps via `accounts`. */
const ACCOUNTS_COUNT = 5;
/** Derivation window used to map puzzle_hash → derivation_index when picking inputs. */
const DERIVATION_WINDOW = 50;

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

async function deriveAddresses(count: number): Promise<
  { index: number; address: string; puzzle_hash: string; public_key: string }[]
> {
  const masterPk = await loadActiveMasterPk();
  if (!masterPk) throw Errors.unauthorized("No active wallet");
  const res = await callEngine<{
    addresses: { index: number; address: string; puzzle_hash: string; public_key: string }[];
  }>("derive_addresses", {
    master_public_key: masterPk,
    start: 0,
    count,
    testnet: false,
  });
  return res.addresses;
}

async function derivePhToIndex(count: number = DERIVATION_WINDOW): Promise<Record<string, number>> {
  const addresses = await deriveAddresses(count);
  const map: Record<string, number> = {};
  for (const a of addresses) map[a.puzzle_hash] = a.index;
  return map;
}

function with0x(s: string): string {
  return s.startsWith("0x") ? s : `0x${s}`;
}

function strip0x(s: string): string {
  return s.startsWith("0x") ? s.slice(2) : s;
}

/**
 * Methods that pop a per-call approval prompt. The user sees a popup with a
 * method-specific summary and must approve before we forward to the engine.
 *
 * `signCoinSpends`, `sendTransaction` and `createOffer` are intentionally
 * absent — their handlers throw 4004 (MethodNotFound) without doing anything
 * sensitive, so an approval popup would just be UX noise.
 */
const APPROVAL_REQUIRED = new Set<ChiaMethod>([
  "signMessage",
  "transfer",
  "takeOffer",
  "walletSwitchChain",
  "walletWatchAsset",
]);

type Handler<M extends ChiaMethod> = (
  origin: string,
  params: ChiaMethodMap[M]["params"],
) => Promise<ChiaMethodMap[M]["result"]>;

// ─── Inline handlers ─────────────────────────────────────────────────────────

const handlers: { [M in ChiaMethod]?: Handler<M> } = {
  // ── Connection & meta ─────────────────────────────────────────────────────
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

  // Goby-legacy entry-point pair.
  async requestAccounts(origin) {
    if (!(await isConnected(origin))) {
      const approved = await requestApproval(origin, "requestAccounts", undefined);
      if (!approved) throw Errors.userRejected();
      await grantConnection(origin);
    }
    const addrs = await deriveAddresses(ACCOUNTS_COUNT);
    return addrs.map((a) => a.address);
  },

  async accounts(origin) {
    if (!(await isConnected(origin))) throw Errors.unauthorized("Not connected");
    const addrs = await deriveAddresses(ACCOUNTS_COUNT);
    return addrs.map((a) => a.address);
  },

  // Only mainnet is supported today. testnet11 requires a rebuilt engine.
  async walletSwitchChain(_origin, params) {
    const next = (params as { chainId?: string } | undefined)?.chainId;
    if (next !== "mainnet") {
      throw Errors.invalidParams(
        `Loroco only supports mainnet right now (got ${String(next)})`,
      );
    }
    return null as ChiaMethodMap["walletSwitchChain"]["result"];
  },

  // Record the CAT/asset the dApp wants the wallet to track. The user already
  // approved via the popup gate; we just persist into the per-fingerprint
  // `watched_assets` list so the wallet UI can surface it next refresh.
  async walletWatchAsset(_origin, params) {
    const p = params as ChiaMethodMap["walletWatchAsset"]["params"];
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    if (!p?.options?.assetId) throw Errors.invalidParams("Missing options.assetId");
    const assetId = strip0x(p.options.assetId);

    const key = `watched_assets.${fp}`;
    const data = await chrome.storage.local.get(key);
    const list = (data[key] as Array<{ assetId: string; symbol: string; logo?: string }>
      | undefined) ?? [];
    if (!list.some((a) => a.assetId === assetId)) {
      list.push({
        assetId,
        symbol: p.options.symbol,
        ...(p.options.logo ? { logo: p.options.logo } : {}),
      });
      await chrome.storage.local.set({ [key]: list });
    }
    return true;
  },

  // ── Read-only wallet state ───────────────────────────────────────────────
  async getPublicKeys(_origin, params) {
    const p = (params ?? {}) as ChiaMethodMap["getPublicKeys"]["params"];
    const limit = (p?.limit ?? 10) | 0;
    const offset = (p?.offset ?? 0) | 0;
    const total = offset + limit;
    const addrs = await deriveAddresses(total);
    return addrs.slice(offset).map((a) => with0x(a.public_key)) as Hex[];
  },

  // Of the coin IDs the dApp gives us, return the ones that look spendable
  // (i.e. we have them unspent in the local store and they're not currently
  // queued for a pending approval). We don't have a mempool lock UI yet, so
  // "unlocked" == "unspent && we own it".
  async filterUnlockedCoins(_origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = params as ChiaMethodMap["filterUnlockedCoins"]["params"];
    if (!p?.coinNames || !Array.isArray(p.coinNames)) {
      throw Errors.invalidParams("Missing coinNames");
    }
    const store = await readCoinStore(fp);
    const owned = new Set<string>();
    for (const c of Object.values(store.coins)) if (!c.spent) owned.add(strip0x(c.coin_id));
    for (const cat of Object.values(store.cats ?? {})) {
      for (const c of cat.coins) if (!c.spent) owned.add(strip0x(c.coin_id));
    }
    return p.coinNames.filter((id) => owned.has(strip0x(id))) as Hex[];
  },

  // Goby-style get_spendable_coins. type=null/empty/"xch" → XCH; type="cat" → CAT;
  // type="nft" → NFT (one-coin entries since NFTs are singletons).
  async getAssetCoins(_origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = params as ChiaMethodMap["getAssetCoins"]["params"];
    const includeLocked = p?.includedLocked === true; // typo intentional — Goby's docs spell it this way
    const offset = p?.offset ?? 0;
    const limit = p?.limit ?? 1000;
    const store = await readCoinStore(fp);
    const out: SpendableCoin[] = [];

    if (p?.type === "cat") {
      if (!p.assetId) throw Errors.invalidParams("assetId is required for type='cat'");
      const cat = (store.cats ?? {})[with0x(strip0x(p.assetId))]
        ?? (store.cats ?? {})[strip0x(p.assetId)];
      if (cat) {
        for (const c of cat.coins) {
          if (c.spent && !includeLocked) continue;
          out.push({
            coin: {
              parent_coin_info: with0x(c.parent_coin_info),
              puzzle_hash: with0x(c.puzzle_hash),
              amount: Number(c.amount),
            } as Coin,
            coinName: with0x(c.coin_id),
            puzzle: "0x" as Hex,
            confirmedBlockIndex: c.confirmed_block_index,
            locked: c.spent,
            lineageProof: {
              parentName: with0x(c.lineage_proof.parent_name),
              innerPuzzleHash: with0x(c.lineage_proof.inner_puzzle_hash),
              amount: Number(c.lineage_proof.amount),
            },
          });
        }
      }
    } else if (p?.type === "nft") {
      for (const nft of Object.values(store.nfts ?? {})) {
        if (nft.spent && !includeLocked) continue;
        if (p.assetId && strip0x(p.assetId) !== strip0x(nft.launcher_id)) continue;
        out.push({
          coin: {
            parent_coin_info: with0x(nft.parent_coin_info),
            puzzle_hash: with0x(nft.puzzle_hash),
            amount: Number(nft.amount),
          } as Coin,
          coinName: with0x(nft.coin_id),
          puzzle: "0x" as Hex,
          confirmedBlockIndex: nft.confirmed_block_index,
          locked: nft.spent,
        });
      }
    } else {
      // null / undefined / "" → XCH
      for (const c of Object.values(store.coins)) {
        if (c.spent && !includeLocked) continue;
        out.push({
          coin: {
            parent_coin_info: with0x(c.parent_coin_info),
            puzzle_hash: with0x(c.puzzle_hash),
            amount: Number(c.amount),
          } as Coin,
          coinName: with0x(c.coin_id),
          puzzle: "0x" as Hex,
          confirmedBlockIndex: c.confirmed_block_index,
          locked: c.spent,
        });
      }
    }
    return out.slice(offset, offset + limit);
  },

  async getAssetBalance(_origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = params as ChiaMethodMap["getAssetBalance"]["params"];
    const store = await readCoinStore(fp);

    let confirmed = 0n;
    let spendable = 0n;
    let coinCount = 0;

    if (p?.type === "cat") {
      if (!p.assetId) throw Errors.invalidParams("assetId is required for type='cat'");
      const cat = (store.cats ?? {})[with0x(strip0x(p.assetId))]
        ?? (store.cats ?? {})[strip0x(p.assetId)];
      if (cat) {
        for (const c of cat.coins) {
          if (c.spent) continue;
          const amt = BigInt(c.amount);
          confirmed += amt;
          spendable += amt;
          coinCount += 1;
        }
      }
    } else if (p?.type === "nft") {
      // NFTs are 1-mojo singletons; report count for the launcher (or total)
      for (const nft of Object.values(store.nfts ?? {})) {
        if (nft.spent) continue;
        if (p.assetId && strip0x(p.assetId) !== strip0x(nft.launcher_id)) continue;
        confirmed += 1n;
        spendable += 1n;
        coinCount += 1;
      }
    } else {
      for (const c of Object.values(store.coins)) {
        if (c.spent) continue;
        const amt = BigInt(c.amount);
        confirmed += amt;
        spendable += amt;
        coinCount += 1;
      }
    }

    return {
      confirmed: confirmed.toString(),
      spendable: spendable.toString(),
      spendableCoinCount: coinCount,
    } satisfies AssetBalance;
  },

  // ── Signing ──────────────────────────────────────────────────────────────
  async signMessage(_origin, params) {
    const p = params as ChiaMethodMap["signMessage"]["params"];
    if (!p?.message || !p?.publicKey) {
      throw Errors.invalidParams("signMessage requires { message, publicKey }");
    }
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const res = await callEngine<{ signature: string }>("sign_message_with_public_key", {
      fingerprint: fp,
      message: with0x(p.message),
      public_key: with0x(p.publicKey),
    });
    return with0x(res.signature) as Hex;
  },

  // The wasm engine doesn't expose a raw `sign_coin_spends` endpoint yet —
  // every signing path goes through send_xch / send_cat / transfer_nft /
  // take_offer which build the bundle internally. Surface a clear CHIP-0002
  // MethodNotFound so dApps know to fall back to those higher-level methods.
  async signCoinSpends() {
    throw new (class extends Error {
      code = 4004;
    })(
      "signCoinSpends is not exposed yet — use transfer / takeOffer / sendTransaction with a fully-built bundle instead.",
    );
  },

  // ── State-mutating endpoints ────────────────────────────────────────────
  async transfer(_origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = params as ChiaMethodMap["transfer"]["params"];
    if (!p?.to || !p?.amount) throw Errors.invalidParams("transfer requires { to, amount }");

    const amount = BigInt(String(p.amount));
    const fee = BigInt(String(p.fee ?? 0));
    const assetId = p.assetId && p.assetId !== "" ? strip0x(p.assetId) : null;

    const phToIdx = await derivePhToIndex();
    const store = await readCoinStore(fp);

    if (!assetId) {
      // XCH transfer
      const need = amount + fee;
      const candidates = Object.values(store.coins)
        .filter((c) => !c.spent && phToIdx[c.puzzle_hash] !== undefined)
        .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
      const inputs: Array<{
        parent_coin_info: string;
        puzzle_hash: string;
        amount: string;
        derivation_index: number;
      }> = [];
      let running = 0n;
      for (const c of candidates) {
        if (running >= need) break;
        inputs.push({
          parent_coin_info: c.parent_coin_info,
          puzzle_hash: c.puzzle_hash,
          amount: c.amount,
          derivation_index: phToIdx[c.puzzle_hash]!,
        });
        running += BigInt(c.amount);
      }
      if (running < need) {
        throw Errors.spendableBalanceExceeded(
          `Need ${need} XCH mojos (incl. fee), only ${running} available`,
        );
      }
      const res = await callEngine<{ tx_id: string; error?: string }>("send_xch", {
        fingerprint: fp,
        recipient_address: p.to,
        amount_mojos: amount.toString(),
        fee_mojos: fee.toString(),
        input_coins: inputs,
        change_index: inputs[0]!.derivation_index,
        testnet: false,
        broadcast: true,
      });
      if (res.error) throw new Error(res.error);
      return { id: with0x(res.tx_id) } as ChiaMethodMap["transfer"]["result"];
    }

    // CAT transfer
    const catKey = with0x(assetId);
    const cat = (store.cats ?? {})[catKey] ?? (store.cats ?? {})[assetId];
    if (!cat) throw Errors.spendableBalanceExceeded(`CAT ${assetId} not in wallet`);
    const sortedCoins = cat.coins
      .filter((c) => !c.spent && phToIdx[c.inner_puzzle_hash] !== undefined)
      .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
    const picked: Array<{
      parent_coin_info: string;
      puzzle_hash: string;
      amount: string;
      inner_puzzle_hash: string;
      derivation_index: number;
      lineage_proof: { parent_name: string; inner_puzzle_hash: string; amount: string };
    }> = [];
    let running = 0n;
    for (const c of sortedCoins) {
      if (running >= amount) break;
      picked.push({
        parent_coin_info: c.parent_coin_info,
        puzzle_hash: c.puzzle_hash,
        amount: c.amount,
        inner_puzzle_hash: c.inner_puzzle_hash,
        derivation_index: phToIdx[c.inner_puzzle_hash]!,
        lineage_proof: c.lineage_proof,
      });
      running += BigInt(c.amount);
    }
    if (running < amount) {
      throw Errors.spendableBalanceExceeded(
        `Need ${amount} of CAT ${assetId}, only ${running} available`,
      );
    }
    const res = await callEngine<{ tx_id: string; error?: string }>("send_cat", {
      fingerprint: fp,
      asset_id: with0x(assetId),
      recipient_address: p.to,
      amount_mojos: amount.toString(),
      fee_mojos: fee.toString(),
      input_coins: picked,
      change_index: picked[0]!.derivation_index,
      broadcast: true,
    });
    if (res.error) throw new Error(res.error);
    return { id: with0x(res.tx_id) } as ChiaMethodMap["transfer"]["result"];
  },

  // No raw-bundle submit endpoint in the engine yet; sendTransaction is the
  // dApp escape hatch for pre-signed bundles built externally (e.g. Goby's
  // own offer/spend flows). Surface CHIP-0002 MethodNotFound until the
  // engine gets a `submit_transaction` dispatch arm.
  async sendTransaction() {
    throw new (class extends Error {
      code = 4004;
    })(
      "sendTransaction is not implemented — Loroco builds + signs bundles internally via transfer / takeOffer.",
    );
  },

  // Offer creation is intentionally out-of-scope in the WASM engine today
  // (see vendor/sage/.../engine.rs:911 comment). Return MethodNotFound with a
  // dedicated message so dApps don't loop on "should I retry?".
  async createOffer() {
    throw new (class extends Error {
      code = 4004;
    })(
      "createOffer is not implemented yet — Loroco can take offers (takeOffer) but cannot mint new ones until the engine exposes make_offer.",
    );
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
    const phToIdx = await derivePhToIndex();

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
    if (res.error) throw new Error(res.error);
    return { id: with0x(res.tx_id) } as ChiaMethodMap["takeOffer"]["result"];
  },
};

export async function handleRpc<M extends ChiaMethod>(
  origin: string,
  method: M,
  params: ChiaMethodMap[M]["params"],
): Promise<ChiaMethodMap[M]["result"]> {
  // Approval gate for methods that mutate state, sign things, or transmit.
  // `connect` / `requestAccounts` pop their own approval inside the handler.
  if (APPROVAL_REQUIRED.has(method)) {
    const approved = await requestApproval(origin, method, params);
    if (!approved) throw Errors.userRejected();
  }

  const handler = handlers[method] as Handler<M> | undefined;
  if (handler) return handler(origin, params);

  throw Errors.methodNotFound(method);
}
