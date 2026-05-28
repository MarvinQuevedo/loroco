// Popup ↔ Service Worker RPC.
//
// The popup is in the same extension origin as the SW, so we don't need the
// CHIP-0002 permission gate that gates dApp calls. The popup can invoke any
// engine method directly. We just need a thin envelope to forward the call
// + serialize errors.

import { callEngine } from "./engine.js";
import { setActiveWallet } from "./engine.js";
import {
  clearCoinStore,
  findCatCoinIdByOutpoint,
  findXchCoinIdByOutpoint,
  markCatSpentOptimistic,
  markXchSpentOptimistic,
  readCoinStore,
  totalUnspentMojos,
  unspentCoinCount,
  writeCoinStore,
} from "./coin-store.js";
import { readSyncTelemetry, tickCoinSync } from "./coin-sync.js";
import {
  ensureSocket as ensureMempoolSocket,
  readMempoolDebugFeed,
  readMempoolWatchStats,
} from "./mempool-watch.js";
import { decidePending, listPending } from "./approval.js";
import { getXchPriceUsd, resolveCatMetadata } from "./dexie.js";
import { broadcastEvent } from "./events.js";
import { listConnections, revokeConnection } from "./permissions.js";
import { readSyncState } from "./sync-loop.js";
import { readSidecarSettings, writeSidecarSettings, type SidecarSettings } from "./sidecar-settings.js";
import { sidecarHealth, type SidecarHealth } from "./sidecar-client.js";
import {
  readCompatSettings,
  writeCompatSettings,
  type CompatSettings,
} from "./compat-settings.js";

export type PopupRpcMessage =
  | { from: "popup"; kind: "engine"; method: string; params: unknown }
  | { from: "popup"; kind: "set-active-wallet"; walletId: string | null }
  | { from: "popup"; kind: "get-sync-state" }
  | { from: "popup"; kind: "get-coin-store"; fingerprint: number }
  | { from: "popup"; kind: "clear-coin-store"; fingerprint: number }
  | { from: "popup"; kind: "force-coin-sync" }
  | { from: "popup"; kind: "get-coin-sync-telemetry" }
  | { from: "popup"; kind: "get-mempool-debug" }
  | { from: "popup"; kind: "get-xch-price" }
  | { from: "popup"; kind: "list-connections" }
  | { from: "popup"; kind: "revoke-connection"; origin: string }
  | { from: "popup"; kind: "list-pending-approvals" }
  | {
      from: "popup";
      kind: "decide-approval";
      id: string;
      approved: boolean;
      overrides?: Record<string, unknown>;
    }
  | { from: "popup"; kind: "get-sidecar-settings" }
  | { from: "popup"; kind: "set-sidecar-settings"; patch: Partial<SidecarSettings> }
  | { from: "popup"; kind: "probe-sidecar"; url?: string }
  | { from: "popup"; kind: "get-compat-settings" }
  | { from: "popup"; kind: "set-compat-settings"; patch: Partial<CompatSettings> }
  | { from: "popup"; kind: "debug-broadcast"; event: "chainChanged" | "accountChanged"; payload: unknown }
  | {
      from: "popup";
      kind: "analyze-coin-spends";
      coinSpends: Array<{
        coin: { parent_coin_info: string; puzzle_hash: string; amount: string | number };
        puzzle_reveal: string;
        solution: string;
      }>;
    };

export type PopupRpcResponse =
  | { ok: true; value: unknown }
  | { ok: false; error: { code?: number; message: string } };

export function isPopupMessage(msg: unknown): msg is PopupRpcMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as { from?: unknown };
  return m.from === "popup";
}

