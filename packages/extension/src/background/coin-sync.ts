// Background coin sync loop driven by chrome.alarms.
//
// Pulls the wallet's puzzle_hashes from the engine using ONLY the stored
// master_public_key (no unlock required) so it keeps running across SW
// restarts. Detects new coins + outbound spends and persists everything
// in chrome.storage.local["coins.<fp>"].
//
// Algorithm per tick:
//   1. Look up the active wallet from chrome.storage.local (the popup
//      writes it on unlock / save).
//   2. derive_addresses(master_public_key, 0..50) — stateless.
//   3. Find the lowest per-PH sync mark; back off by REORG_WINDOW so a
//      chain reorg can't sneak past us.
//   4. scan_puzzle_hashes(phs, start_height, peak) — incremental diff.
//   5. Merge new coin records into the store.
//   6. check_coins_spent for the still-unspent set in chunks of 250.
//   7. Persist + bump global last_synced_height + write telemetry.

import { callEngine } from "./engine.js";
import {
  type CatCoin,
  type CoinRecord,
  type NftView,
  PENDING_TTL_MS,
  type RawAssetCandidate,
  type RawCatCandidate,
  type RawNftCandidate,
  readCoinStore,
  writeCoinStore,
} from "./coin-store.js";
import { resolveCatMetadata } from "./dexie.js";
import { fmtCatMojos, fmtXchMojos, notify } from "./notifications.js";
import { readSidecarSettings } from "./sidecar-settings.js";
import {
  scanPuzzleHashes as sidecarScanPuzzleHashes,
  checkCoinsSpent as sidecarCheckCoinsSpent,
  sidecarReady,
} from "./sidecar-client.js";

// Sage's "current receive address" for a real heavy wallet (the bench mnemonic)
// turned out to be at UNHARDENED index 199. A wallet that has cycled through
// many addresses over the years pushes the active index deep into the unhardened
// space. 50 was missing 6 of 7 NFTs because their receive addresses lived
// between idx 50 and 199. 200 covers the bench wallet's full active range with
// headroom; XCH stays a single batched call, CAT/NFT chunk at SCAN_CHUNK_PHS.
const DERIVE_COUNT = 200;
const REORG_WINDOW = 32;
// MV3 service workers have a HARD 5-minute (300s) limit per event handler —
// once exceeded Chrome terminates the SW even if it's actively making
// chrome.* calls. coinset.org rate-limits us to ~1 request/second per
// connection; a fresh-wallet sync (40 NFT chunks × 10 PHs + 40 CAT chunks ×
// 10 PHs = 800 requests) easily blows past 5 min. The fix is to bail each
// tick at well-under the limit and trust the alarm to fire the next tick
// 30s later — cursors persist per-chunk so resumption is free. 90s gives
// us comfortable headroom and 2–4 ticks finish a deep fresh-wallet sync.
const MAX_TICK_MS = 90_000;
const SCAN_TIMEOUT_MS = 30_000;
// NFT parent-spend decoding is slower than CAT lineage parsing — every
// candidate hint round-trips coinset for puzzle_reveal + solution and runs
// it through SpendContext. Give it more head-room before we kill the chunk.
const NFT_SCAN_TIMEOUT_MS = 45_000;
// Process CAT/NFT discovery 5 PHs at a time. With DERIVE_COUNT=200 we'd have
// 200 chunks at 1 PH each — too many round-trips for the per-chunk overhead
// (persist + progress patch). Engine fires hints in parallel within a chunk
// so 5 is still bounded; per-window response size is now small enough that
// 5 simultaneous hits don't OOM.
const SCAN_CHUNK_PHS = 5;
// CAT/NFT hint-based scans are full re-sweeps (coinset doesn't expose an
// incremental cursor for `get_coin_records_by_hint`). Don't burn one every
// 30 s — once every 5 minutes is enough for the wallet to catch incoming
// transfers, and the popup's "Refresh now" button forces an immediate run.
const CAT_NFT_REFRESH_INTERVAL_MS = 5 * 60_000;

// Wrap an awaitable in a timeout so a stalled coinset call doesn't keep the
// whole tick alive past MAX_TICK_MS and risk an SW kill mid-flight.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}: timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
const WALLETS_KEY = "wallets";
const ACTIVE_FP_KEY = "activeFingerprint";
const TELEMETRY_KEY = "coinSyncTelemetry";

export type SyncStage =
  | "idle"
  | "deriving"
  | "xch"
  | "cats"
  | "nfts"
  | "done";

export interface StageProgress {
  done: number;
  total: number;
  /** Number of items discovered so far in this stage. */
  found?: number;
  /** Most recent transient error within the stage (don't fail the whole tick on these). */
  last_warning?: string | null;
  /** Free-form short text describing what we're doing RIGHT NOW (e.g. "addrs 6..9"). */
  detail?: string | null;
  /** When this stage entered its current run — millis since epoch. */
  started_at?: number | null;
  /** Block range we're currently sweeping (XCH: scan window; CATs/NFTs: hint start..peak). */
  block_from?: number | null;
  block_to?: number | null;
  /** Number of coinset candidates returned by this stage's hint sweep. */
  candidates?: number;
}

export interface CoinSyncTelemetry {
  fingerprint: number | null;
  last_attempt_at: number;
  last_success_at: number | null;
  last_full_sync_at: number | null;
  last_error: string | null;
  last_peak_height: number;
  last_new_coins: number;
  /** Current pipeline stage. "done" means the most recent tick finished cleanly. */
  stage: SyncStage;
  /** When the current tick started — used to render elapsed time in the UI. */
  tick_started_at: number | null;
  /** Per-stage progress, refreshed live as we walk chunks. */
  stage_progress: {
    xch: StageProgress;
    cats: StageProgress;
    nfts: StageProgress;
  };
  /** Counts derived from the persisted store (for the badge). */
  totals: {
    xch_coins: number;
    cat_assets: number;
    nfts: number;
  };
}

const EMPTY_TELEMETRY: CoinSyncTelemetry = {
  fingerprint: null,
  last_attempt_at: 0,
  last_success_at: null,
  last_full_sync_at: null,
  last_error: null,
  last_peak_height: 0,
  last_new_coins: 0,
  stage: "idle",
  tick_started_at: null,
  stage_progress: {
    xch: { done: 0, total: 0 },
    cats: { done: 0, total: 0, found: 0 },
    nfts: { done: 0, total: 0, found: 0 },
  },
  totals: { xch_coins: 0, cat_assets: 0, nfts: 0 },
};

interface StoredWalletEntry {
  fingerprint: number;
  keychainBlob: string;
  masterPublicKey?: string;
  label: string;
  createdAt: number;
}

let running = false;

