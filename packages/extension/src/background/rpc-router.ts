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
  "signMessageByAddress",
  "signCoinSpends",
  "transfer",
  "sendTransaction",
  "createOffer",
  "takeOffer",
  "cancelOffer",
  "walletSwitchChain",
  "walletWatchAsset",
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
const METHOD_ALIASES: Record<string, ChiaMethod> = {
  // chia_* (Goby legacy + Sage WC2)
  chia_chainId: "chainId",
  chia_connect: "connect",
  chia_requestAccounts: "requestAccounts",
  chia_accounts: "accounts",
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
  chia_walletSwitchChain: "walletSwitchChain",
  chia_walletWatchAsset: "walletWatchAsset",
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
};

/** Normalise an alias/legacy method name down to its CHIP-0002 canonical. */
export function canonicalizeMethod(method: string): ChiaMethod {
  return (METHOD_ALIASES[method] ?? method) as ChiaMethod;
}

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
  async createOffer(_origin, params) {
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
        throw Errors.spendableBalanceExceeded(`Offered CAT ${assetId} not in wallet`);
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

    // Persist the offer so cancelOffer({secure:false}) can drop it later.
    const key = `offers.${fp}`;
    const data = await chrome.storage.local.get(key);
    const list = (data[key] as Array<{
      id: string;
      offer: string;
      created_at: number;
      cancelled?: boolean;
    }> | undefined) ?? [];
    list.push({
      id: res.offer_id,
      offer: res.offer,
      created_at: Date.now(),
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
  async getNFTs(_origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = (params ?? {}) as ChiaMethodMap["getNFTs"]["params"];
    const limit = (p?.limit ?? 50) | 0;
    const offset = (p?.offset ?? 0) | 0;
    const didFilter = p?.didId ? strip0x(p.didId) : null;
    const store = await readCoinStore(fp);

    const all = Object.values(store.nfts ?? {})
      .filter((n) => !n.spent)
      .filter((n) =>
        didFilter == null ? true : strip0x(n.current_owner_did ?? "") === didFilter,
      )
      .slice(offset, offset + limit)
      .map(nftViewToInfo);
    return all;
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

  // cancelOffer: with secure=false (the Goby default), we just drop the
  // tracked offer from local storage so the dApp can recreate it. A "secure"
  // cancellation that actually spends the offered coins back to the wallet
  // needs the engine's `make_offer`-style coin selection — not yet wired,
  // so we surface a clear MethodNotFound to keep the dApp UX honest.
  async cancelOffer(_origin, params) {
    const fp = await loadActiveFingerprint();
    if (fp == null) throw Errors.unauthorized("No active wallet");
    const p = params as ChiaMethodMap["cancelOffer"]["params"];
    if (!p?.id) throw Errors.invalidParams("cancelOffer requires { id }");
    const secure = p.secure ?? true;
    if (secure) {
      throw new (class extends Error {
        code = 4004;
      })(
        "Secure cancelOffer is not implemented yet — pass { secure: false } to drop the offer from local tracking only.",
      );
    }
    const offerId = strip0x(p.id);
    const key = `offers.${fp}`;
    const data = await chrome.storage.local.get(key);
    const list = (data[key] as Array<{ id: string; cancelled?: boolean }> | undefined) ?? [];
    let cancelled = false;
    for (const o of list) {
      if (strip0x(o.id) === offerId && !o.cancelled) {
        o.cancelled = true;
        cancelled = true;
      }
    }
    if (cancelled) await chrome.storage.local.set({ [key]: list });
    return { id: with0x(offerId) as Hex, cancelled };
  },
};

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

export async function handleRpc<M extends ChiaMethod>(
  origin: string,
  method: M,
  params: ChiaMethodMap[M]["params"],
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
  if (handler) return handler(origin, effectiveParams);

  throw Errors.methodNotFound(method);
}