export async function handlePopupMessage(
  msg: PopupRpcMessage,
): Promise<PopupRpcResponse> {
  try {
    switch (msg.kind) {
      case "engine": {
        const value = await callEngine(msg.method, msg.params);
        // The popup's Send tab calls send_xch / send_cat / submit_transaction
        // directly via this engine forwarder, bypassing the dApp-facing
        // `transfer` handler in rpc-router. Apply the same optimistic
        // pending-spent marking here so the UI sees the balance change
        // instantly instead of waiting up to 30s for the next coin-sync.
        await applyOptimisticSpentForPopup(msg.method, msg.params, value).catch(
          (e) => {
            console.warn("[popup-rpc] optimistic spent marking failed:", e);
          },
        );
        return { ok: true, value };
      }
      case "set-active-wallet": {
        setActiveWallet(msg.walletId);
        if (msg.walletId) {
          await chrome.storage.session.set({ walletId: msg.walletId });
        } else {
          await chrome.storage.session.remove("walletId");
        }
        // Notify every connected dApp that the active account changed so
        // they re-fetch `accounts` / `getAssetBalance` instead of sitting
        // on the cached values they observed at connect-time. Awaited —
        // MV3 SWs can be killed right after we return, and a fire-and-
        // forget broadcast races that shutdown unpredictably.
        await broadcastEvent("accountChanged", { walletId: msg.walletId });
        return { ok: true, value: null };
      }
      case "debug-broadcast": {
        // Test-only hook so smokes can trigger an event without going
        // through the unlock path. Drops into the same broadcastEvent.
        // No security gate — popup-rpc is already extension-internal.
        const r = await broadcastEvent(msg.event, msg.payload);
        return { ok: true, value: r };
      }
      case "get-sync-state": {
        const state = await readSyncState();
        return { ok: true, value: state };
      }
      case "get-coin-store": {
        const store = await readCoinStore(msg.fingerprint);

        // Cap the per-message coins payload — wallets with deep history
        // crash the popup renderer when every refresh ships MBs of
        // historical records over chrome.runtime.sendMessage. The popup
        // only ever displays unspent + recent activity, so prune here.

        // ── XCH: every unspent + most recent 200 spent ─────────────────
        const allCoins = Object.values(store.coins);
        const unspent = allCoins.filter((c) => !c.spent);
        const spentSorted = allCoins
          .filter((c) => c.spent)
          .sort((a, b) => b.spent_block_index - a.spent_block_index)
          .slice(0, 200);
        const projectedCoins: typeof store.coins = {};
        for (const c of unspent) projectedCoins[c.coin_id] = c;
        for (const c of spentSorted) projectedCoins[c.coin_id] = c;

        // ── CATs: drop assets with 0 unspent balance, and within each
        //         kept asset, only ship the unspent coins (plus the 50
        //         most recent spent for the Activity feed). A wallet with
        //         many historical CATs would otherwise ship MBs/refresh.
        const projectedCats: NonNullable<typeof store.cats> = {};
        const storeCats = store.cats ?? {};
        for (const [assetId, cat] of Object.entries(storeCats)) {
          if ((cat.unspent_coin_count ?? 0) === 0) continue;
          const unspentCoins = cat.coins.filter((c) => !c.spent);
          const spentCoins = cat.coins
            .filter((c) => c.spent)
            .sort((a, b) => b.spent_block_index - a.spent_block_index)
            .slice(0, 50);
          projectedCats[assetId] = {
            ...cat,
            coins: [...unspentCoins, ...spentCoins],
          };
        }

        // ── NFTs: only ship unspent (UI doesn't show spent NFTs anywhere).
        const projectedNfts: NonNullable<typeof store.nfts> = {};
        const storeNfts = store.nfts ?? {};
        for (const [launcher, nft] of Object.entries(storeNfts)) {
          if (nft.spent) continue;
          projectedNfts[launcher] = nft;
        }

        const assetIds = Object.keys(projectedCats);
        const metadata = await resolveCatMetadata(assetIds).catch(() => ({}));

        return {
          ok: true,
          value: {
            last_synced_height: store.last_synced_height,
            unspent_mojos: totalUnspentMojos(store),
            unspent_count: unspentCoinCount(store),
            coins: projectedCoins,
            cats: projectedCats,
            cats_synced_at: store.cats_synced_at ?? null,
            cat_metadata: metadata,
            nfts: projectedNfts,
            nfts_synced_at: store.nfts_synced_at ?? null,
            // Surface the hardened-path map so the popup can detect when
            // a discovered NFT/CAT was received at a hardened derivation
            // (the engine's transfer_nft/send_cat only handle unhardened
            // paths today — see App.tsx NftDetail.transfer for the gate).
            hardened_phs: store.hardened_phs ?? {},
          },
        };
      }
      case "clear-coin-store": {
        await clearCoinStore(msg.fingerprint);
        return { ok: true, value: null };
      }
      case "force-coin-sync": {
        await tickCoinSync({ force: true });
        return { ok: true, value: null };
      }
      case "get-coin-sync-telemetry": {
        const t = await readSyncTelemetry();
        return { ok: true, value: t };
      }
      case "get-mempool-debug": {
        // Defensive: if the popup is querying us right after a SW startup
        // the alarm-driven socket open may not have fired yet. Idempotent
        // — no-op when already open or connecting.
        ensureMempoolSocket();
        return {
          ok: true,
          value: {
            stats: readMempoolWatchStats(),
            feed: readMempoolDebugFeed(),
          },
        };
      }
      case "get-xch-price": {
        const usd = await getXchPriceUsd();
        return { ok: true, value: usd };
      }
      case "list-connections": {
        const conns = await listConnections();
        return { ok: true, value: conns };
      }
      case "revoke-connection": {
        await revokeConnection(msg.origin);
        return { ok: true, value: null };
      }
      case "list-pending-approvals": {
        return { ok: true, value: listPending() };
      }
      case "decide-approval": {
        const ok = decidePending(msg.id, msg.approved, msg.overrides);
        return { ok: true, value: ok };
      }
      case "get-sidecar-settings": {
        const s = await readSidecarSettings();
        return { ok: true, value: s };
      }
      case "set-sidecar-settings": {
        const next = await writeSidecarSettings(msg.patch);
        return { ok: true, value: next };
      }
      case "get-compat-settings": {
        const s = await readCompatSettings();
        return { ok: true, value: s };
      }
      case "set-compat-settings": {
        const next = await writeCompatSettings(msg.patch);
        return { ok: true, value: next };
      }
      case "analyze-coin-spends": {
        // Decode the bundle into a human-readable summary so the approval
        // popup can show actual recipients + amounts instead of "N coin
        // spends".
        //
        // We derive 100 unhardened addresses (the typical send-side
        // window) and pull cached hardened p2 hashes from coin-store
        // — derive_addresses_hardened runs BLS sha512 per address and
        // 200 of those was slow enough to make Chrome mark the tab
        // unresponsive on first load. The cached map (populated on
        // wallet unlock and updated by the sync loop) covers anything
        // the wallet has actually received, which is what matters for
        // "ours vs external" classification. False-positive "external"
        // for a hardened path we haven't received at yet is the safe
        // direction — the popup overstates risk, never understates it.
        const sess = await chrome.storage.session.get("activeFingerprint");
        const fp = sess.activeFingerprint as number | undefined;
        if (typeof fp !== "number") {
          return { ok: false, error: { message: "No active wallet" } };
        }
        const local = await chrome.storage.local.get([
          "wallets",
          `hardened_phs.${fp}`,
        ]);
        const wallets =
          (local.wallets as Record<string, { masterPublicKey?: string }>)
          ?? {};
        const masterPk = wallets[fp.toString()]?.masterPublicKey;
        if (!masterPk) {
          return {
            ok: false,
            error: { message: "Active wallet missing master_public_key" },
          };
        }
        const WINDOW = 100;
        const unhardened = await callEngine<{
          addresses: { puzzle_hash: string }[];
        }>("derive_addresses", {
          master_public_key: masterPk,
          start: 0,
          count: WINDOW,
          testnet: false,
        });
        const cachedHardened =
          (local[`hardened_phs.${fp}`] as Record<string, number> | undefined) ?? {};
        const ownerSet = new Set<string>();
        for (const a of unhardened.addresses) ownerSet.add(a.puzzle_hash);
        for (const ph of Object.keys(cachedHardened)) ownerSet.add(ph);
        const value = await callEngine("analyze_coin_spends", {
          coin_spends: msg.coinSpends,
          owner_puzzle_hashes: [...ownerSet],
        });
        return { ok: true, value };
      }
      case "probe-sidecar": {
        const current = await readSidecarSettings();
        const settings: SidecarSettings = msg.url
          ? { ...current, url: msg.url }
          : current;
        try {
          const h: SidecarHealth = await sidecarHealth(settings);
          return { ok: true, value: h };
        } catch (e) {
          return {
            ok: true,
            value: { reachable: false, error: (e as Error).message },
          };
        }
      }
    }
  } catch (err) {
    const e = err as Error & { code?: number };
    return {
      ok: false,
      error: { code: e.code, message: e.message ?? String(err) },
    };
  }
}