async function loadActiveWallet(): Promise<StoredWalletEntry | null> {
  const session = await chrome.storage.session.get(ACTIVE_FP_KEY);
  const fingerprint = session[ACTIVE_FP_KEY] as number | undefined;
  if (typeof fingerprint !== "number") return null;
  const local = await chrome.storage.local.get(WALLETS_KEY);
  const wallets = (local[WALLETS_KEY] as Record<string, StoredWalletEntry> | undefined) ?? {};
  return wallets[fingerprint.toString()] ?? null;
}

async function writeTelemetry(patch: Partial<CoinSyncTelemetry>): Promise<void> {
  const current = (await chrome.storage.session.get(TELEMETRY_KEY))[TELEMETRY_KEY] as
    | CoinSyncTelemetry
    | undefined;
  const base = current ?? EMPTY_TELEMETRY;
  // Drop undefined keys so callers can use them to mean "leave unchanged".
  const definedPatch: Partial<CoinSyncTelemetry> = {};
  for (const k of Object.keys(patch) as Array<keyof CoinSyncTelemetry>) {
    const v = patch[k];
    if (v !== undefined) {
      (definedPatch as Record<string, unknown>)[k] = v;
    }
  }
  const next: CoinSyncTelemetry = {
    ...base,
    ...definedPatch,
    stage_progress: {
      ...base.stage_progress,
      ...(patch.stage_progress ?? {}),
    },
    totals: { ...base.totals, ...(patch.totals ?? {}) },
  };
  await chrome.storage.session.set({ [TELEMETRY_KEY]: next });
}

async function patchStageProgress(
  stage: Exclude<SyncStage, "idle" | "deriving" | "done">,
  patch: Partial<StageProgress>,
): Promise<void> {
  const current = (await chrome.storage.session.get(TELEMETRY_KEY))[TELEMETRY_KEY] as
    | CoinSyncTelemetry
    | undefined;
  const base = current ?? EMPTY_TELEMETRY;
  const merged: StageProgress = { ...base.stage_progress[stage], ...patch };
  const next: CoinSyncTelemetry = {
    ...base,
    stage,
    stage_progress: { ...base.stage_progress, [stage]: merged },
  };
  await chrome.storage.session.set({ [TELEMETRY_KEY]: next });
}

export async function readSyncTelemetry(): Promise<CoinSyncTelemetry | null> {
  const data = await chrome.storage.session.get(TELEMETRY_KEY);
  return (data[TELEMETRY_KEY] as CoinSyncTelemetry | undefined) ?? null;
}

