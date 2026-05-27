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
  CatAssetView,
  ChiaMethod,
  ChiaMethodMap,
  Coin,
  CoinView,
  Derivation,
  Hex,
  OfferView,
  SpendableCoin,
  TransactionView,
} from "@ozone/goby-provider/types";
import { requestApproval } from "./approval.js";
import {
  findCatCoinIdByOutpoint,
  findXchCoinIdByOutpoint,
  markCatSpentOptimistic,
  markXchSpentOptimistic,
  readCoinStore,
  writeCoinStore,
} from "./coin-store.js";
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
 * Human summary of the CATs the wallet currently tracks. Appended to "not in
 * wallet" errors so dApps + users see what's actually available rather than
 * a bare "CAT 0x… not in wallet". Shows up to 8 entries with truncated ids;
 * "+ N more" tail for wallets with many assets.
 */
function describeAvailableCats(
  store: { cats?: Record<string, { coins?: Array<{ spent: boolean }> }> },
): string {
  const cats = Object.entries(store.cats ?? {});
  if (cats.length === 0) {
    return "Wallet has no CATs tracked yet — wait for sync to finish or fund the wallet.";
  }
  const ownedAssetIds = cats
    .filter(([, cat]) => (cat.coins ?? []).some((c) => !c.spent))
    .map(([id]) => (id.startsWith("0x") ? id : `0x${id}`));
  if (ownedAssetIds.length === 0) {
    return `Wallet tracks ${cats.length} CAT asset(s) but has no unspent coins for any of them.`;
  }
  const preview = ownedAssetIds
    .slice(0, 8)
    .map((id) => `${id.slice(0, 10)}…${id.slice(-6)}`)
    .join(", ");
  const tail = ownedAssetIds.length > 8 ? ` (+${ownedAssetIds.length - 8} more)` : "";
  return `Wallet tracks: ${preview}${tail}.`;
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
  "signMessageByAddress",
  "signCoinSpends",
  "transfer",
  "sendTransaction",
  "createOffer",
  "takeOffer",
  "cancelOffer",
  "walletSwitchChain",
  "walletWatchAsset",
  // Oleada 2 — every multi-output write broadcasts a tx and requires consent.
  "bulkSendXch",
  "bulkSendCat",
  "combine",
  "split",
  // Oleada 3 — issuance + DID creation broadcast on-chain spends.
  "issueCat",
  "createDid",
  "addNftUri",
  "transferDid",
]);

// ─── Method-name aliasing ────────────────────────────────────────────────
// dApps target several historical naming conventions for the same wallet
// surface:
//   • CHIP-0002 camelCase             — `connect`, `signMessage`, …
//   • Goby pre-CHIP-0002 prefixed     — `chia_requestAccounts`, …
//   • WalletConnect2 topic-style      — `chip0002_signMessage`, …
//   • Sage WC2 with `chia_` snake     — `chia_signMessageByAddress`, …
// We accept all of them by canonicalising on the way in. The handler set
// only ever needs to be keyed on CHIP-0002 camelCase.
//
// Handlers that have shape variants between Goby and Sage WC2 (notably
// `chia_getNfts`, `chia_send`, `chia_cancelOffer`) receive the *original*
// method name as the 3rd argument and branch on it — so a WC2 dApp gets the
// Sage shape and a Goby dApp gets the Loroco/Goby shape from the same handler.
//
// Split into two tables so the user can opt out of Goby compatibility:
//   • BASE_ALIASES — always honoured. Canonical CHIP-0002 camelCase plus
//     the snake_case forms Sage WC2 uses on the wire. These are how
//     modern dApps that target Loroco directly will call us.
//   • LEGACY_GOBY_ALIASES — only honoured when settings.legacyGoby=true.
//     Everything namespaced `chia_*` (Goby's pre-CHIP-0002 surface) or
//     `chip0002_*` (WC2 topic-style). In production-default mode these
//     are rejected with MethodNotFound so Loroco doesn't silently
//     answer for a Goby surface its user hasn't opted into.
const BASE_ALIASES: Record<string, ChiaMethod> = {
  // snake_case Sage WC2 names that some clients send unchanged
  filter_unlocked_coins: "filterUnlockedCoins",
  get_asset_coins: "getAssetCoins",
  get_asset_balance: "getAssetBalance",
  sign_message_with_public_key: "signMessage",
  sign_message_by_address: "signMessageByAddress",
  send_transaction_immediately: "sendTransaction",
  get_nfts: "getNFTs",
  get_nft_info: "getNFTInfo",
  cancel_offer: "cancelOffer",
  bulk_mint_nfts: "bulkMintNfts",
  get_address: "getAddress",
  // snake_case for the read-only extensions
  get_coins: "getCoins",
  get_coins_by_ids: "getCoinsByIds",
  is_asset_owned: "isAssetOwned",
  get_cats: "getCats",
  get_all_cats: "getAllCats",
  get_token: "getToken",
  get_derivations: "getDerivations",
  get_transactions: "getTransactions",
  get_pending_transactions: "getPendingTransactions",
  get_offers: "getOffers",
  get_offer: "getOffer",
  // snake_case Oleada 2
  bulk_send_xch: "bulkSendXch",
  bulk_send_cat: "bulkSendCat",
  // (combine / split don't have a snake_case Sage equivalent — same name works)
  // snake_case Oleada 3
  issue_cat: "issueCat",
  create_did: "createDid",
  add_nft_uri: "addNftUri",
  transfer_did: "transferDid",
  // snake_case stub reads (Fase 3 placeholders)
  get_dids: "getDids",
  get_nft_collections: "getNftCollections",
  get_nft_collection: "getNftCollection",
  get_minter_did_ids: "getMinterDidIds",
};

const LEGACY_GOBY_ALIASES: Record<string, ChiaMethod> = {
  // chia_* (Goby legacy + Sage WC2)
  chia_chainId: "chainId",
  chia_connect: "connect",
  chia_requestAccounts: "requestAccounts",
  chia_accounts: "accounts",
  chia_getAddress: "getAddress",
  chia_getPublicKeys: "getPublicKeys",
  chia_filterUnlockedCoins: "filterUnlockedCoins",
  chia_getAssetCoins: "getAssetCoins",
  chia_getAssetBalance: "getAssetBalance",
  chia_signCoinSpends: "signCoinSpends",
  chia_signMessage: "signMessage",
  chia_signMessageByAddress: "signMessageByAddress",
  chia_transfer: "transfer",
  chia_sendTransaction: "sendTransaction",
  chia_createOffer: "createOffer",
  chia_takeOffer: "takeOffer",
  chia_cancelOffer: "cancelOffer",
  chia_getNFTs: "getNFTs",
  chia_getNFTInfo: "getNFTInfo",
  chia_bulkMintNfts: "bulkMintNfts",
  chia_walletSwitchChain: "walletSwitchChain",
  chia_walletWatchAsset: "walletWatchAsset",
  // chia_* read-only extensions (Loroco WC-bypass surface)
  chia_getCoins: "getCoins",
  chia_getCoinsByIds: "getCoinsByIds",
  chia_isAssetOwned: "isAssetOwned",
  chia_getCats: "getCats",
  chia_getAllCats: "getAllCats",
  chia_getToken: "getToken",
  chia_getDerivations: "getDerivations",
  chia_getTransactions: "getTransactions",
  chia_getPendingTransactions: "getPendingTransactions",
  chia_getOffers: "getOffers",
  chia_getOffer: "getOffer",
  // chia_* Oleada 2 (multi-output writes)
  chia_bulkSendXch: "bulkSendXch",
  chia_bulkSendCat: "bulkSendCat",
  chia_combine: "combine",
  chia_split: "split",
  // chia_* Oleada 3 (new on-chain primitives)
  chia_issueCat: "issueCat",
  chia_createDid: "createDid",
  chia_addNftUri: "addNftUri",
  chia_transferDid: "transferDid",
  // Sage WC2 spells the plural form
  chia_transferDids: "transferDid",
  // chia_* dApp probe stubs (empty until Fase 3 DID sync)
  chia_getDids: "getDids",
  chia_getNftCollections: "getNftCollections",
  chia_getNftCollection: "getNftCollection",
  chia_getMinterDidIds: "getMinterDidIds",
  // chip0002_* (WC2 topic style — CHIP-0002 namespace)
  chip0002_chainId: "chainId",
  chip0002_connect: "connect",
  chip0002_getPublicKeys: "getPublicKeys",
  chip0002_filterUnlockedCoins: "filterUnlockedCoins",
  chip0002_getAssetCoins: "getAssetCoins",
  chip0002_getAssetBalance: "getAssetBalance",
  chip0002_signCoinSpends: "signCoinSpends",
  chip0002_signMessage: "signMessage",
  chip0002_signMessageByPublicKey: "signMessage",
  chip0002_signMessageByAddress: "signMessageByAddress",
  chip0002_sendTransaction: "sendTransaction",
  // Sage WC2 names with different case/spelling that map to existing handlers
  chia_send: "transfer",
  chia_getNfts: "getNFTs",
};

/**
 * Normalise an alias/legacy method name down to its CHIP-0002 canonical.
 *
 * When `allowLegacyGoby` is false, the `chia_*` and `chip0002_*` namespaces
 * are NOT resolved — the original name is returned so the dispatcher in
 * handleRpc surfaces MethodNotFound. snake_case names are always resolved
 * because they're Sage WC2's wire format, independent of the Goby-compat
 * decision.
 */
export function canonicalizeMethod(
  method: string,
  allowLegacyGoby: boolean,
): ChiaMethod {
  const base = BASE_ALIASES[method];
  if (base) return base;
  if (allowLegacyGoby) {
    const legacy = LEGACY_GOBY_ALIASES[method];
    if (legacy) return legacy;
  }
  return method as ChiaMethod;
}

/** True if the method name belongs to a legacy-Goby namespace we gate. */
export function isLegacyGobyAlias(method: string): boolean {
  return Object.hasOwn(LEGACY_GOBY_ALIASES, method);
}

type Handler<M extends ChiaMethod> = (
  origin: string,
  params: ChiaMethodMap[M]["params"],
  originalMethod: string,
) => Promise<ChiaMethodMap[M]["result"]>;

// ─── Inline handlers ─────────────────────────────────────────────────────────