// ─── Optimistic pending-spent for popup-initiated sends ──────────────────
//
// The dApp-facing `transfer` handler in rpc-router.ts already marks input
// coins as `pending: true` immediately after a successful broadcast. The
// popup UI bypasses that handler and calls send_xch / send_cat /
// submit_transaction / take_offer directly via the engine forwarder above,
// so without this mirror the balance lags 30s behind every popup send.
//
// We intentionally do NOT mark inputs for `make_offer` — that engine call
// builds the offer file but doesn't broadcast, so optimistic marks would be
// reverted by the next coin-sync tick (offer-locked coins is a separate
// problem; see follow-up #11).

type EngineResultMaybeError = { error?: string } | null | undefined;

interface EnginePayloadCoin {
  /** Some callers (the popup picker) include coin_id; the dApp-facing path
   *  doesn't. We prefer it when present and fall back to outpoint lookup. */
  coin_id?: string;
  parent_coin_info: string;
  puzzle_hash: string;
  amount: string | number;
}

function isErrorResult(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return typeof (value as EngineResultMaybeError)?.error === "string";
}

function toAmtString(a: string | number): string {
  return typeof a === "string" ? a : String(a);
}

async function applyOptimisticSpentForPopup(
  method: string,
  params: unknown,
  result: unknown,
): Promise<void> {
  void chrome.storage.local.set({
    _optDebug: `called method=${method} hasError=${isErrorResult(result)} at=${Date.now()}`,
  });
  if (isErrorResult(result)) return;
  if (
    method !== "send_xch" &&
    method !== "send_cat" &&
    method !== "submit_transaction" &&
    method !== "take_offer"
  ) {
    return;
  }
  const p = (params ?? {}) as {
    fingerprint?: number;
    asset_id?: string;
    input_coins?: EnginePayloadCoin[];
    input_cats?: Array<EnginePayloadCoin & { asset_id: string }>;
    spend_bundle?: {
      coin_spends?: Array<{ coin: EnginePayloadCoin }>;
    };
  };
  // submit_transaction omits fingerprint — fall back to the active wallet.
  let fp = p.fingerprint;
  if (typeof fp !== "number") {
    const session = await chrome.storage.session.get("activeFingerprint");
    fp = typeof session.activeFingerprint === "number" ? session.activeFingerprint : undefined;
  }
  if (typeof fp !== "number") return;

  const store = await readCoinStore(fp);
  const xchIds: string[] = [];
  const catIdsByAsset = new Map<string, string[]>();

  const strip0x = (s: string) => (s.startsWith("0x") ? s.slice(2) : s);

  const addInput = (
    coin: EnginePayloadCoin & { coin_id?: string },
    hintAssetId?: string,
  ) => {
    // Fast path: coin_id provided (popup picker).
    if (coin.coin_id) {
      const id = strip0x(coin.coin_id);
      if (store.coins[id]) {
        xchIds.push(id);
        return;
      }
      // Look it up in cat buckets.
      for (const [assetId, cat] of Object.entries(store.cats ?? {})) {
        for (const c of cat.coins) {
          if (strip0x(c.coin_id) === id) {
            const list = catIdsByAsset.get(assetId) ?? [];
            list.push(c.coin_id);
            catIdsByAsset.set(assetId, list);
            return;
          }
        }
      }
    }
    // Fallback: outpoint match. Try both 0x-prefixed and stripped forms —
    // CoinRecord storage has historically used both depending on which sync
    // path wrote the record (sidecar strips, engine paths sometimes keep).
    const amt = toAmtString(coin.amount);
    for (const parent of [strip0x(coin.parent_coin_info), `0x${strip0x(coin.parent_coin_info)}`]) {
      for (const ph of [strip0x(coin.puzzle_hash), `0x${strip0x(coin.puzzle_hash)}`]) {
        const xch = findXchCoinIdByOutpoint(store, parent, ph, amt);
        if (xch) {
          xchIds.push(xch);
          return;
        }
        const cat = findCatCoinIdByOutpoint(store, parent, ph, amt);
        if (cat) {
          const list = catIdsByAsset.get(cat.assetId) ?? [];
          list.push(cat.coinId);
          catIdsByAsset.set(cat.assetId, list);
          return;
        }
        if (hintAssetId && store.cats?.[hintAssetId]) {
          for (const c of store.cats[hintAssetId].coins) {
            if (
              c.parent_coin_info === parent &&
              c.puzzle_hash === ph &&
              c.amount === amt
            ) {
              const list = catIdsByAsset.get(hintAssetId) ?? [];
              list.push(c.coin_id);
              catIdsByAsset.set(hintAssetId, list);
              return;
            }
          }
        }
      }
    }
  };

  if (method === "send_xch") {
    for (const c of p.input_coins ?? []) addInput(c);
  } else if (method === "send_cat") {
    for (const c of p.input_coins ?? []) addInput(c, p.asset_id);
  } else if (method === "submit_transaction") {
    for (const cs of p.spend_bundle?.coin_spends ?? []) addInput(cs.coin);
  } else if (method === "take_offer") {
    for (const c of p.input_coins ?? []) addInput(c);
    for (const c of p.input_cats ?? []) addInput(c, c.asset_id);
  }

  void chrome.storage.local.set({
    _optResult: `xch=${xchIds.length} cats=${catIdsByAsset.size} fp=${fp}`,
  });
  if (xchIds.length === 0 && catIdsByAsset.size === 0) return;
  markXchSpentOptimistic(store, xchIds);
  for (const [assetId, ids] of catIdsByAsset) {
    markCatSpentOptimistic(store, assetId, ids);
  }
  await writeCoinStore(fp, store);
}