export async function tickCoinSync(opts: { force?: boolean } = {}): Promise<void> {
  if (running) return;
  running = true;
  const startedAt = Date.now();
  const deadline = startedAt + MAX_TICK_MS;
  // The global "keepalive" alarm (background.ts) fires every 25s and bumps
  // the SW lifetime via chrome.runtime.getPlatformInfo, so we don't need a
  // local setInterval here. setInterval inside a SW is unreliable anyway:
  // it dies with the SW and can't restart itself.
  try {
    const wallet = await loadActiveWallet();
    if (!wallet) {
      await writeTelemetry({
        stage: "idle",
        last_attempt_at: startedAt,
        last_error: "no active wallet",
      });
      return;
    }
    const masterPk = wallet.masterPublicKey;
    if (!masterPk) {
      // Wallet predates master_public_key persistence — needs one unlock to
      // backfill (the popup does that on next login).
      await writeTelemetry({
        stage: "idle",
        fingerprint: wallet.fingerprint,
        last_attempt_at: startedAt,
        last_error: "wallet missing masterPublicKey — open the popup and unlock once",
      });
      return;
    }

    await writeTelemetry({
      stage: "deriving",
      fingerprint: wallet.fingerprint,
      tick_started_at: startedAt,
      last_attempt_at: startedAt,
      last_error: null,
    });

    // 1. Derive puzzle_hashes from the master_public_key (no unlock needed).
    let addresses: { index: number; puzzle_hash: string }[];
    try {
      const res = await callEngine<{
        addresses: { index: number; address: string; puzzle_hash: string }[];
      }>("derive_addresses", {
        master_public_key: masterPk,
        start: 0,
        count: DERIVE_COUNT,
        testnet: false,
      });
      addresses = res.addresses;
    } catch (err) {
      await writeTelemetry({
        fingerprint: wallet.fingerprint,
        last_attempt_at: startedAt,
        last_error: `derive_addresses: ${(err as Error).message}`,
      });
      return;
    }

    if (Date.now() > deadline) return;

    // 1b. Load cached HARDENED puzzle hashes. These were derived once when
    //     the wallet was unlocked (in the popup, via `cacheHardenedPhs`) and
    //     stored under `chrome.storage.local["hardened_phs.<fp>"]`. We
    //     include them in every scan so coins/NFTs/CATs received on Sage's
    //     primary (hardened) addresses get discovered. Empty map ⇒
    //     wallet was never unlocked → fall back to unhardened-only sync.
    const hardenedPhsRaw = (
      await chrome.storage.local.get(`hardened_phs.${wallet.fingerprint}`)
    )[`hardened_phs.${wallet.fingerprint}`] as Record<string, number> | undefined;
    const hardenedPhsMap: Record<string, number> = hardenedPhsRaw ?? {};
    // Sort hardened entries by their derivation_index so distribution across
    // chunks is deterministic.
    const hardenedSorted = Object.entries(hardenedPhsMap)
      .map(([puzzle_hash, derivation_index]) => ({
        puzzle_hash,
        derivation_index,
        kind: "hardened" as const,
      }))
      .sort((a, b) => a.derivation_index - b.derivation_index);
    const hardenedPhList = hardenedSorted.map((h) => h.puzzle_hash);

    // 2. start_height = lowest per-PH mark - reorg window
    const store = await readCoinStore(wallet.fingerprint);
    // Snapshot the CAT coins + NFTs we already knew about, so after the hint
    // scans we can tell which ones ARRIVED this tick. A CAT/NFT coin only lands
    // in our store because the hint scan matched our p2 puzzle hash — so any new
    // one IS ours (its outer puzzle hash is the CAT/NFT puzzle, not our p2, which
    // is exactly why the receive PH set can't see it). That's the incoming
    // CAT/NFT signal.
    const knownCatCoinIds = new Set<string>();
    for (const cat of Object.values(store.cats ?? {})) {
      for (const coin of cat.coins) knownCatCoinIds.add(coin.coin_id);
    }
    const knownNftLaunchers = new Set(Object.keys(store.nfts ?? {}));
    // Combined PH set: unhardened (always) + hardened (when cached).
    const unhardenedPhs = addresses.map((a) => a.puzzle_hash);
    const allPhs = [...unhardenedPhs, ...hardenedPhList];
    let lowest = Number.POSITIVE_INFINITY;
    for (const ph of allPhs) {
      const h = store.ph_heights[ph] ?? 0;
      if (h < lowest) lowest = h;
    }
    if (!isFinite(lowest)) lowest = 0;
    const startHeight = Math.max(0, lowest - REORG_WINDOW);

    await writeTelemetry({
      stage: "xch",
      stage_progress: {
        xch: {
          done: 0,
          total: allPhs.length,
          detail: `from block #${startHeight.toLocaleString()}`,
          started_at: Date.now(),
          block_from: startHeight,
          block_to: null,
        },
        cats: { done: 0, total: Math.ceil(DERIVE_COUNT / SCAN_CHUNK_PHS), found: 0 },
        nfts: { done: 0, total: Math.ceil(DERIVE_COUNT / SCAN_CHUNK_PHS), found: 0 },
      },
    });

    // 3. Scan. Route through the local peer-sync sidecar when the user
    //    has it enabled AND it's currently reachable; otherwise fall back
    //    to the WASM engine (coinset.org). Sidecar failures auto-fall back
    //    so a stopped daemon never breaks the wallet.
    let scan: { peak_height: number; coin_records: CoinRecord[] };
    const sidecarSettings = await readSidecarSettings();
    const useSidecar =
      sidecarSettings.enabled && (await sidecarReady(sidecarSettings)) !== null;
    try {
      if (useSidecar) {
        try {
          scan = await sidecarScanPuzzleHashes(
            { puzzle_hashes: allPhs },
            sidecarSettings,
          );
        } catch (sidecarErr) {
          console.warn(
            "[coin-sync] sidecar scan failed, falling back to coinset:",
            (sidecarErr as Error).message,
          );
          scan = await callEngine<typeof scan>("scan_puzzle_hashes", {
            puzzle_hashes: allPhs,
            start_height: startHeight,
            include_spent: true,
            endpoint: "mainnet",
          });
        }
      } else {
        scan = await callEngine<typeof scan>("scan_puzzle_hashes", {
          puzzle_hashes: allPhs,
          start_height: startHeight,
          include_spent: true,
          endpoint: "mainnet",
        });
      }
    } catch (err) {
      await writeTelemetry({
        fingerprint: wallet.fingerprint,
        last_attempt_at: startedAt,
        last_error: `scan_puzzle_hashes: ${(err as Error).message}`,
      });
      return;
    }

    // 4. Merge.
    //
    // When the scan went through the sidecar (P2P subscribe_puzzles), the
    // returned coin_states already include EVERY coin where the receive_ph
    // matched either puzzle_hash (pure XCH) OR hint (NFT/CAT received at
    // that address). We partition them here:
    //   - puzzle_hash ∈ receive_phs → XCH, goes into store.coins
    //   - puzzle_hash ∉ receive_phs → NFT/CAT candidate, deposit into the
    //     pending queues so Phase 2 can classify them. This lets us SKIP
    //     the whole NFT/CAT Phase 1 hint sweep (which used to be 40 chunks
    //     × coinset.org per stage) — the P2P scan already found them.
    //
    // Normalize hex (sidecar strips 0x, derive_addresses may or may not).
    const normPh = (s: string) =>
      s.startsWith("0x") ? s.slice(2).toLowerCase() : s.toLowerCase();
    const receivePhSet = new Set(allPhs.map(normPh));
    let newCoins = 0;
    let sidecarCandidates = 0;
    const pendingNftPre: Record<string, RawNftCandidate> = {
      ...(store.pending_nft_candidates ?? {}),
    };
    const pendingCatPre: Record<string, RawCatCandidate> = {
      ...(store.pending_cat_candidates ?? {}),
    };
    // Notification baseline: coins confirmed/spent at or below this height are
    // historical backfill and never notified. On the FIRST armed sync there is
    // no stored baseline, so we use the current peak — nothing is newer, so the
    // whole history syncs silently. Advanced to the peak at the end of the tick.
    const notifBaseline = store.notif_baseline_height ?? scan.peak_height;

    // Newly-arrived, unspent, confirmed XCH coins ABOVE the baseline — candidates
    // for a "received" notification (filtered against same-tick spends below so
    // our own change doesn't masquerade as an incoming payment).
    const receivedThisTick: CoinRecord[] = [];
    for (const rec of scan.coin_records) {
      const isXch = receivePhSet.has(normPh(rec.puzzle_hash));
      if (isXch) {
        if (!(rec.coin_id in store.coins)) {
          newCoins += 1;
          if (!rec.spent && rec.confirmed_block_index > notifBaseline) receivedThisTick.push(rec);
        }
        store.coins[rec.coin_id] = rec;
      } else if (useSidecar && !rec.spent) {
        // Hint-matched, unspent — feed to BOTH parse queues. Each parser
        // ignores coins that don't match its primitive, so duplicating
        // into both queues is safe (Phase 2 dedups by coin_id).
        const candidate: RawNftCandidate = {
          // Sidecar matched via P2P subscribe_puzzles which doesn't tell us
          // WHICH receive_ph hinted the coin. The WASM parser only echoes
          // hint back — it doesn't use it for parsing — so a zero-hint
          // sentinel passes validation without affecting NFT/CAT detection.
          hint: `0x${"00".repeat(32)}`,
          coin: {
            parent_coin_info: rec.parent_coin_info,
            puzzle_hash: rec.puzzle_hash,
            amount: rec.amount,
          },
          coin_id: rec.coin_id,
          confirmed_block_index: rec.confirmed_block_index,
          spent: rec.spent,
          spent_block_index: rec.spent_block_index,
          derivation_index: 0,
          derivation_kind: "unhardened",
        };
        pendingNftPre[rec.coin_id] = candidate;
        pendingCatPre[rec.coin_id] = candidate;
        sidecarCandidates += 1;
      }
    }
    for (const ph of allPhs) {
      store.ph_heights[ph] = scan.peak_height;
    }
    store.last_synced_height = scan.peak_height;
    if (useSidecar && sidecarCandidates > 0) {
      store.pending_nft_candidates = pendingNftPre;
      store.pending_cat_candidates = pendingCatPre;
      // Pre-advance the NFT/CAT hint cursors to peak — the sidecar already
      // covered the full receive_ph set, so Phase 1 has nothing to do.
      const nftHintHeights = { ...(store.nft_hint_heights ?? {}) };
      const catHintHeights = { ...(store.cat_hint_heights ?? {}) };
      for (const ph of allPhs) {
        nftHintHeights[ph] = scan.peak_height;
        catHintHeights[ph] = scan.peak_height;
      }
      store.nft_hint_heights = nftHintHeights;
      store.cat_hint_heights = catHintHeights;
      console.log(
        `[coin-sync] sidecar discovered ${sidecarCandidates} hint candidates — skipping Phase 1`,
      );
    }

    // Persist after step 4 so the UI sees XCH/Activity even if the CAT/NFT
    // scans below time out or the SW dies mid-flight.
    await writeCoinStore(wallet.fingerprint, store);
    const xchUnspent = Object.values(store.coins).filter((c) => !c.spent).length;
    // Notify connected dApps if this tick actually changed the unspent set.
    // Throttling lives inside broadcastEvent — safe to call from each tick.
    if (newCoins > 0) {
      const { broadcastEvent } = await import("./events.js");
      void broadcastEvent("accountChanged", {
        reason: "coin-sync",
        new_coins: newCoins,
        xch_unspent: xchUnspent,
      });
    }
    await writeTelemetry({
      fingerprint: wallet.fingerprint,
      last_attempt_at: startedAt,
      last_success_at: Date.now(),
      last_error: null,
      last_peak_height: scan.peak_height,
      last_new_coins: newCoins,
      totals: {
        xch_coins: xchUnspent,
        cat_assets: Object.keys(store.cats ?? {}).length,
        nfts: Object.values(store.nfts ?? {}).filter((n) => !n.spent).length,
      },
      stage_progress: {
        xch: {
          done: allPhs.length,
          total: allPhs.length,
          block_from: startHeight,
          block_to: scan.peak_height,
          detail: `synced to #${scan.peak_height.toLocaleString()}`,
          candidates: scan.coin_records.length,
        },
        cats: { done: 0, total: Math.ceil(DERIVE_COUNT / SCAN_CHUNK_PHS), found: 0 },
        nfts: { done: 0, total: Math.ceil(DERIVE_COUNT / SCAN_CHUNK_PHS), found: 0 },
      },
    });

    // 5. Verify the unspent + pending set in chunks. Three buckets of
    //    candidates:
    //      • XCH coins still marked unspent — detects spends from another
    //        wallet that shares this seed (Sage, mobile, another browser).
    //      • XCH coins marked pending=true — our own broadcasts we want to
    //        confirm or revert if push_tx never landed.
    //      • CAT coins (unspent + pending) across every cat bucket — same
    //        reasoning but for tokens. Without this, external CAT spends
    //        wouldn't show up until the next full hint rescan.
    //
    //    Reconciliation against the response:
    //      • In `spent`           → set spent=true + spent_block_index,
    //                               clear pending.
    //      • In `missing`:
    //          - was pending past PENDING_TTL_MS → revert. push_tx never
    //                                              made it to the indexer.
    //          - was pending within TTL          → leave as-is. Bundle may
    //                                              still be propagating.
    //          - was NOT pending                 → delete (reorg / pruned
    //                                              coin, existing behavior,
    //                                              XCH only — CAT rescan
    //                                              handles its own deletion).
    //      • Neither (still unspent on chain):
    //          - was pending past PENDING_TTL_MS → revert. The bundle either
    //                                              never landed or got
    //                                              evicted from the mempool.
    //          - was pending within TTL          → leave as-is. The bundle
    //                                              is likely sitting in the
    //                                              mempool waiting for a
    //                                              block (5–30s typical).
    //          - else                            → no-op.
    type CatLookup = { assetId: string; coin: CatCoin };
    const xchCandidates: CoinRecord[] = Object.values(store.coins).filter(
      (c) => !c.spent || c.pending,
    );
    const catCandidates: CatLookup[] = [];
    for (const [assetId, cat] of Object.entries(store.cats ?? {})) {
      for (const coin of cat.coins) {
        if (!coin.spent || coin.pending) {
          catCandidates.push({ assetId, coin });
        }
      }
    }
    const xchById = new Map(xchCandidates.map((c) => [c.coin_id, c]));
    const catById = new Map(catCandidates.map((e) => [e.coin.coin_id, e]));
    const allIds = [...xchById.keys(), ...catById.keys()];

    // Coins that flipped to confirmed-spent THIS tick, split by whether WE
    // broadcast them (the optimistic `pending` flag) or another device did.
    // Drives the "your transaction confirmed" vs "sent from another device"
    // notifications — and tells us a receive this tick is really change.
    let sentMojos = 0n; // our own broadcasts that just confirmed
    let externalMojos = 0n; // spent by another device/app on this seed
    let sentBlock = 0;
    let externalBlock = 0;
    let anySpentThisTick = false;

    for (let i = 0; i < allIds.length; i += 250) {
      if (Date.now() > deadline) break;
      const chunk = allIds.slice(i, i + 250);
      try {
        const res = useSidecar
          ? await sidecarCheckCoinsSpent(chunk, sidecarSettings).catch(async () =>
              await callEngine<{
                spent: { coin_id: string; spent_block_index: number }[];
                missing: string[];
              }>("check_coins_spent", { coin_ids: chunk, endpoint: "mainnet" }),
            )
          : await callEngine<{
              spent: { coin_id: string; spent_block_index: number }[];
              missing: string[];
            }>("check_coins_spent", { coin_ids: chunk, endpoint: "mainnet" });
        const spentSet = new Set<string>();
        for (const s of res.spent) {
          spentSet.add(s.coin_id);
          const xch = xchById.get(s.coin_id);
          if (xch) {
            // Two confirm paths:
            //   • `pending` → WE broadcast it (markXchSpentOptimistic already
            //     set spent=true); confirming it now = "your tx confirmed".
            //   • still unspent → another device on this seed spent it.
            // Anything already spent & not pending was handled on a prior tick.
            if (xch.pending) {
              anySpentThisTick = true;
              if (s.spent_block_index > notifBaseline) {
                sentMojos += BigInt(xch.amount);
                sentBlock = Math.max(sentBlock, s.spent_block_index);
              }
            } else if (!xch.spent && s.spent_block_index > notifBaseline) {
              anySpentThisTick = true;
              externalMojos += BigInt(xch.amount);
              externalBlock = Math.max(externalBlock, s.spent_block_index);
            }
            xch.spent = true;
            xch.spent_block_index = s.spent_block_index;
            delete xch.pending;
            delete xch.pending_at;
          }
          const cat = catById.get(s.coin_id);
          if (cat) {
            if (cat.coin.pending) {
              anySpentThisTick = true;
              if (s.spent_block_index > notifBaseline) {
                sentMojos += 1n;
                sentBlock = Math.max(sentBlock, s.spent_block_index);
              }
            } else if (!cat.coin.spent && s.spent_block_index > notifBaseline) {
              anySpentThisTick = true;
              externalMojos += 1n;
              externalBlock = Math.max(externalBlock, s.spent_block_index);
            }
            cat.coin.spent = true;
            cat.coin.spent_block_index = s.spent_block_index;
            delete cat.coin.pending;
            delete cat.coin.pending_at;
          }
        }
        const missingSet = new Set(res.missing);
        const now = Date.now();
        // Coin IDs that mempool-watch has confirmed are currently being
        // spent in some mempool item. If a pending coin shows up here, the
        // broadcast clearly landed — keep the pending flag past the normal
        // TTL until the mempool itself loses the tx (eviction or block
        // inclusion).
        const mempoolSpent = new Set<string>();
        for (const o of store.mempool?.outgoing ?? []) {
          for (const id of o.spent_xch_coin_ids) mempoolSpent.add(id);
          for (const ids of Object.values(o.spent_cat_coin_ids)) {
            for (const id of ids) mempoolSpent.add(id);
          }
        }
        const expired = (coinId: string, pendingAt: number | undefined) => {
          if (mempoolSpent.has(coinId)) return false;
          return typeof pendingAt === "number" && now - pendingAt > PENDING_TTL_MS;
        };
        for (const missingId of res.missing) {
          const xch = xchById.get(missingId);
          if (xch) {
            if (xch.pending) {
              if (expired(missingId, xch.pending_at)) {
                xch.spent = false;
                delete xch.pending;
                delete xch.pending_at;
              }
              // else: still within TTL, let the bundle keep propagating.
            } else {
              delete store.coins[missingId];
            }
          }
          const cat = catById.get(missingId);
          if (cat && cat.coin.pending && expired(missingId, cat.coin.pending_at)) {
            cat.coin.spent = false;
            delete cat.coin.pending;
            delete cat.coin.pending_at;
          }
          // Non-pending CATs that go missing: leave to the CAT rescan.
        }
        // Anything left in the chunk that came back neither spent nor
        // missing is still unspent on chain — revert pending only after the
        // TTL elapses so we don't trip on mempool-but-not-yet-in-block.
        for (const id of chunk) {
          if (spentSet.has(id) || missingSet.has(id)) continue;
          const xch = xchById.get(id);
          if (xch?.pending && expired(id, xch.pending_at)) {
            xch.spent = false;
            delete xch.pending;
            delete xch.pending_at;
          }
          const cat = catById.get(id);
          if (cat?.coin.pending && expired(id, cat.coin.pending_at)) {
            cat.coin.spent = false;
            delete cat.coin.pending;
            delete cat.coin.pending_at;
          }
        }
      } catch {
        // best-effort; continue with next chunk
      }
    }

    // ── Confirmation-based notifications (no mempool polling) ─────────────
    // All three ride on this peak-triggered reconciliation, so they cost zero
    // extra network traffic. Dedup keys include the block height so distinct
    // events never collide and a re-run of the same tick can't re-fire.
    //
    // A coin that WE marked pending and that just confirmed spent → our send
    // landed. (A non-pending coin that confirmed spent is an external send.)
    if (sentMojos > 0n) {
      void notify({
        kind: "outgoing-confirmed",
        dedupId: `sent-${sentBlock}`,
        title: "Transaction confirmed",
        message: `Your transaction confirmed in block #${sentBlock.toLocaleString()}.`,
      });
    }
    if (externalMojos > 0n) {
      void notify({
        kind: "outgoing-external",
        dedupId: `ext-${externalBlock}`,
        title: "Sent from another device",
        message: `Coins from your wallet were spent by another app or device (block #${externalBlock.toLocaleString()}).`,
      });
    }
    // A new incoming coin with NO same-tick spend is a genuine receive (when we
    // spent something too, the new coins are our own change → stay quiet).
    if (!anySpentThisTick && receivedThisTick.length > 0) {
      let recvMojos = 0n;
      let recvBlock = 0;
      for (const r of receivedThisTick) {
        recvMojos += BigInt(r.amount);
        recvBlock = Math.max(recvBlock, r.confirmed_block_index);
      }
      void notify({
        kind: "incoming-confirmed",
        dedupId: `recv-${recvBlock}-${recvMojos}`,
        title: "Payment received",
        message: `${fmtXchMojos(recvMojos)} arrived in block #${recvBlock.toLocaleString()}.`,
      });
    }
    // Advance the notification high-water mark so the next tick only alerts on
    // activity newer than this peak. (On the first sync this arms it for the
    // first time, having notified nothing above the seed baseline.)
    store.notif_baseline_height = scan.peak_height;

    // After reconciliation, rebuild each CAT bucket's totals — optimistic
    // marks (and reverts) can flip `spent` on coins we already wrote out.
    for (const cat of Object.values(store.cats ?? {})) {
      let total = 0n;
      let unspent = 0;
      for (const c of cat.coins) {
        if (!c.spent) {
          total += BigInt(c.amount);
          unspent += 1;
        }
      }
      cat.total_unspent_mojos = total.toString();
      cat.unspent_coin_count = unspent;
    }

    // Persist the spent reconciliation + the advanced notification baseline now,
    // so the baseline survives even if the CAT/NFT stages below time out (without
    // it the next tick would re-seed the baseline to the peak and never notify).
    await writeCoinStore(wallet.fingerprint, store);

    // ── ORDER NOTE ──
    // We run NFT scan BEFORE CAT scan. NFT hint responses are tiny (a few
    // singletons per PH at most) so the stage completes in ~5–10s, giving
    // the user immediate visual confirmation in the popup's NFTs tab.
    // CAT scans can take 30–60s on deep-history wallets and occasionally
    // OOM-crash the WASM module on a single huge hint response — running
    // them first would hide NFTs behind that risk. Order: XCH → NFTs → CATs.

    // 6a. NFT scan — TWO-PHASE pipeline:
    //   Phase 1 (fast): nft_scan_hints fills `pending_nft_candidates` with
    //                   raw coin records per PH. Cursors + queue persist
    //                   every chunk so SW death never throws away network
    //                   work.
    //   Phase 2 (slow): nft_parse_candidates drains the queue in batches,
    //                   fetching parent spends + parsing NFTs. Each batch
    //                   that succeeds is removed from the queue and the
    //                   parsed NFTs land in store.nfts. SW death only
    //                   forfeits an in-flight batch.
    await writeTelemetry({ stage: "nfts" });
    const nftsMap: Record<string, NftView> = { ...(store.nfts ?? {}) };
    const nftsHintHeights: Record<string, number> = { ...(store.nft_hint_heights ?? {}) };
    const pendingNfts: Record<string, RawNftCandidate> = {
      ...(store.pending_nft_candidates ?? {}),
    };
    // CAT-side scratch state — hoisted out of the CAT stage so the NFT
    // stage's `asset_scan_hints` response can populate both pending queues
    // and both cursor maps in a single fetch. Each Phase-2 parser rejects
    // coins that don't match its primitive (Cat::parse_children / Nft::parse_child),
    // so writing the same candidate to both queues is safe.
    const catsHintHeights: Record<string, number> = { ...(store.cat_hint_heights ?? {}) };
    const pendingCats: Record<string, RawCatCandidate> = {
      ...(store.pending_cat_candidates ?? {}),
    };
    /**
     * Set to true when the NFT stage's Phase-1 loop actually issues at
     * least one `asset_scan_hints` call this tick. The CAT stage uses
     * this to skip its own Phase-1 — the candidates + cursors are already
     * up-to-date in `pendingCats` / `catsHintHeights`.
     */
    let assetScanRanInNftStage = false;
    const nftTotalChunks = Math.ceil(DERIVE_COUNT / SCAN_CHUNK_PHS);
    let nftChunksDone = 0;
    const nftsHasCursors = Object.keys(nftsHintHeights).length === addresses.length;
    // When sidecar did the hint discovery this tick (sidecarCandidates > 0
    // AND cursors at peak), Phase 1 has nothing to add and should skip
    // straight to Phase 2 parsing.
    const sidecarHandledNftHints = useSidecar && sidecarCandidates > 0;
    const nftsStale =
      !sidecarHandledNftHints &&
      (opts.force ||
        nftsHasCursors ||
        !store.nfts_synced_at ||
        Date.now() - store.nfts_synced_at > CAT_NFT_REFRESH_INTERVAL_MS);
    if (!nftsStale && Object.keys(pendingNfts).length === 0) {
      // Nothing to refresh AND nothing queued to parse.
      await patchStageProgress("nfts", {
        done: nftTotalChunks,
        total: nftTotalChunks,
        found: Object.values(nftsMap).filter((n) => !n.spent).length,
        last_warning: null,
      });
    } else {
    await patchStageProgress("nfts", {
      done: 0,
      total: nftTotalChunks,
      found: Object.values(nftsMap).filter((n) => !n.spent).length,
      last_warning: null,
      detail: null,
      started_at: Date.now(),
    });

    // ── Phase 2 (drain pending) runs BEFORE Phase 1. See CAT stage below
    //    for the rationale: on coinset's rate-limited backend Phase 1 eats
    //    the whole tick budget, leaving the queue stuck forever otherwise.
    const NFT_PARSE_BATCH = 5;
    const drainNftQueue = async () => {
      let pendingArr = Object.values(pendingNfts);
      while (pendingArr.length > 0 && Date.now() < deadline) {
        const batch = pendingArr.slice(0, NFT_PARSE_BATCH);
        await patchStageProgress("nfts", {
          detail: `parsing ${batch.length} of ${pendingArr.length} pending`,
        });
        try {
          const parseRes = await withTimeout(
            callEngine<{
              nfts: NftView[];
              unparseable_coin_ids?: string[];
            }>("nft_parse_candidates", {
              endpoint: "mainnet",
              candidates: batch,
            }),
            NFT_SCAN_TIMEOUT_MS,
            `nft_parse_candidates(${batch.length})`,
          );
          for (const n of parseRes.nfts) {
            const existing = nftsMap[n.launcher_id];
            if (
              !existing ||
              n.confirmed_block_index >= existing.confirmed_block_index
            ) {
              nftsMap[n.launcher_id] = n;
            }
          }
          for (const c of batch) delete pendingNfts[c.coin_id];
          for (const id of parseRes.unparseable_coin_ids ?? []) {
            delete pendingNfts[id];
          }
          store.nfts = nftsMap;
          store.nfts_synced_at = Date.now();
          store.pending_nft_candidates = pendingNfts;
          await writeCoinStore(wallet.fingerprint, store);
          await patchStageProgress("nfts", {
            found: Object.values(nftsMap).filter((n) => !n.spent).length,
          });
        } catch (err) {
          console.warn("[Loroco] NFT parse batch failed:", (err as Error).message);
          await patchStageProgress("nfts", {
            last_warning: `parse: ${(err as Error).message}`,
          });
          break;
        }
        pendingArr = Object.values(pendingNfts);
      }
    };

    await drainNftQueue();

    // ── Phase 1: hint sweep → enqueue raw candidates ────────────────────
    if (nftsStale) {
      for (let start = 0; start < DERIVE_COUNT; start += SCAN_CHUNK_PHS) {
        if (Date.now() > deadline) break;
        const count = Math.min(SCAN_CHUNK_PHS, DERIVE_COUNT - start);
        const chunkHints: Record<string, number> = {};
        let minHintHeight: number | null = null;
        for (let i = 0; i < count; i += 1) {
          const ph = allPhs[start + i]!;
          const cursor = nftsHintHeights[ph];
          if (typeof cursor === "number") {
            const startH = Math.max(0, cursor - REORG_WINDOW);
            chunkHints[ph] = startH;
            if (minHintHeight == null || startH < minHintHeight) minHintHeight = startH;
          }
        }
        await patchStageProgress("nfts", {
          detail:
            minHintHeight != null
              ? `hints ${start}..${start + count - 1} · from #${minHintHeight.toLocaleString()}`
              : `hints ${start}..${start + count - 1} · full sweep`,
          block_from: minHintHeight,
        });
        try {
          const hintRes = await withTimeout(
            callEngine<{
              candidates: RawAssetCandidate[];
              peak_height: number | null;
              failed_hints?: string[];
            }>("asset_scan_hints", {
              master_public_key: masterPk,
              start,
              count,
              testnet: false,
              endpoint: "mainnet",
              hint_start_heights: chunkHints,
              extra_inner_phs: hardenedSorted.slice(start, start + count),
            }),
            SCAN_TIMEOUT_MS,
            `asset_scan_hints[${start}..${start + count}]`,
          );
          assetScanRanInNftStage = true;
          const failedSet = new Set(hintRes.failed_hints ?? []);
          // Each candidate is asset-type-agnostic — fan it into both
          // queues so the CAT stage can skip its own Phase-1 fetch.
          for (const c of hintRes.candidates) {
            pendingNfts[c.coin_id] = c;
            pendingCats[c.coin_id] = c;
          }
          if (typeof hintRes.peak_height === "number") {
            for (let i = 0; i < count; i += 1) {
              const ph = allPhs[start + i]!;
              if (!failedSet.has(ph)) {
                nftsHintHeights[ph] = hintRes.peak_height;
                catsHintHeights[ph] = hintRes.peak_height;
              }
            }
          }
          if (failedSet.size > 0) {
            await patchStageProgress("nfts", {
              last_warning: `coinset blip — ${failedSet.size} hint(s) will retry next tick`,
            });
          }
          nftChunksDone += 1;
          store.pending_nft_candidates = pendingNfts;
          store.nft_hint_heights = nftsHintHeights;
          store.pending_cat_candidates = pendingCats;
          store.cat_hint_heights = catsHintHeights;
          await writeCoinStore(wallet.fingerprint, store);
        } catch (err) {
          console.warn("[Loroco] NFT hint chunk failed:", (err as Error).message);
          await patchStageProgress("nfts", {
            last_warning: (err as Error).message,
          });
        }
        await patchStageProgress("nfts", {
          done: nftChunksDone,
          total: nftTotalChunks,
          found: Object.values(nftsMap).filter((n) => !n.spent).length,
        });
      }
    } else {
      nftChunksDone = nftTotalChunks;
      await patchStageProgress("nfts", {
        done: nftChunksDone,
        total: nftTotalChunks,
      });
    }

    // Drain anything Phase 1 just added.
    await drainNftQueue();
    } // end of nftsStale-OR-pending branch

    // 6b. CAT scan — same TWO-PHASE pipeline as NFTs.
    type CatRecord = {
      asset_id: string;
      total_unspent_mojos: string;
      unspent_coin_count: number;
      coins: Array<{
        coin_id: string;
        parent_coin_info: string;
        puzzle_hash: string;
        amount: string;
        inner_puzzle_hash: string;
        hidden_puzzle_hash?: string | null;
        hint: string;
        confirmed_block_index: number;
        spent: boolean;
        spent_block_index: number;
        lineage_proof: { parent_name: string; inner_puzzle_hash: string; amount: string };
      }>;
    };
    const catsMap: Record<string, CatRecord> = { ...(store.cats ?? {}) };
    // NOTE: `catsHintHeights` + `pendingCats` are hoisted above the NFT
    // stage so its `asset_scan_hints` call can populate them in the same
    // fetch. If the NFT stage already ran (`assetScanRanInNftStage`), the
    // CAT stage's own Phase-1 loop is a no-op below.
    const catTotalChunks = Math.ceil(DERIVE_COUNT / SCAN_CHUNK_PHS);
    let catChunksDone = 0;
    const catsHasCursors = Object.keys(catsHintHeights).length === addresses.length;
    // Sidecar already swept hints for us — skip Phase 1.
    const sidecarHandledCatHints = useSidecar && sidecarCandidates > 0;
    // NFT stage's `asset_scan_hints` call already populated `pendingCats`
    // + `catsHintHeights` in this tick — Phase 1 here would refetch the
    // same hints. Skip it.
    const nftStageHandledCatHints = assetScanRanInNftStage;
    const catsStale =
      !sidecarHandledCatHints &&
      !nftStageHandledCatHints &&
      (opts.force ||
        catsHasCursors ||
        !store.cats_synced_at ||
        Date.now() - store.cats_synced_at > CAT_NFT_REFRESH_INTERVAL_MS);
    if (!catsStale && Object.keys(pendingCats).length === 0) {
      await patchStageProgress("cats", {
        done: catTotalChunks,
        total: catTotalChunks,
        found: Object.keys(catsMap).length,
        last_warning: null,
      });
    } else {
    await patchStageProgress("cats", {
      done: 0,
      total: catTotalChunks,
      found: Object.keys(catsMap).length,
      last_warning: null,
      detail: null,
      started_at: Date.now(),
    });

    // ── Phase 2 (drain pending) runs BEFORE Phase 1 (hint sweep). ───────
    //
    // Order matters: on rate-limited backends (coinset.org) Phase 1 can eat
    // the entire tick budget and never reach Phase 2, leaving the pending
    // queue stuck across ticks forever. By draining first we guarantee
    // forward progress on parsing; new candidates Phase 1 finds this tick
    // get parsed on the NEXT tick. The per-chunk persistence in Phase 1
    // means nothing is lost.
    const CAT_PARSE_BATCH = 5;
    const drainCatQueue = async () => {
      let pendingCatArr = Object.values(pendingCats);
      while (pendingCatArr.length > 0 && Date.now() < deadline) {
        const batch = pendingCatArr.slice(0, CAT_PARSE_BATCH);
        await patchStageProgress("cats", {
          detail: `parsing ${batch.length} of ${pendingCatArr.length} pending`,
        });
        try {
          const parseRes = await withTimeout(
            callEngine<{
              cats: CatRecord[];
              unparseable_coin_ids?: string[];
            }>("cat_parse_candidates", {
              endpoint: "mainnet",
              candidates: batch,
            }),
            SCAN_TIMEOUT_MS,
            `cat_parse_candidates(${batch.length})`,
          );
          for (const c of parseRes.cats) {
            const existing = catsMap[c.asset_id];
            if (existing) {
              const seen = new Set(existing.coins.map((x) => x.coin_id));
              for (const coin of c.coins) {
                if (!seen.has(coin.coin_id)) existing.coins.push(coin);
              }
            } else {
              catsMap[c.asset_id] = c;
            }
            const bucket = catsMap[c.asset_id]!;
            if (bucket.coins.length > 200) {
              const unspent = bucket.coins.filter((x) => !x.spent);
              const recentSpent = bucket.coins
                .filter((x) => x.spent)
                .sort((a, b) => b.spent_block_index - a.spent_block_index)
                .slice(0, 50);
              bucket.coins = [...unspent, ...recentSpent];
              bucket.unspent_coin_count = unspent.length;
              let total = 0n;
              for (const u of unspent) total += BigInt(u.amount);
              bucket.total_unspent_mojos = total.toString();
            }
          }
          for (const c of batch) delete pendingCats[c.coin_id];
          for (const id of parseRes.unparseable_coin_ids ?? []) {
            delete pendingCats[id];
          }
          store.cats = catsMap;
          store.cats_synced_at = Date.now();
          store.pending_cat_candidates = pendingCats;
          await writeCoinStore(wallet.fingerprint, store);
          await patchStageProgress("cats", {
            found: Object.keys(catsMap).length,
          });
        } catch (err) {
          console.warn("[Loroco] CAT parse batch failed:", (err as Error).message);
          await patchStageProgress("cats", {
            last_warning: `parse: ${(err as Error).message}`,
          });
          break;
        }
        pendingCatArr = Object.values(pendingCats);
      }
    };

    await drainCatQueue();

    // ── Phase 1: hint sweep → enqueue raw CAT candidates ────────────────
    if (catsStale) {
      for (let start = 0; start < DERIVE_COUNT; start += SCAN_CHUNK_PHS) {
        if (Date.now() > deadline) break;
        const count = Math.min(SCAN_CHUNK_PHS, DERIVE_COUNT - start);
        const chunkHints: Record<string, number> = {};
        let minHintHeight: number | null = null;
        for (let i = 0; i < count; i += 1) {
          const ph = allPhs[start + i]!;
          const cursor = catsHintHeights[ph];
          if (typeof cursor === "number") {
            const startH = Math.max(0, cursor - REORG_WINDOW);
            chunkHints[ph] = startH;
            if (minHintHeight == null || startH < minHintHeight) minHintHeight = startH;
          }
        }
        await patchStageProgress("cats", {
          detail:
            minHintHeight != null
              ? `hints ${start}..${start + count - 1} · from #${minHintHeight.toLocaleString()}`
              : `hints ${start}..${start + count - 1} · full sweep`,
          block_from: minHintHeight,
        });
        try {
          const hintRes = await withTimeout(
            callEngine<{
              candidates: RawAssetCandidate[];
              peak_height: number | null;
              failed_hints?: string[];
            }>("asset_scan_hints", {
              master_public_key: masterPk,
              start,
              count,
              testnet: false,
              endpoint: "mainnet",
              hint_start_heights: chunkHints,
              extra_inner_phs: hardenedSorted.slice(start, start + count),
            }),
            SCAN_TIMEOUT_MS,
            `asset_scan_hints[${start}..${start + count}]`,
          );
          const failedSet = new Set(hintRes.failed_hints ?? []);
          // Fan into both queues — the NFT stage might run on a later
          // tick when the CAT throttle wins this one.
          for (const c of hintRes.candidates) {
            pendingCats[c.coin_id] = c;
            pendingNfts[c.coin_id] = c;
          }
          if (typeof hintRes.peak_height === "number") {
            for (let i = 0; i < count; i += 1) {
              const ph = allPhs[start + i]!;
              if (!failedSet.has(ph)) {
                catsHintHeights[ph] = hintRes.peak_height;
                nftsHintHeights[ph] = hintRes.peak_height;
              }
            }
          }
          if (failedSet.size > 0) {
            await patchStageProgress("cats", {
              last_warning: `coinset blip — ${failedSet.size} hint(s) will retry next tick`,
            });
          }
          catChunksDone += 1;
          store.pending_cat_candidates = pendingCats;
          store.cat_hint_heights = catsHintHeights;
          store.pending_nft_candidates = pendingNfts;
          store.nft_hint_heights = nftsHintHeights;
          await writeCoinStore(wallet.fingerprint, store);
        } catch (err) {
          console.warn("[Loroco] CAT hint chunk failed:", (err as Error).message);
          await patchStageProgress("cats", {
            last_warning: (err as Error).message,
          });
        }
        await patchStageProgress("cats", {
          done: catChunksDone,
          total: catTotalChunks,
          found: Object.keys(catsMap).length,
        });
      }
    } else {
      catChunksDone = catTotalChunks;
      await patchStageProgress("cats", {
        done: catChunksDone,
        total: catTotalChunks,
      });
    }

    // Drain anything Phase 1 just added (best-effort — bails on deadline).
    await drainCatQueue();
    if (catChunksDone > 0) {
      const assetIds = Object.keys(catsMap);
      if (assetIds.length > 0) {
        void resolveCatMetadata(assetIds).catch(() => {});
      }
    }
    } // end of catsStale-OR-pending branch

    // ── Incoming CAT / NFT notifications ─────────────────────────────────
    // A CAT coin or NFT only enters our store because the hint scan matched our
    // p2 puzzle hash, so any one that's NEW this tick (and above the baseline) is
    // a receive. Stay quiet when we also spent something this tick (it's our own
    // change/transfer, not an incoming payment).
    if (!anySpentThisTick) {
      // New CAT coins, summed per asset.
      const newCatByAsset: Record<string, { mojos: bigint; block: number }> = {};
      for (const [assetId, cat] of Object.entries(store.cats ?? {})) {
        for (const coin of cat.coins) {
          if (
            !coin.spent &&
            !knownCatCoinIds.has(coin.coin_id) &&
            coin.confirmed_block_index > notifBaseline
          ) {
            const cur = newCatByAsset[assetId] ?? { mojos: 0n, block: 0 };
            cur.mojos += BigInt(coin.amount);
            cur.block = Math.max(cur.block, coin.confirmed_block_index);
            newCatByAsset[assetId] = cur;
          }
        }
      }
      const newCatAssetIds = Object.keys(newCatByAsset);
      if (newCatAssetIds.length > 0) {
        const meta = await resolveCatMetadata(newCatAssetIds).catch(() => ({}) as Record<string, { code?: string; decimals?: number }>);
        for (const assetId of newCatAssetIds) {
          const { mojos, block } = newCatByAsset[assetId]!;
          const m = meta[assetId] ?? meta[assetId.replace(/^0x/, "")];
          void notify({
            kind: "incoming-confirmed",
            dedupId: `recv-cat-${assetId}-${block}`,
            title: "Token received",
            message: `${fmtCatMojos(mojos, m?.decimals ?? 3, m?.code)} arrived in your wallet.`,
          });
        }
      }
      // New NFTs.
      let newNftCount = 0;
      let newNftBlock = 0;
      for (const [launcher, nft] of Object.entries(store.nfts ?? {})) {
        if (!nft.spent && !knownNftLaunchers.has(launcher) && nft.confirmed_block_index > notifBaseline) {
          newNftCount += 1;
          newNftBlock = Math.max(newNftBlock, nft.confirmed_block_index);
        }
      }
      if (newNftCount > 0) {
        void notify({
          kind: "incoming-confirmed",
          dedupId: `recv-nft-${newNftBlock}`,
          title: newNftCount === 1 ? "NFT received" : "NFTs received",
          message: `${newNftCount} NFT${newNftCount === 1 ? "" : "s"} arrived in your wallet.`,
        });
      }
    }

    // Count "full sync" relative to whether each scan ran. If the throttle
    // skipped a section, the existing freshness is still valid, so treat
    // those as done. Otherwise require all chunks completed.
    const catsFresh = !catsStale || catChunksDone === catTotalChunks;
    const nftsFresh = !nftsStale || nftChunksDone === nftTotalChunks;
    const fullSync = catsFresh && nftsFresh;
    await writeTelemetry({
      stage: "done",
      fingerprint: wallet.fingerprint,
      tick_started_at: null,
      last_attempt_at: startedAt,
      last_success_at: Date.now(),
      last_full_sync_at: fullSync ? Date.now() : undefined,
      last_error: null,
      last_peak_height: scan.peak_height,
      last_new_coins: newCoins,
      totals: {
        xch_coins: Object.values(store.coins).filter((c) => !c.spent).length,
        cat_assets: Object.keys(store.cats ?? {}).length,
        nfts: Object.values(store.nfts ?? {}).filter((n) => !n.spent).length,
      },
    });
  } catch (err) {
    await writeTelemetry({
      last_attempt_at: startedAt,
      last_error: (err as Error).message,
    });
  } finally {
    void chrome.action.setBadgeText({ text: "" }).catch(() => {});
    running = false;
  }
}