const handlers: { [M in ChiaMethod]?: Handler<M> } = {
  // ── Connection & meta ─────────────────────────────────────────────────────
  async chainId() {
    return "mainnet" as ChiaMethodMap["chainId"]["result"];
  },

  async connect(origin, params) {
    void params;
    const decision = await requestApproval(origin, "connect", params);
    if (!decision.approved) throw Errors.userRejected();
    await grantConnection(origin);
    return true;
  },

  // Goby-legacy entry-point pair.
  async requestAccounts(origin) {
    if (!(await isConnected(origin))) {
      const decision = await requestApproval(origin, "requestAccounts", undefined);
      if (!decision.approved) throw Errors.userRejected();
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

  // Sage WC2 `chia_getAddress`: a single primary receive address.
  // Sage returns `sync.receive_address` from the daemon — we mirror that by
  // surfacing the first derived address (index 0). No approval needed.
  async getAddress() {
    const addrs = await deriveAddresses(1);
    return { address: addrs[0]!.address };
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

    if (p?.hardened === true) {
      // Hardened derivation needs the unlocked master_sk in the engine cache —
      // the SK never leaves the WASM module. If the wallet isn't unlocked yet,
      // the engine returns 4900 and we surface it to the dApp.
      const fp = await loadActiveFingerprint();
      if (fp == null) throw Errors.unauthorized("No active wallet");
      const res = await callEngine<{
        addresses: { index: number; address: string; puzzle_hash: string; public_key: string }[];
      }>("derive_addresses_hardened", {
        fingerprint: fp,
        start: 0,
        count: total,
        testnet: false,
      });
      return res.addresses.slice(offset).map((a) => with0x(a.public_key)) as Hex[];
    }

    const addrs = await deriveAddresses(total);
    return addrs.slice(offset).map((a) => with0x(a.public_key)) as Hex[];
  },

  // Of the coin IDs the dApp gives us, return the ones that look spendable
  // (i.e. we have them unspent in the local store and they're not currently
  // queued for a pending approval). We don't have a mempool lock UI yet, so
  // "unlocked" == "unspent && we own it".
  async filterUnlockedCoins(origin, params) {
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
    const matched = p.coinNames.filter((id) => owned.has(strip0x(id))) as Hex[];
    console.log(
      `[loroco/filterUnlockedCoins] origin=${origin} asked for ${p.coinNames.length}`,
      `coins → ${matched.length} match our store (fp=${fp})`,
    );
    return matched;
  },

  // Goby-style get_spendable_coins. type=null/empty/"xch" → XCH; type="cat" → CAT;
  // type="nft" → NFT (one-coin entries since NFTs are singletons).
  async getAssetCoins(origin, params) {
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
    } else if (p?.type === "did") {
      // DID tracking pending — see plan Fase 2. Return empty so WC2 dApps
      // probing for DIDs don't crash; they'll just see "no DIDs owned".
      console.log(
        `[loroco/getAssetCoins] origin=${origin} type=did → empty (DID tracking pending)`,
      );
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
    const sliced = out.slice(offset, offset + limit);
    console.log(
      `[loroco/getAssetCoins] origin=${origin} type=${p?.type ?? "(xch)"}`,
      `assetId=${p?.assetId ?? "null"} → ${sliced.length} coins`,
      `(${out.length} total, includeLocked=${includeLocked})`,
    );
    return sliced;
  },

  async getAssetBalance(origin, params) {
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
    } else if (p?.type === "did") {
      // DID tracking pending — Fase 2. Return zeros so WC2 dApps don't crash.
      console.log(
        `[loroco/getAssetBalance] origin=${origin} type=did → 0 (DID tracking pending)`,
      );
    } else {
      for (const c of Object.values(store.coins)) {
        if (c.spent) continue;
        const amt = BigInt(c.amount);
        confirmed += amt;
        spendable += amt;
        coinCount += 1;
      }
    }

    // Temporary diagnostic — kept until we trust the dApp balance path. Lets
    // us reproduce in the live browser: open the SW DevTools console
    // (chrome://extensions → Loroco → service worker) and read the
    // (origin, type, assetId) → confirmed line for each dApp call.
    console.log(
      `[loroco/getAssetBalance] origin=${origin} type=${p?.type ?? "(xch)"}`,
      `assetId=${p?.assetId ?? "null"} → confirmed=${confirmed} spendable=${spendable}`,
      `coins=${coinCount} (fp=${fp}, store has ${Object.keys(store.coins).length} XCH`,
      `+ ${Object.keys(store.cats ?? {}).length} CAT assets)`,
    );

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

  // signCoinSpends: ship the bundle to the engine which derives our SKs +
  // signs every required AGG_SIG condition. The dApp passes its preferred
  // derivation_index per coin (it knows which of our addresses received the
  // coin). Note that we DON'T pop an approval popup for partial_sign:true —
  // those are co-signing flows where the dApp will need a second round-trip
  // for a real fund-moving signature anyway. Full-sign always pops.
  async signCoinSpends(_origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = params as ChiaMethodMap["signCoinSpends"]["params"];
    if (!p?.coinSpends || !Array.isArray(p.coinSpends)) {
      throw Errors.invalidParams("signCoinSpends requires { coinSpends }");
    }

    // dApps generally pass raw `{coin, puzzle_reveal, solution}` triples
    // without a derivation_index. Look it up from the wallet's derivation
    // window using puzzle_hash; if it's not one of ours, fail loudly so the
    // dApp knows it asked us to sign something we don't own.
    const phToIdx = await derivePhToIndex();
    const enriched = p.coinSpends.map((cs, i) => {
      const phRaw = (cs.coin as { puzzle_hash?: string } | undefined)?.puzzle_hash;
      if (!phRaw) {
        throw Errors.invalidParams(`coinSpends[${i}].coin.puzzle_hash is required`);
      }
      const phLookup = with0x(strip0x(phRaw));
      const idx = phToIdx[phLookup] ?? phToIdx[strip0x(phRaw)];
      if (idx === undefined) {
        throw Errors.noSecretKey(
          `coinSpends[${i}] puzzle_hash ${phLookup} doesn't match any derivation in the first ${DERIVATION_WINDOW} keys`,
        );
      }
      return {
        coin: {
          parent_coin_info: with0x(strip0x((cs.coin as { parent_coin_info: string }).parent_coin_info)),
          puzzle_hash: phLookup,
          amount: Number((cs.coin as { amount: number | string }).amount),
        },
        puzzle_reveal: with0x(cs.puzzle_reveal as string),
        solution: with0x(cs.solution as string),
        derivation_index: idx,
        hardened: false,
      };
    });

    const res = await callEngine<{ signature: string; missing_keys: string[] }>(
      "sign_coin_spends",
      {
        fingerprint: fp,
        coin_spends: enriched,
        partial_sign: Boolean(p.partialSign),
      },
    );
    return with0x(res.signature) as ChiaMethodMap["signCoinSpends"]["result"];
  },

  // ── State-mutating endpoints ────────────────────────────────────────────
  async transfer(_origin, params, originalMethod) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = params as ChiaMethodMap["transfer"]["params"];
    // Sage WC2 `chia_send` uses `address`; Goby/Loroco `transfer` uses `to`.
    // The handler accepts either — branch only on response shape below.
    const recipient = p?.to ?? p?.address;
    if (!recipient || !p?.amount) {
      throw Errors.invalidParams("transfer requires { to|address, amount }");
    }
    const wcShape = originalMethod === "chia_send";

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
      const inputCoinIds: string[] = [];
      let running = 0n;
      for (const c of candidates) {
        if (running >= need) break;
        inputs.push({
          parent_coin_info: c.parent_coin_info,
          puzzle_hash: c.puzzle_hash,
          amount: c.amount,
          derivation_index: phToIdx[c.puzzle_hash]!,
        });
        inputCoinIds.push(c.coin_id);
        running += BigInt(c.amount);
      }
      if (running < need) {
        throw Errors.spendableBalanceExceeded(
          `Need ${need} XCH mojos (incl. fee), only ${running} available`,
        );
      }
      const res = await callEngine<{ tx_id: string; error?: string }>("send_xch", {
        fingerprint: fp,
        recipient_address: recipient,
        amount_mojos: amount.toString(),
        fee_mojos: fee.toString(),
        input_coins: inputs,
        change_index: inputs[0]!.derivation_index,
        testnet: false,
        broadcast: true,
      });
      if (res.error) throw new Error(res.error);
      markXchSpentOptimistic(store, inputCoinIds);
      await writeCoinStore(fp, store);
      return (wcShape ? {} : { id: with0x(res.tx_id) }) as ChiaMethodMap["transfer"]["result"];
    }

    // CAT transfer
    const catKey = with0x(assetId);
    const cat = (store.cats ?? {})[catKey] ?? (store.cats ?? {})[assetId];
    if (!cat) {
      throw Errors.spendableBalanceExceeded(
        `Cannot transfer CAT ${with0x(assetId)} — wallet doesn't track it. ${describeAvailableCats(store)}`,
      );
    }
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
    const pickedCatIds: string[] = [];
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
      pickedCatIds.push(c.coin_id);
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
      recipient_address: recipient,
      amount_mojos: amount.toString(),
      fee_mojos: fee.toString(),
      input_coins: picked,
      change_index: picked[0]!.derivation_index,
      broadcast: true,
    });
    if (res.error) throw new Error(res.error);
    markCatSpentOptimistic(store, with0x(assetId), pickedCatIds);
    await writeCoinStore(fp, store);
    return (wcShape ? {} : { id: with0x(res.tx_id) }) as ChiaMethodMap["transfer"]["result"];
  },

  // Raw-bundle broadcast — the escape hatch for pre-signed bundles built
  // externally (Goby's offer engines, multi-sig co-signing flows, …). The
  // engine just calls `push_tx` against coinset; we don't touch the bundle.
  async sendTransaction(_origin, params) {
    const p = params as ChiaMethodMap["sendTransaction"]["params"];
    if (!p?.spendBundle?.coin_spends) {
      throw Errors.invalidParams("sendTransaction requires { spendBundle.coin_spends }");
    }
    const res = await callEngine<{ status: number; tx_id: string; error?: string }>(
      "submit_transaction",
      {
        spend_bundle: {
          coin_spends: p.spendBundle.coin_spends.map((cs) => ({
            coin: {
              parent_coin_info: with0x(strip0x(cs.coin.parent_coin_info)),
              puzzle_hash: with0x(strip0x(cs.coin.puzzle_hash)),
              amount: Number(cs.coin.amount),
            },
            puzzle_reveal: with0x(cs.puzzle_reveal),
            solution: with0x(cs.solution),
          })),
          aggregated_signature: with0x(p.spendBundle.aggregated_signature),
        },
        endpoint: "mainnet",
      },
    );

    // Status: 1 = SUCCESS (in mempool), 2 = PENDING, 3 = FAILED. Only mark
    // our coins as pending-spent for SUCCESS — FAILED definitely didn't enter
    // the mempool, and PENDING is rare enough we'd rather wait for the next
    // tick than risk a phantom UI update.
    if (res.status === 1) {
      const fp = await loadActiveFingerprint();
      if (fp != null) {
        const store = await readCoinStore(fp);
        const xchIds: string[] = [];
        const catIdsByAsset = new Map<string, string[]>();
        for (const cs of p.spendBundle.coin_spends) {
          const parent = with0x(strip0x(cs.coin.parent_coin_info));
          const ph = with0x(strip0x(cs.coin.puzzle_hash));
          const amt = String(cs.coin.amount);
          const xchId = findXchCoinIdByOutpoint(store, parent, ph, amt);
          if (xchId) {
            xchIds.push(xchId);
            continue;
          }
          const cat = findCatCoinIdByOutpoint(store, parent, ph, amt);
          if (cat) {
            const list = catIdsByAsset.get(cat.assetId) ?? [];
            list.push(cat.coinId);
            catIdsByAsset.set(cat.assetId, list);
          }
          // Coin not in our store — likely a co-signer's input. Skip.
        }
        if (xchIds.length || catIdsByAsset.size) {
          markXchSpentOptimistic(store, xchIds);
          for (const [assetId, ids] of catIdsByAsset) {
            markCatSpentOptimistic(store, assetId, ids);
          }
          await writeCoinStore(fp, store);
        }
      }
    }

    return [
      {
        status: res.status as 1 | 2 | 3,
        error: res.error ?? null,
      },
    ] as ChiaMethodMap["sendTransaction"]["result"];
  },

  // createOffer: build an offer1... string from the maker side. The dApp
  // passes the assets it wants to lock (offerAssets) and the assets it wants
  // back (requestAssets). We pick coins from our local store + forward to
  // make_offer in the engine, which handles the spend bookkeeping + signs.
  async createOffer(origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = params as ChiaMethodMap["createOffer"]["params"];
    if (!p?.offerAssets?.length) {
      throw Errors.invalidParams("createOffer requires at least one offerAssets entry");
    }
    if (!p?.requestAssets?.length) {
      throw Errors.invalidParams("createOffer requires at least one requestAssets entry");
    }

    let offeredXch = 0n;
    const offeredCats = new Map<string, bigint>();
    for (const a of p.offerAssets) {
      const amt = BigInt(String(a.amount));
      if (a.assetId === "" || a.assetId === null || a.assetId === undefined) {
        offeredXch += amt;
      } else {
        const id = with0x(strip0x(a.assetId));
        offeredCats.set(id, (offeredCats.get(id) ?? 0n) + amt);
      }
    }
    let requestedXch = 0n;
    const requestedCats = new Map<string, bigint>();
    for (const a of p.requestAssets) {
      const amt = BigInt(String(a.amount));
      if (a.assetId === "" || a.assetId === null || a.assetId === undefined) {
        requestedXch += amt;
      } else {
        const id = with0x(strip0x(a.assetId));
        requestedCats.set(id, (requestedCats.get(id) ?? 0n) + amt);
      }
    }
    const fee = BigInt(String(p.fee ?? 0));

    const phToIdx = await derivePhToIndex();
    const store = await readCoinStore(fp);

    // Pick XCH inputs to cover offered XCH + fee.
    const xchInputs: Array<{
      parent_coin_info: string;
      puzzle_hash: string;
      amount: string;
      derivation_index: number;
    }> = [];
    const xchNeeded = offeredXch + fee;
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
          `Need ${xchNeeded} XCH mojos (offered + fee), only ${running} available`,
        );
      }
    }

    // Pick CAT inputs per asset_id to cover the offered amount.
    const catInputs: Array<{
      asset_id: string;
      parent_coin_info: string;
      puzzle_hash: string;
      amount: string;
      inner_puzzle_hash: string;
      derivation_index: number;
      lineage_proof: { parent_name: string; inner_puzzle_hash: string; amount: string };
    }> = [];
    for (const [assetId, need] of offeredCats) {
      const cat = (store.cats ?? {})[assetId] ?? (store.cats ?? {})[strip0x(assetId)];
      if (!cat) {
        throw Errors.spendableBalanceExceeded(
          `Offered CAT ${assetId} not in wallet. ${describeAvailableCats(store)}`,
        );
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
          `Need ${need} of offered CAT ${assetId}, only ${running} available`,
        );
      }
    }

    const res = await callEngine<{
      offer: string;
      offer_id: string;
      error?: string;
    }>("make_offer", {
      fingerprint: fp,
      offered_xch_mojos: offeredXch.toString(),
      offered_cats: Array.from(offeredCats.entries()).map(([asset_id, amount]) => ({
        asset_id,
        amount: amount.toString(),
      })),
      requested_xch_mojos: requestedXch.toString(),
      requested_cats: Array.from(requestedCats.entries()).map(([asset_id, amount]) => ({
        asset_id,
        amount: amount.toString(),
      })),
      fee_mojos: fee.toString(),
      input_coins: xchInputs,
      input_cats: catInputs,
    });
    if (res.error) throw new Error(res.error);

    // Persist the offer + the inputs we locked into the settlement spend.
    // cancelOffer({secure:true}) re-spends one of these inputs back to the
    // wallet to invalidate the offer; cancelOffer({secure:false}) just
    // marks it dropped locally. Storing input_coins here saves us from
    // having to decode the offer string at cancel time.
    //
    // We also stamp the creating `origin`. cancelOffer enforces origin
    // equality before either path runs — otherwise any connected dApp
    // could enumerate and cancel another dApp's offers (and even drain
    // the maker input back to the wallet via the secure path).
    const key = `offers.${fp}`;
    const data = await chrome.storage.local.get(key);
    const list = (data[key] as Array<{
      id: string;
      offer: string;
      created_at: number;
      cancelled?: boolean;
      origin?: string;
      input_xch_coins?: Array<{
        parent_coin_info: string;
        puzzle_hash: string;
        amount: string;
        derivation_index: number;
      }>;
      input_cat_coins?: Array<{
        asset_id: string;
        parent_coin_info: string;
        puzzle_hash: string;
        amount: string;
        inner_puzzle_hash: string;
        derivation_index: number;
        lineage_proof: { parent_name: string; inner_puzzle_hash: string; amount: string };
      }>;
    }> | undefined) ?? [];
    list.push({
      id: res.offer_id,
      offer: res.offer,
      created_at: Date.now(),
      origin,
      input_xch_coins: xchInputs,
      input_cat_coins: catInputs,
    });
    await chrome.storage.local.set({ [key]: list });

    return {
      id: with0x(res.offer_id) as Hex,
      offer: res.offer,
    } as ChiaMethodMap["createOffer"]["result"];
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
    const xchInputCoinIds: string[] = [];
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
        xchInputCoinIds.push(c.coin_id);
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
    const catInputIdsByAsset = new Map<string, string[]>();
    for (const [assetId, need] of catsNeeded) {
      const cat = (store.cats ?? {})[assetId] ?? (store.cats ?? {})[strip0x(assetId)];
      if (!cat) {
        throw Errors.spendableBalanceExceeded(
          `Offer requests CAT ${assetId} we don't own. ${describeAvailableCats(store)}`,
        );
      }
      const candidates = cat.coins
        .filter((c) => !c.spent && phToIdx[c.inner_puzzle_hash] !== undefined)
        .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
      const pickedIds = catInputIdsByAsset.get(assetId) ?? [];
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
        pickedIds.push(c.coin_id);
        running += BigInt(c.amount);
      }
      catInputIdsByAsset.set(assetId, pickedIds);
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
    markXchSpentOptimistic(store, xchInputCoinIds);
    for (const [assetId, ids] of catInputIdsByAsset) {
      markCatSpentOptimistic(store, assetId, ids);
    }
    await writeCoinStore(fp, store);
    return { id: with0x(res.tx_id) } as ChiaMethodMap["takeOffer"]["result"];
  },

  // ── Sage WalletConnect2 extras ──────────────────────────────────────────
  //
  // signMessageByAddress: resolve `address` → puzzle_hash → derivation_index,
  // then look up the matching public_key from our derived window and forward
  // to the engine's existing `sign_message_with_public_key` path. This mirrors
  // `vendor/sage/.../endpoints/wallet_connect.rs:sign_message_by_address` but
  // does the address → key resolution on the JS side so the WASM engine
  // doesn't need to query the (browser-side) coin store.
  async signMessageByAddress(_origin, params) {
    const p = params as ChiaMethodMap["signMessageByAddress"]["params"];
    if (!p?.message || !p?.address) {
      throw Errors.invalidParams("signMessageByAddress requires { message, address }");
    }
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");

    // Decode the address to its puzzle_hash via the engine helper. Returns
    // the inner puzzle hash (p2_puzzle_hash) for a standard XCH address.
    const decoded = await callEngine<{ valid: boolean; puzzle_hash?: string; prefix?: string }>(
      "decode_address",
      { address: p.address },
    );
    if (!decoded.valid || !decoded.puzzle_hash) {
      throw Errors.invalidParams(`Address ${p.address} is not a valid Chia address`);
    }
    const targetPh = strip0x(decoded.puzzle_hash).toLowerCase();

    // Walk the derivation window until we find the matching ph. We expose
    // ACCOUNTS_COUNT addresses through `accounts`, but a dApp may pass any
    // address it received from `getPublicKeys`/`getAssetCoins`, which can sit
    // further down the curve. Use the same window as derivePhToIndex.
    const addrs = await deriveAddresses(DERIVATION_WINDOW);
    const match = addrs.find((a) => strip0x(a.puzzle_hash).toLowerCase() === targetPh);
    if (!match) {
      throw Errors.noSecretKey(
        `No matching derivation for address ${p.address} in the first ${DERIVATION_WINDOW} keys`,
      );
    }

    const res = await callEngine<{ signature: string }>("sign_message_with_public_key", {
      fingerprint: fp,
      message: with0x(p.message),
      public_key: with0x(match.public_key),
    });
    return {
      publicKey: with0x(match.public_key) as Hex,
      signature: with0x(res.signature) as Hex,
    };
  },

  // getNFTs / getNFTInfo: read-only queries over the local NFT coin store.
  // Mirrors `vendor/sage/.../endpoints/wallet_connect.rs:get_asset_coins` for
  // the NFT branch but returns the richer NftInfo shape (metadata + royalty)
  // dApps expect instead of just spendable coins.
  async getNFTs(_origin, params, originalMethod) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = (params ?? {}) as ChiaMethodMap["getNFTs"]["params"];
    const limit = (p?.limit ?? 50) | 0;
    const offset = (p?.offset ?? 0) | 0;
    const didFilter = p?.didId ? strip0x(p.didId) : null;
    const store = await readCoinStore(fp);

    const filtered = Object.values(store.nfts ?? {})
      .filter((n) => !n.spent)
      .filter((n) =>
        didFilter == null ? true : strip0x(n.current_owner_did ?? "") === didFilter,
      )
      .slice(offset, offset + limit);

    // Sage WC2 (`chia_getNfts`) expects a different shape: camelCase keys
    // wrapped in `{nfts: […]}`. Loroco/Goby callers get the flat NftInfo[].
    if (originalMethod === "chia_getNfts") {
      return { nfts: filtered.map(nftViewToWcInfo) } as ChiaMethodMap["getNFTs"]["result"];
    }
    return filtered.map(nftViewToInfo);
  },

  async getNFTInfo(_origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = params as ChiaMethodMap["getNFTInfo"]["params"];
    if (!p?.coinId && !p?.launcherId) {
      throw Errors.invalidParams("getNFTInfo requires { coinId } or { launcherId }");
    }
    const store = await readCoinStore(fp);
    const nfts = Object.values(store.nfts ?? {});
    const target = strip0x(p.launcherId ?? p.coinId ?? "");
    const match = nfts.find(
      (n) => strip0x(n.launcher_id) === target || strip0x(n.coin_id) === target,
    );
    return match ? nftViewToInfo(match) : null;
  },

  // cancelOffer:
  //   • secure=false (Goby default) → just mark the offer cancelled locally
  //     so the dApp UI can stop showing it. The on-chain coins remain
  //     spendable in an offer; this is a "drop my local copy" hint only.
  //   • secure=true → spend one of the maker's input coins back to ourselves
  //     so the offer can never be taken (its bundle requires the now-spent
  //     coin). This relies on createOffer having stored `input_xch_coins`
  //     for the offer; offers persisted before Fase 2 lack that field and
  //     fail with a clear instruction to recreate.
  //
  // Sage WC2 `chia_cancelOffer` has no `secure` flag and always means
  // on-chain. We force `secure: true` when the dApp called via that alias,
  // and return `{}` instead of `{id, cancelled}` to match Sage's response.
  async cancelOffer(origin, params, originalMethod) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = params as ChiaMethodMap["cancelOffer"]["params"];
    if (!p?.id) throw Errors.invalidParams("cancelOffer requires { id }");
    const wcShape = originalMethod === "chia_cancelOffer";
    const secure = wcShape ? true : (p.secure ?? true);

    const offerId = strip0x(p.id);
    const key = `offers.${fp}`;
    const data = await chrome.storage.local.get(key);
    const list = (data[key] as Array<{
      id: string;
      offer: string;
      cancelled?: boolean;
      origin?: string;
      input_xch_coins?: Array<{
        parent_coin_info: string;
        puzzle_hash: string;
        amount: string;
        derivation_index: number;
      }>;
    }> | undefined) ?? [];

    // Look up only offers this origin created. Legacy offers without an
    // origin tag are accessible to any origin for backwards-compat — new
    // offers (Fase 2+) always carry one.
    const stored = list.find(
      (o) => strip0x(o.id) === offerId && (o.origin == null || o.origin === origin),
    );

    if (!secure) {
      // Local-only cancel: idempotent, silent on unknown ids (matches the
      // Goby contract dApps depend on — they often call this defensively).
      let cancelled = false;
      if (stored && !stored.cancelled) {
        stored.cancelled = true;
        await chrome.storage.local.set({ [key]: list });
        cancelled = true;
      } else if (stored?.cancelled) {
        cancelled = true;
      }
      return (wcShape ? {} : { id: with0x(offerId) as Hex, cancelled }) as ChiaMethodMap["cancelOffer"]["result"];
    }

    // Secure path requires we know the offer locally so we can re-spend its
    // maker inputs. Unknown id → loud failure.
    if (!stored) {
      throw Errors.invalidParams(
        `Offer ${with0x(offerId)} not found in local storage — only locally-created offers can be cancelled on-chain`,
      );
    }
    if (stored.cancelled) {
      return (wcShape ? {} : { id: with0x(offerId) as Hex, cancelled: true }) as ChiaMethodMap["cancelOffer"]["result"];
    }

    // Secure path: invalidate the offer on chain by re-spending one of its
    // maker inputs. Fee, if any, is drained from the same coin so we don't
    // need to pick separate fee inputs.
    const fee = BigInt(String(p.fee ?? 0));
    const xchInputs = stored.input_xch_coins ?? [];
    if (xchInputs.length === 0) {
      throw new (class extends Error {
        code = 4004;
      })(
        "cancelOffer secure: this offer has no stored XCH input coins (created before Fase 2). " +
          "Recreate the offer, or use { secure: false } to drop it from local tracking only.",
      );
    }
    const firstInput = xchInputs[0]!;
    const inputAmount = BigInt(firstInput.amount);
    if (inputAmount <= fee) {
      throw Errors.spendableBalanceExceeded(
        `cancelOffer secure: maker input ${firstInput.parent_coin_info} amount ${inputAmount} can't cover fee ${fee}`,
      );
    }

    const addrs = await deriveAddresses(1);
    const recipient = addrs[0]!.address;
    const amountToSend = inputAmount - fee;

    const res = await callEngine<{ tx_id: string; error?: string }>("send_xch", {
      fingerprint: fp,
      recipient_address: recipient,
      amount_mojos: amountToSend.toString(),
      fee_mojos: fee.toString(),
      input_coins: [firstInput],
      change_index: firstInput.derivation_index,
      testnet: false,
      broadcast: true,
    });
    if (res.error) throw new Error(res.error);

    const store = await readCoinStore(fp);
    const cancelledCoinId = findXchCoinIdByOutpoint(
      store,
      with0x(firstInput.parent_coin_info),
      with0x(firstInput.puzzle_hash),
      firstInput.amount,
    );
    if (cancelledCoinId) {
      markXchSpentOptimistic(store, [cancelledCoinId]);
      await writeCoinStore(fp, store);
    }
    stored.cancelled = true;
    await chrome.storage.local.set({ [key]: list });

    return (wcShape ? {} : { id: with0x(offerId) as Hex, cancelled: true }) as ChiaMethodMap["cancelOffer"]["result"];
  },

  // Sage WC2 `chia_bulkMintNfts`: mint multiple NFTs against a DID in one
  // SpendBundle.
  //
  // Resolution of the DID's current head coin is the wrinkle: the WC2 spec
  // only passes `did` (bech32m launcher), but until Fase 3 lands DID sync
  // the JS coin-store has no way to look up the current unspent DID coin.
  // We accept `didCoinId` + `didDerivationIndex` as extra (non-WC2) params
  // so the dApp / test harness can plug them in directly; if they're
  // missing we throw a 4004 with the launcher_id surfaced so the caller
  // can resolve it externally.
  async bulkMintNfts(_origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = params as ChiaMethodMap["bulkMintNfts"]["params"] & {
      didCoinId?: string;
      didDerivationIndex?: number;
    };
    if (!p?.did) throw Errors.invalidParams("bulkMintNfts requires { did }");
    if (!p?.nfts?.length) {
      throw Errors.invalidParams("bulkMintNfts requires at least one entry in { nfts }");
    }

    // Decode the DID (bech32m, prefix `did:chia:`) → launcher_id hex.
    const didDecoded = await callEngine<{ valid: boolean; puzzle_hash?: string; prefix?: string }>(
      "decode_address",
      { address: p.did },
    );
    if (!didDecoded.valid || !didDecoded.puzzle_hash) {
      throw Errors.invalidParams(`bulkMintNfts: invalid DID encoding ${p.did}`);
    }
    const didLauncherId = strip0x(didDecoded.puzzle_hash);

    // Without DID tracking we can't resolve launcher → current coin. Fail
    // loudly with the launcher_id so the dApp/test can pass it back as
    // `didCoinId` + `didDerivationIndex` on retry.
    if (!p.didCoinId || p.didDerivationIndex === undefined) {
      throw new (class extends Error {
        code = 4004;
      })(
        `bulkMintNfts: DID tracking is not yet implemented (Fase 3). The WASM ` +
          `endpoint is wired, but resolving did "${p.did}" (launcher 0x${didLauncherId}) ` +
          `to its current unspent coin requires sage-wasm DID sync. As a workaround, ` +
          `pass { didCoinId, didDerivationIndex } alongside the standard payload — ` +
          `the dApp can obtain them via coinset.get_coin_records_by_hint(p2_puzzle_hash) ` +
          `and matching the singleton chain back to launcher 0x${didLauncherId}.`,
      );
    }

    // Decode each mint's recipient / royalty addresses (when provided) so
    // the WASM endpoint gets puzzle_hashes directly.
    const mints = await Promise.all(
      p.nfts.map(async (n, i) => {
        let p2_puzzle_hash: string | null = null;
        if (n.address) {
          const dec = await callEngine<{ valid: boolean; puzzle_hash?: string }>(
            "decode_address",
            { address: n.address },
          );
          if (!dec.valid || !dec.puzzle_hash) {
            throw Errors.invalidParams(`bulkMintNfts.nfts[${i}].address invalid: ${n.address}`);
          }
          p2_puzzle_hash = with0x(dec.puzzle_hash);
        }
        let royalty_puzzle_hash: string | null = null;
        if (n.royaltyAddress) {
          const dec = await callEngine<{ valid: boolean; puzzle_hash?: string }>(
            "decode_address",
            { address: n.royaltyAddress },
          );
          if (!dec.valid || !dec.puzzle_hash) {
            throw Errors.invalidParams(
              `bulkMintNfts.nfts[${i}].royaltyAddress invalid: ${n.royaltyAddress}`,
            );
          }
          royalty_puzzle_hash = with0x(dec.puzzle_hash);
        }

        // Sage's WC2 handler rejects URIs without their matching hash; mirror
        // that to keep the error surface aligned and the WASM call clean.
        if (n.dataUris?.length && !n.dataHash) {
          throw Errors.invalidParams(`bulkMintNfts.nfts[${i}]: dataHash required when dataUris present`);
        }
        if (n.metadataUris?.length && !n.metadataHash) {
          throw Errors.invalidParams(`bulkMintNfts.nfts[${i}]: metadataHash required when metadataUris present`);
        }
        if (n.licenseUris?.length && !n.licenseHash) {
          throw Errors.invalidParams(`bulkMintNfts.nfts[${i}]: licenseHash required when licenseUris present`);
        }

        return {
          p2_puzzle_hash,
          royalty_puzzle_hash,
          royalty_basis_points: n.royaltyTenThousandths ?? 0,
          data_uris: n.dataUris ?? [],
          data_hash: n.dataHash ? with0x(n.dataHash) : null,
          metadata_uris: n.metadataUris ?? [],
          metadata_hash: n.metadataHash ? with0x(n.metadataHash) : null,
          license_uris: n.licenseUris ?? [],
          license_hash: n.licenseHash ? with0x(n.licenseHash) : null,
          edition_number: n.editionNumber ?? 1,
          edition_total: n.editionTotal ?? 1,
        };
      }),
    );

    // Pick XCH inputs to cover the fee.
    const fee = BigInt(String(p.fee ?? 0));
    const phToIdx = await derivePhToIndex();
    const store = await readCoinStore(fp);

    const feeInputs: Array<{
      parent_coin_info: string;
      puzzle_hash: string;
      amount: string;
      derivation_index: number;
    }> = [];
    const feeInputIds: string[] = [];
    if (fee > 0n) {
      const candidates = Object.values(store.coins)
        .filter((c) => !c.spent && phToIdx[c.puzzle_hash] !== undefined)
        .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
      let running = 0n;
      for (const c of candidates) {
        if (running >= fee) break;
        feeInputs.push({
          parent_coin_info: c.parent_coin_info,
          puzzle_hash: c.puzzle_hash,
          amount: c.amount,
          derivation_index: phToIdx[c.puzzle_hash]!,
        });
        feeInputIds.push(c.coin_id);
        running += BigInt(c.amount);
      }
      if (running < fee) {
        throw Errors.spendableBalanceExceeded(
          `bulkMintNfts: need ${fee} XCH mojos for fee, only ${running} available`,
        );
      }
    }

    const changeIndex = feeInputs[0]?.derivation_index ?? p.didDerivationIndex;

    const res = await callEngine<{
      nft_launcher_ids: string[];
      tx_id: string;
      status: string;
      error?: string | null;
      did_launcher_id: string;
    }>("bulk_mint_nfts", {
      fingerprint: fp,
      did_coin_id: with0x(strip0x(p.didCoinId)),
      did_derivation_index: p.didDerivationIndex,
      mints,
      fee_mojos: fee.toString(),
      fee_input_coins: feeInputs,
      change_index: changeIndex,
      endpoint: "mainnet",
      broadcast: true,
    });
    if (res.error) throw new Error(res.error);

    if (feeInputIds.length) {
      markXchSpentOptimistic(store, feeInputIds);
      await writeCoinStore(fp, store);
    }

    // WC2 spec wants bech32m nft1… ids; we don't expose an encode endpoint
    // in WASM yet, so return 0x-prefixed launcher_ids. dApps that strictly
    // require bech32m can encode locally from the hex. Fase 3 will add the
    // encode_address endpoint to round-trip these properly.
    return {
      nftIds: res.nft_launcher_ids.map((id) => with0x(strip0x(id))),
    } as ChiaMethodMap["bulkMintNfts"]["result"];
  },

  // ── Loroco read-only extensions (WC-bypass surface) ──────────────────────
  // Served from the JS coin-store without engine round-trips. dApps targeting
  // Sage WC2 / upstream Sage API get a working read surface even though we
  // haven't ported those endpoints to sage-wasm yet.

  async getCoins(_origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = (params ?? {}) as ChiaMethodMap["getCoins"]["params"];
    const limit = (p?.limit ?? 1000) | 0;
    const offset = (p?.offset ?? 0) | 0;
    const includeSpent = p?.includeSpent === true;
    const store = await readCoinStore(fp);
    const out = collectCoinViews(store, p?.type ?? null, p?.assetId ?? null, includeSpent);
    return out.slice(offset, offset + limit);
  },

  async getCoinsByIds(_origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = params as ChiaMethodMap["getCoinsByIds"]["params"];
    if (!p?.coinIds || !Array.isArray(p.coinIds)) {
      throw Errors.invalidParams("getCoinsByIds requires { coinIds: Hex[] }");
    }
    const wanted = new Set(p.coinIds.map((id) => strip0x(id)));
    const store = await readCoinStore(fp);
    const all = collectCoinViews(store, null, null, true)
      .concat(collectCoinViews(store, "cat", null, true))
      .concat(collectCoinViews(store, "nft", null, true));
    return all.filter((c) => wanted.has(strip0x(c.coinId)));
  },

  async isAssetOwned(_origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = params as ChiaMethodMap["isAssetOwned"]["params"];
    if (!p?.type || !p?.assetId) {
      throw Errors.invalidParams("isAssetOwned requires { type, assetId }");
    }
    const store = await readCoinStore(fp);
    const targetId = strip0x(p.assetId);
    if (p.type === "cat") {
      const cat = (store.cats ?? {})[with0x(targetId)] ?? (store.cats ?? {})[targetId];
      return Boolean(cat?.coins?.some((c) => !c.spent));
    }
    if (p.type === "nft") {
      return Object.values(store.nfts ?? {}).some(
        (n) => !n.spent && strip0x(n.launcher_id) === targetId,
      );
    }
    // DID tracking pending — Fase 3.
    return false;
  },

  async getCats(_origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = (params ?? {}) as ChiaMethodMap["getCats"]["params"];
    const limit = (p?.limit ?? 200) | 0;
    const offset = (p?.offset ?? 0) | 0;
    const store = await readCoinStore(fp);
    const list = collectCatAssetViews(store);
    return list.slice(offset, offset + limit);
  },

  async getAllCats(_origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = (params ?? {}) as ChiaMethodMap["getAllCats"]["params"];
    const limit = (p?.limit ?? 200) | 0;
    const offset = (p?.offset ?? 0) | 0;
    const store = await readCoinStore(fp);
    const list = collectCatAssetViews(store);
    return list.slice(offset, offset + limit);
  },

  async getToken(_origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = params as ChiaMethodMap["getToken"]["params"];
    if (!p?.assetId) throw Errors.invalidParams("getToken requires { assetId }");
    const store = await readCoinStore(fp);
    const targetId = strip0x(p.assetId);
    const cat = (store.cats ?? {})[with0x(targetId)] ?? (store.cats ?? {})[targetId];
    return cat ? catAssetToView(targetId, cat) : null;
  },

  async getDerivations(_origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = (params ?? {}) as ChiaMethodMap["getDerivations"]["params"];
    const limit = (p?.limit ?? 50) | 0;
    const offset = (p?.offset ?? 0) | 0;
    const hardened = p?.hardened === true;
    if (hardened) {
      // Hardened needs the unlocked SK; engine refuses otherwise.
      const res = await callEngine<{
        addresses: Array<{ index: number; address: string; puzzle_hash: string; public_key: string }>;
      }>("derive_addresses_hardened", { fingerprint: fp, start: offset, count: limit, testnet: false });
      return res.addresses.map<Derivation>((a) => ({
        index: a.index,
        hardened: true,
        publicKey: with0x(a.public_key) as Hex,
        address: a.address,
        puzzleHash: with0x(a.puzzle_hash) as Hex,
      }));
    }
    const masterPk = await loadActiveMasterPk();
    if (!masterPk) throw Errors.unauthorized("No active wallet");
    const res = await callEngine<{
      addresses: Array<{ index: number; address: string; puzzle_hash: string; public_key: string }>;
    }>("derive_addresses", {
      master_public_key: masterPk,
      start: offset,
      count: limit,
      testnet: false,
    });
    return res.addresses.map<Derivation>((a) => ({
      index: a.index,
      hardened: false,
      publicKey: with0x(a.public_key) as Hex,
      address: a.address,
      puzzleHash: with0x(a.puzzle_hash) as Hex,
    }));
  },

  async getTransactions(_origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = (params ?? {}) as ChiaMethodMap["getTransactions"]["params"];
    const limit = (p?.limit ?? 100) | 0;
    const offset = (p?.offset ?? 0) | 0;
    const pendingOnly = p?.pendingOnly === true;
    const store = await readCoinStore(fp);
    const txs = buildTransactionHistory(store, pendingOnly);
    return txs.slice(offset, offset + limit);
  },

  async getPendingTransactions(_origin) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const store = await readCoinStore(fp);
    return buildTransactionHistory(store, true);
  },

  async getOffers(_origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = (params ?? {}) as ChiaMethodMap["getOffers"]["params"];
    const limit = (p?.limit ?? 100) | 0;
    const offset = (p?.offset ?? 0) | 0;
    const includeCancelled = p?.includeCancelled === true;
    const list = await loadOffers(fp);
    const filtered = list
      .filter((o) => includeCancelled || !o.cancelled)
      .map(offerToView);
    return filtered.slice(offset, offset + limit);
  },

  async getOffer(_origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = params as ChiaMethodMap["getOffer"]["params"];
    if (!p?.id) throw Errors.invalidParams("getOffer requires { id }");
    const list = await loadOffers(fp);
    const target = strip0x(p.id);
    const match = list.find((o) => strip0x(o.id) === target);
    return match ? offerToView(match) : null;
  },

  // ── Oleada 2 — multi-output writes ──────────────────────────────────────
  // Auto-select inputs from the wallet's own coin-store, build a multi-output
  // payload, and forward to the extended send_xch / send_cat WASM endpoints.
  // Optimistic-spent reconciliation matches the existing transfer handler.

  async bulkSendXch(_origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = params as ChiaMethodMap["bulkSendXch"]["params"];
    if (!p?.outputs?.length) {
      throw Errors.invalidParams("bulkSendXch requires non-empty { outputs }");
    }
    const fee = BigInt(String(p.fee ?? 0));
    const totalOut = p.outputs.reduce((s, o) => s + BigInt(String(o.amount)), 0n);
    const need = totalOut + fee;
    const { inputs, inputCoinIds, store } = await pickXchInputs(fp, need);
    const res = await callEngine<{ tx_id: string; error?: string }>("send_xch", {
      fingerprint: fp,
      outputs: p.outputs.map((o) => ({ address: o.address, amount: String(o.amount) })),
      fee_mojos: fee.toString(),
      input_coins: inputs,
      change_index: inputs[0]!.derivation_index,
      testnet: false,
      broadcast: true,
    });
    if (res.error) throw new Error(res.error);
    markXchSpentOptimistic(store, inputCoinIds);
    await writeCoinStore(fp, store);
    return { id: with0x(res.tx_id) as Hex };
  },

  async bulkSendCat(_origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = params as ChiaMethodMap["bulkSendCat"]["params"];
    if (!p?.assetId) throw Errors.invalidParams("bulkSendCat requires { assetId }");
    if (!p?.outputs?.length) {
      throw Errors.invalidParams("bulkSendCat requires non-empty { outputs }");
    }
    const fee = BigInt(String(p.fee ?? 0));
    const totalOut = p.outputs.reduce((s, o) => s + BigInt(String(o.amount)), 0n);
    const assetId = strip0x(p.assetId);
    const phToIdx = await derivePhToIndex();
    const store = await readCoinStore(fp);
    const cat = (store.cats ?? {})[with0x(assetId)] ?? (store.cats ?? {})[assetId];
    if (!cat) {
      throw Errors.spendableBalanceExceeded(
        `bulkSendCat: wallet doesn't track CAT ${with0x(assetId)}. ${describeAvailableCats(store)}`,
      );
    }
    const sorted = cat.coins
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
    const pickedIds: string[] = [];
    let running = 0n;
    for (const c of sorted) {
      if (running >= totalOut) break;
      picked.push({
        parent_coin_info: c.parent_coin_info,
        puzzle_hash: c.puzzle_hash,
        amount: c.amount,
        inner_puzzle_hash: c.inner_puzzle_hash,
        derivation_index: phToIdx[c.inner_puzzle_hash]!,
        lineage_proof: c.lineage_proof,
      });
      pickedIds.push(c.coin_id);
      running += BigInt(c.amount);
    }
    if (running < totalOut) {
      throw Errors.spendableBalanceExceeded(
        `bulkSendCat: need ${totalOut} of CAT ${with0x(assetId)}, only ${running} available`,
      );
    }
    const res = await callEngine<{ tx_id: string; error?: string }>("send_cat", {
      fingerprint: fp,
      asset_id: with0x(assetId),
      outputs: p.outputs.map((o) => ({ address: o.address, amount: String(o.amount) })),
      fee_mojos: fee.toString(),
      input_coins: picked,
      change_index: picked[0]!.derivation_index,
      broadcast: true,
    });
    if (res.error) throw new Error(res.error);
    markCatSpentOptimistic(store, with0x(assetId), pickedIds);
    await writeCoinStore(fp, store);
    return { id: with0x(res.tx_id) as Hex };
  },

  async combine(_origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = (params ?? {}) as ChiaMethodMap["combine"]["params"];
    const fee = BigInt(String(p?.fee ?? 0));
    const maxInputs = Math.max(2, Math.min(50, (p?.maxInputs ?? 10) | 0));
    const phToIdx = await derivePhToIndex();
    const store = await readCoinStore(fp);
    // Take the N smallest unspent XCH coins — that's the dust-consolidation case.
    const candidates = Object.values(store.coins)
      .filter((c) => !c.spent && phToIdx[c.puzzle_hash] !== undefined)
      .sort((a, b) => (BigInt(a.amount) > BigInt(b.amount) ? 1 : -1))
      .slice(0, maxInputs);
    if (candidates.length < 2) {
      throw Errors.invalidParams(
        `combine needs at least 2 spendable XCH coins, found ${candidates.length}`,
      );
    }
    const total = candidates.reduce((s, c) => s + BigInt(c.amount), 0n);
    if (total <= fee) {
      throw Errors.spendableBalanceExceeded(
        `combine: selected ${candidates.length} coins totalling ${total} mojos, fee ${fee} leaves nothing`,
      );
    }
    const out = total - fee;
    const inputs = candidates.map((c) => ({
      parent_coin_info: c.parent_coin_info,
      puzzle_hash: c.puzzle_hash,
      amount: c.amount,
      derivation_index: phToIdx[c.puzzle_hash]!,
    }));
    const inputCoinIds = candidates.map((c) => c.coin_id);
    const addrs = await deriveAddresses(1);
    const recipient = addrs[0]!.address;
    const res = await callEngine<{ tx_id: string; error?: string }>("send_xch", {
      fingerprint: fp,
      outputs: [{ address: recipient, amount: out.toString() }],
      fee_mojos: fee.toString(),
      input_coins: inputs,
      change_index: inputs[0]!.derivation_index,
      testnet: false,
      broadcast: true,
    });
    if (res.error) throw new Error(res.error);
    markXchSpentOptimistic(store, inputCoinIds);
    await writeCoinStore(fp, store);
    return { id: with0x(res.tx_id) as Hex };
  },

  async split(_origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = (params ?? {}) as ChiaMethodMap["split"]["params"];
    const parts = Math.max(2, Math.min(25, (p?.parts ?? 2) | 0));
    const fee = BigInt(String(p?.fee ?? 0));
    const phToIdx = await derivePhToIndex();
    const store = await readCoinStore(fp);
    // Use the largest unspent XCH coin as the single input.
    const candidates = Object.values(store.coins)
      .filter((c) => !c.spent && phToIdx[c.puzzle_hash] !== undefined)
      .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
    const input = candidates[0];
    if (!input) {
      throw Errors.spendableBalanceExceeded("split: no spendable XCH coins");
    }
    const total = BigInt(input.amount);
    if (total <= fee + BigInt(parts)) {
      throw Errors.spendableBalanceExceeded(
        `split: coin ${input.coin_id} (${total} mojos) too small for ${parts} parts + fee ${fee}`,
      );
    }
    const usable = total - fee;
    const each = usable / BigInt(parts);
    if (each === 0n) {
      throw Errors.invalidParams(
        `split: each output would be 0 mojos (usable=${usable}, parts=${parts})`,
      );
    }
    // Give the remainder to the last output so the bundle balances.
    const remainder = usable - each * BigInt(parts);
    const addrs = await deriveAddresses(parts);
    const outputs = addrs.slice(0, parts).map((a, i) => ({
      address: a.address,
      amount: (i === parts - 1 ? each + remainder : each).toString(),
    }));
    const inputs = [
      {
        parent_coin_info: input.parent_coin_info,
        puzzle_hash: input.puzzle_hash,
        amount: input.amount,
        derivation_index: phToIdx[input.puzzle_hash]!,
      },
    ];
    const res = await callEngine<{ tx_id: string; error?: string }>("send_xch", {
      fingerprint: fp,
      outputs,
      fee_mojos: fee.toString(),
      input_coins: inputs,
      change_index: inputs[0]!.derivation_index,
      testnet: false,
      broadcast: true,
    });
    if (res.error) throw new Error(res.error);
    markXchSpentOptimistic(store, [input.coin_id]);
    await writeCoinStore(fp, store);
    return { id: with0x(res.tx_id) as Hex };
  },

  // ── Oleada 3 — issuance + DID creation ──────────────────────────────────
  // Each picks ONE XCH input large enough to cover `amount` (for issueCat:
  // the eve CAT mojos) or 1 (for createDid: the singleton launcher), plus
  // fee. The XCH coin must come from the wallet's own derivation window.

  async issueCat(_origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = params as ChiaMethodMap["issueCat"]["params"];
    if (!p?.recipientAddress) {
      throw Errors.invalidParams("issueCat requires { recipientAddress }");
    }
    if (!p?.amount) {
      throw Errors.invalidParams("issueCat requires { amount }");
    }
    const amount = BigInt(String(p.amount));
    const fee = BigInt(String(p.fee ?? 0));
    if (amount <= 0n) {
      throw Errors.invalidParams("issueCat: amount must be > 0");
    }
    const need = amount + fee;
    const input = await pickSingleXchInput(fp, need);
    const res = await callEngine<{ tx_id: string; asset_id: string; error?: string }>(
      "issue_cat",
      {
        fingerprint: fp,
        recipient_address: p.recipientAddress,
        amount_mojos: amount.toString(),
        fee_mojos: fee.toString(),
        input_coin: input.coin,
        change_index: input.coin.derivation_index,
        broadcast: true,
      },
    );
    if (res.error) throw new Error(res.error);
    markXchSpentOptimistic(input.store, [input.coinId]);
    await writeCoinStore(fp, input.store);
    return {
      id: with0x(res.tx_id) as Hex,
      assetId: with0x(res.asset_id) as Hex,
    };
  },

  async createDid(_origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = (params ?? {}) as ChiaMethodMap["createDid"]["params"];
    const fee = BigInt(String(p?.fee ?? 0));
    // Singleton launcher = 1 mojo, locked in by chia_wallet_sdk.
    const need = 1n + fee;
    const input = await pickSingleXchInput(fp, need);
    const res = await callEngine<{
      tx_id: string;
      did_id: string;
      launcher_id: string;
      error?: string;
    }>("create_did", {
      fingerprint: fp,
      fee_mojos: fee.toString(),
      input_coin: input.coin,
      change_index: input.coin.derivation_index,
      broadcast: true,
    });
    if (res.error) throw new Error(res.error);
    markXchSpentOptimistic(input.store, [input.coinId]);
    await writeCoinStore(fp, input.store);
    return {
      id: with0x(res.tx_id) as Hex,
      didId: with0x(res.did_id) as Hex,
    };
  },

  async addNftUri(_origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = params as ChiaMethodMap["addNftUri"]["params"];
    if (!p?.launcherId && !p?.coinId) {
      throw Errors.invalidParams("addNftUri requires { launcherId } or { coinId }");
    }
    if (!p?.uriKind) {
      throw Errors.invalidParams("addNftUri requires { uriKind }");
    }
    if (!p?.uri || !p.uri.trim()) {
      throw Errors.invalidParams("addNftUri requires non-empty { uri }");
    }

    // Resolve to the current NFT head coin via the local store. We accept
    // either launcherId (preferred — stable across re-spends) or coinId.
    const store = await readCoinStore(fp);
    const target = strip0x((p.launcherId ?? p.coinId)!);
    const nft = Object.values(store.nfts ?? {}).find((n) => {
      if (n.spent) return false;
      return (
        strip0x(n.launcher_id) === target || strip0x(n.coin_id) === target
      );
    });
    if (!nft) {
      throw Errors.invalidParams(
        `addNftUri: NFT ${with0x(target)} not found in wallet (spent or not yet synced)`,
      );
    }
    // Resolve derivation_index for the NFT's p2 inner_puzzle_hash.
    const phToIdx = await derivePhToIndex();
    const derivationIndex = phToIdx[nft.p2_puzzle_hash];
    if (derivationIndex === undefined) {
      throw Errors.invalidParams(
        `addNftUri: NFT ${with0x(nft.launcher_id)} p2 ${nft.p2_puzzle_hash} ` +
          `not in current derivation window (${DERIVATION_WINDOW})`,
      );
    }

    const fee = BigInt(String(p.fee ?? 0));
    // Pay the fee from an XCH input when > 0. addNftUri's WASM endpoint
    // expects `fee_input_coins` to cover the fee fully.
    let feeInputs: Array<{
      parent_coin_info: string;
      puzzle_hash: string;
      amount: string;
      derivation_index: number;
    }> = [];
    let feeInputIds: string[] = [];
    if (fee > 0n) {
      const picked = await pickXchInputs(fp, fee);
      feeInputs = picked.inputs;
      feeInputIds = picked.inputCoinIds;
      // pickXchInputs returns its own store snapshot; we already loaded ours
      // above for the NFT lookup. Merge the optimistic-spent marker onto our
      // snapshot below.
    }

    const res = await callEngine<{ tx_id: string; launcher_id: string; error?: string }>(
      "add_nft_uri",
      {
        fingerprint: fp,
        coin_id: with0x(nft.coin_id),
        parent_coin_info: with0x(nft.parent_coin_info),
        derivation_index: derivationIndex,
        uri_kind: p.uriKind,
        uri: p.uri,
        fee_mojos: fee.toString(),
        fee_input_coins: feeInputs,
        fee_change_index: derivationIndex,
        broadcast: true,
      },
    );
    if (res.error) throw new Error(res.error);
    if (feeInputIds.length > 0) {
      markXchSpentOptimistic(store, feeInputIds);
    }
    await writeCoinStore(fp, store);
    return {
      id: with0x(res.tx_id) as Hex,
      launcherId: with0x(res.launcher_id) as Hex,
    };
  },

  async transferDid(_origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = params as ChiaMethodMap["transferDid"]["params"];
    if (!p?.didCoinId) {
      throw Errors.invalidParams("transferDid requires { didCoinId }");
    }
    if (p?.didDerivationIndex === undefined || p.didDerivationIndex === null) {
      throw Errors.invalidParams("transferDid requires { didDerivationIndex }");
    }
    if (!p?.recipientAddress) {
      throw Errors.invalidParams("transferDid requires { recipientAddress }");
    }

    const fee = BigInt(String(p.fee ?? 0));
    let feeInputs: Array<{
      parent_coin_info: string;
      puzzle_hash: string;
      amount: string;
      derivation_index: number;
    }> = [];
    let feeInputIds: string[] = [];
    let store: import("./coin-store.js").CoinStore | null = null;
    if (fee > 0n) {
      const picked = await pickXchInputs(fp, fee);
      feeInputs = picked.inputs;
      feeInputIds = picked.inputCoinIds;
      store = picked.store;
    }

    const res = await callEngine<{ tx_id: string; launcher_id: string; error?: string }>(
      "transfer_did",
      {
        fingerprint: fp,
        did_coin_id: with0x(strip0x(p.didCoinId)),
        did_derivation_index: p.didDerivationIndex,
        recipient_address: p.recipientAddress,
        fee_mojos: fee.toString(),
        fee_input_coins: feeInputs,
        fee_change_index: p.didDerivationIndex,
        broadcast: true,
      },
    );
    if (res.error) throw new Error(res.error);
    if (store && feeInputIds.length > 0) {
      markXchSpentOptimistic(store, feeInputIds);
      await writeCoinStore(fp, store);
    }
    return {
      id: with0x(res.tx_id) as Hex,
      launcherId: with0x(res.launcher_id) as Hex,
    };
  },

  // ── Fase 3 stubs — empty reads to silence WC2 dApp probes ───────────────
  // These return [] / null instead of 4004 so dApps that probe for DIDs /
  // collections on connect render gracefully. Real implementations land
  // when JS-side DID sync is wired.

  async getDids() {
    return [] as ChiaMethodMap["getDids"]["result"];
  },

  async getNftCollections() {
    return [] as ChiaMethodMap["getNftCollections"]["result"];
  },

  async getNftCollection() {
    return null as ChiaMethodMap["getNftCollection"]["result"];
  },

  async getMinterDidIds() {
    return [] as ChiaMethodMap["getMinterDidIds"]["result"];
  },
};

// ─── Helpers for Oleada 2 writes ───────────────────────────────────────────

/**
 * Pick wallet-owned unspent XCH coins (largest-first) covering `need` mojos.
 * Returns the engine-shape input array and the matching coin_ids for
 * optimistic-spent marking, plus the store so the caller can persist.
 */
async function pickXchInputs(
  fp: number,
  need: bigint,
): Promise<{
  inputs: Array<{ parent_coin_info: string; puzzle_hash: string; amount: string; derivation_index: number }>;
  inputCoinIds: string[];
  store: import("./coin-store.js").CoinStore;
}> {
  const phToIdx = await derivePhToIndex();
  const store = await readCoinStore(fp);
  const candidates = Object.values(store.coins)
    .filter((c) => !c.spent && phToIdx[c.puzzle_hash] !== undefined)
    .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
  const inputs: Array<{ parent_coin_info: string; puzzle_hash: string; amount: string; derivation_index: number }> = [];
  const inputCoinIds: string[] = [];
  let running = 0n;
  for (const c of candidates) {
    if (running >= need) break;
    inputs.push({
      parent_coin_info: c.parent_coin_info,
      puzzle_hash: c.puzzle_hash,
      amount: c.amount,
      derivation_index: phToIdx[c.puzzle_hash]!,
    });
    inputCoinIds.push(c.coin_id);
    running += BigInt(c.amount);
  }
  if (running < need) {
    throw Errors.spendableBalanceExceeded(
      `Need ${need} XCH mojos (incl. fee), only ${running} available`,
    );
  }
  return { inputs, inputCoinIds, store };
}

/**
 * Pick a single XCH coin from the wallet large enough to cover `need`.
 * Sorted largest-first so the smallest viable coin wins (cheapest in terms
 * of dust left behind as change). Throws spendable-exceeded when no coin
 * meets the threshold; we don't combine in this path since both issueCat
 * and createDid need a SINGLE genesis parent.
 */
async function pickSingleXchInput(
  fp: number,
  need: bigint,
): Promise<{
  coin: { parent_coin_info: string; puzzle_hash: string; amount: string; derivation_index: number };
  coinId: string;
  store: import("./coin-store.js").CoinStore;
}> {
  const phToIdx = await derivePhToIndex();
  const store = await readCoinStore(fp);
  // Smallest viable first → less change generated.
  const candidates = Object.values(store.coins)
    .filter((c) => !c.spent && phToIdx[c.puzzle_hash] !== undefined && BigInt(c.amount) >= need)
    .sort((a, b) => (BigInt(a.amount) > BigInt(b.amount) ? 1 : -1));
  const picked = candidates[0];
  if (!picked) {
    const largest = Object.values(store.coins)
      .filter((c) => !c.spent)
      .reduce((m, c) => (BigInt(c.amount) > m ? BigInt(c.amount) : m), 0n);
    throw Errors.spendableBalanceExceeded(
      `Need a single XCH coin >= ${need} mojos (incl. fee); largest unspent is ${largest}`,
    );
  }
  return {
    coin: {
      parent_coin_info: picked.parent_coin_info,
      puzzle_hash: picked.puzzle_hash,
      amount: picked.amount,
      derivation_index: phToIdx[picked.puzzle_hash]!,
    },
    coinId: picked.coin_id,
    store,
  };
}

// ─── Helpers for the read-only extensions ──────────────────────────────────

function collectCoinViews(
  store: import("./coin-store.js").CoinStore,
  type: "xch" | "cat" | "did" | "nft" | null,
  assetId: Hex | null,
  includeSpent: boolean,
): CoinView[] {
  const out: CoinView[] = [];
  if (!type || type === "xch") {
    for (const c of Object.values(store.coins)) {
      if (c.spent && !includeSpent) continue;
      out.push({
        coinId: with0x(c.coin_id) as Hex,
        parentCoinInfo: with0x(c.parent_coin_info) as Hex,
        puzzleHash: with0x(c.puzzle_hash) as Hex,
        amount: c.amount,
        confirmedBlockIndex: c.confirmed_block_index,
        spent: c.spent,
        spentBlockIndex: c.spent_block_index,
        assetType: "xch",
        assetId: null,
        pending: c.pending,
      });
    }
  }
  if (type === "cat") {
    const buckets = assetId
      ? [
          (store.cats ?? {})[with0x(strip0x(assetId))] ??
            (store.cats ?? {})[strip0x(assetId)],
        ].filter(Boolean)
      : Object.values(store.cats ?? {});
    for (const cat of buckets) {
      if (!cat) continue;
      for (const c of cat.coins) {
        if (c.spent && !includeSpent) continue;
        out.push({
          coinId: with0x(c.coin_id) as Hex,
          parentCoinInfo: with0x(c.parent_coin_info) as Hex,
          puzzleHash: with0x(c.puzzle_hash) as Hex,
          amount: c.amount,
          confirmedBlockIndex: c.confirmed_block_index,
          spent: c.spent,
          spentBlockIndex: c.spent_block_index,
          assetType: "cat",
          assetId: with0x(cat.asset_id) as Hex,
          pending: c.pending,
        });
      }
    }
  }
  if (type === "nft") {
    for (const nft of Object.values(store.nfts ?? {})) {
      if (nft.spent && !includeSpent) continue;
      if (assetId && strip0x(assetId) !== strip0x(nft.launcher_id)) continue;
      out.push({
        coinId: with0x(nft.coin_id) as Hex,
        parentCoinInfo: with0x(nft.parent_coin_info) as Hex,
        puzzleHash: with0x(nft.puzzle_hash) as Hex,
        amount: nft.amount,
        confirmedBlockIndex: nft.confirmed_block_index,
        spent: nft.spent,
        spentBlockIndex: nft.spent_block_index,
        assetType: "nft",
        assetId: with0x(nft.launcher_id) as Hex,
      });
    }
  }
  return out;
}

function collectCatAssetViews(
  store: import("./coin-store.js").CoinStore,
): CatAssetView[] {
  const out: CatAssetView[] = [];
  for (const [, cat] of Object.entries(store.cats ?? {})) {
    out.push(catAssetToView(cat.asset_id, cat));
  }
  // Sort biggest balance first — dApp UIs assume "most relevant on top".
  out.sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1));
  return out;
}

function catAssetToView(
  assetId: string,
  cat: import("./coin-store.js").CatAsset,
): CatAssetView {
  return {
    assetId: with0x(strip0x(assetId)) as Hex,
    balance: cat.total_unspent_mojos,
    coinCount: cat.unspent_coin_count,
    name: null,
    symbol: null,
    iconUrl: null,
  };
}

/**
 * Synthesize a tx history from coin observations + the mempool snapshot.
 * One coin creation → one "incoming" entry; one coin spend → one "outgoing"
 * entry. Pending entries come from the mempool snapshot and use the
 * mempool tx_id; confirmed entries fall back to the coin_id as the id.
 *
 * Ordering: newest first. Pending always before confirmed when heights tie.
 */
function buildTransactionHistory(
  store: import("./coin-store.js").CoinStore,
  pendingOnly: boolean,
): TransactionView[] {
  const out: TransactionView[] = [];

  const mempool = store.mempool ?? { incoming: [], outgoing: [], last_polled_at: 0 };
  for (const inc of mempool.incoming) {
    out.push({
      id: with0x(inc.tx_id) as Hex,
      direction: "incoming",
      status: "pending",
      height: null,
      timestamp: inc.seen_at,
      asset: {
        type: inc.asset_id ? "cat" : "xch",
        assetId: inc.asset_id ? (with0x(inc.asset_id) as Hex) : null,
      },
      amount: inc.amount,
    });
  }
  for (const out_ of mempool.outgoing) {
    // Surface one entry per spent coin so the dApp can render asset-aware rows.
    for (const xchId of out_.spent_xch_coin_ids) {
      const c = store.coins[xchId];
      out.push({
        id: with0x(out_.tx_id) as Hex,
        direction: "outgoing",
        status: "pending",
        height: null,
        timestamp: out_.seen_at,
        asset: { type: "xch", assetId: null },
        amount: c?.amount ?? "0",
      });
    }
    for (const [assetId, coinIds] of Object.entries(out_.spent_cat_coin_ids)) {
      const cat = (store.cats ?? {})[assetId] ?? (store.cats ?? {})[with0x(assetId)];
      for (const coinId of coinIds) {
        const c = cat?.coins.find((x) => x.coin_id === coinId);
        out.push({
          id: with0x(out_.tx_id) as Hex,
          direction: "outgoing",
          status: "pending",
          height: null,
          timestamp: out_.seen_at,
          asset: { type: "cat", assetId: with0x(strip0x(assetId)) as Hex },
          amount: c?.amount ?? "0",
        });
      }
    }
  }

  if (pendingOnly) {
    return out.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  }

  // Confirmed XCH: one entry on creation, one more when spent (post-confirm).
  for (const c of Object.values(store.coins)) {
    if (c.pending) continue; // pending-spent already shown via mempool
    if (c.confirmed_block_index > 0) {
      out.push({
        id: with0x(c.coin_id) as Hex,
        direction: "incoming",
        status: "confirmed",
        height: c.confirmed_block_index,
        timestamp: c.timestamp ? c.timestamp * 1000 : null,
        asset: { type: "xch", assetId: null },
        amount: c.amount,
      });
    }
    if (c.spent && c.spent_block_index > 0) {
      out.push({
        id: with0x(c.coin_id) as Hex,
        direction: "outgoing",
        status: "confirmed",
        height: c.spent_block_index,
        timestamp: null,
        asset: { type: "xch", assetId: null },
        amount: c.amount,
      });
    }
  }

  // Confirmed CATs.
  for (const cat of Object.values(store.cats ?? {})) {
    const assetIdHex = with0x(strip0x(cat.asset_id)) as Hex;
    for (const c of cat.coins) {
      if (c.pending) continue;
      if (c.confirmed_block_index > 0) {
        out.push({
          id: with0x(c.coin_id) as Hex,
          direction: "incoming",
          status: "confirmed",
          height: c.confirmed_block_index,
          timestamp: null,
          asset: { type: "cat", assetId: assetIdHex },
          amount: c.amount,
        });
      }
      if (c.spent && c.spent_block_index > 0) {
        out.push({
          id: with0x(c.coin_id) as Hex,
          direction: "outgoing",
          status: "confirmed",
          height: c.spent_block_index,
          timestamp: null,
          asset: { type: "cat", assetId: assetIdHex },
          amount: c.amount,
        });
      }
    }
  }

  // Sort: pending first (no height), then confirmed by descending height.
  out.sort((a, b) => {
    if (a.status !== b.status) return a.status === "pending" ? -1 : 1;
    return (b.height ?? 0) - (a.height ?? 0);
  });
  return out;
}

interface StoredOffer {
  id: string;
  offer: string;
  cancelled?: boolean;
  created_at?: number;
}

async function loadOffers(fp: number): Promise<StoredOffer[]> {
  const key = `offers.${fp}`;
  const data = await chrome.storage.local.get(key);
  return ((data[key] as StoredOffer[] | undefined) ?? []).slice().reverse();
}

function offerToView(o: StoredOffer): OfferView {
  return {
    id: with0x(strip0x(o.id)) as Hex,
    offer: o.offer,
    cancelled: o.cancelled === true,
    createdAt: o.created_at ?? 0,
  };
}

/** Local CoinStore.NftView → wire NftInfo. */
function nftViewToInfo(
  n: import("./coin-store.js").NftView,
): import("@ozone/goby-provider/types").NftInfo {
  return {
    launcher_id: with0x(n.launcher_id) as Hex,
    nft_coin_id: with0x(n.coin_id) as Hex,
    owner_did: n.current_owner_did ? (with0x(n.current_owner_did) as Hex) : null,
    royalty_address: with0x(n.royalty_puzzle_hash) as Hex,
    royalty_percentage: n.royalty_basis_points,
    data_uris: n.metadata.data_uris ?? [],
    data_hash: n.metadata.data_hash ? (with0x(n.metadata.data_hash) as Hex) : null,
    metadata_uris: n.metadata.metadata_uris ?? [],
    metadata_hash: n.metadata.metadata_hash
      ? (with0x(n.metadata.metadata_hash) as Hex)
      : null,
    license_uris: n.metadata.license_uris ?? [],
    license_hash: n.metadata.license_hash ? (with0x(n.metadata.license_hash) as Hex) : null,
    edition_number: n.metadata.edition_number,
    edition_total: n.metadata.edition_total,
    p2_puzzle_hash: with0x(n.p2_puzzle_hash) as Hex,
  };
}

/**
 * Local CoinStore.NftView → Sage WC2 NftWcInfo. camelCase, nullable fields.
 *
 * Fields the local store doesn't track yet (`name`, `collectionId`,
 * `collectionName`, `minterDid`, `createdHeight`) are surfaced as null — the
 * Sage WC2 zod schema explicitly allows null for all of them. `address` and
 * `royaltyAddress` are emitted as 0x-prefixed puzzle_hash hex rather than
 * bech32m: we don't expose an `encode_address` endpoint in the WASM engine
 * today, and synth-encoding bech32m in JS isn't worth the dependency for
 * Fase 1. dApps that strictly require bech32m can call `chia_getAddress`
 * for the wallet's own address and resolve royalty addresses externally.
 */
function nftViewToWcInfo(
  n: import("./coin-store.js").NftView,
): import("@ozone/goby-provider/types").NftWcInfo {
  return {
    name: null,
    launcherId: with0x(n.launcher_id) as Hex,
    collectionId: null,
    collectionName: null,
    minterDid: null,
    ownerDid: n.current_owner_did ? (with0x(n.current_owner_did) as Hex) : null,
    createdHeight: null,
    coinId: with0x(n.coin_id) as Hex,
    address: with0x(n.p2_puzzle_hash),
    royaltyAddress: with0x(n.royalty_puzzle_hash),
    royaltyTenThousandths: n.royalty_basis_points,
    dataUris: n.metadata.data_uris ?? [],
    dataHash: n.metadata.data_hash ? (with0x(n.metadata.data_hash) as Hex) : null,
    metadataUris: n.metadata.metadata_uris ?? [],
    metadataHash: n.metadata.metadata_hash
      ? (with0x(n.metadata.metadata_hash) as Hex)
      : null,
    licenseUris: n.metadata.license_uris ?? [],
    licenseHash: n.metadata.license_hash ? (with0x(n.metadata.license_hash) as Hex) : null,
    editionNumber: n.metadata.edition_number ?? null,
    editionTotal: n.metadata.edition_total ?? null,
  };
}

export async function handleRpc<M extends ChiaMethod>(
  origin: string,
  method: M,
  params: ChiaMethodMap[M]["params"],
  originalMethod: string = method,
): Promise<ChiaMethodMap[M]["result"]> {
  // Approval gate for methods that mutate state, sign things, or transmit.
  // `connect` / `requestAccounts` pop their own approval inside the handler.
  let effectiveParams = params;
  if (APPROVAL_REQUIRED.has(method)) {
    const decision = await requestApproval(origin, method, params);
    if (!decision.approved) throw Errors.userRejected();
    // Merge any per-method overrides the user supplied via the approval UI
    // (e.g. fee picker for createOffer) on top of the dApp's original params.
    if (decision.overrides && typeof params === "object" && params != null) {
      effectiveParams = {
        ...(params as Record<string, unknown>),
        ...decision.overrides,
      } as ChiaMethodMap[M]["params"];
    } else if (decision.overrides) {
      effectiveParams = decision.overrides as ChiaMethodMap[M]["params"];
    }
  }

  const handler = handlers[method] as Handler<M> | undefined;
  if (handler) return handler(origin, effectiveParams, originalMethod);

  throw Errors.methodNotFound(method);
}
