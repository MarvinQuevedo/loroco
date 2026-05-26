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
  type CoinRecord,
  type NftView,
  readCoinStore,
  writeCoinStore,
} from "./coin-store.js";
import { resolveCatMetadata } from "./dexie.js";
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
const MAX_TICK_MS = 120_000;
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
    let newCoins = 0;
    for (const rec of scan.coin_records) {
      if (!(rec.coin_id in store.coins)) newCoins += 1;
      store.coins[rec.coin_id] = rec;
    }
    for (const ph of allPhs) {
      store.ph_heights[ph] = scan.peak_height;
    }
    store.last_synced_height = scan.peak_height;

    // Persist after step 4 so the UI sees XCH/Activity even if the CAT/NFT
    // scans below time out or the SW dies mid-flight.
    await writeCoinStore(wallet.fingerprint, store);
    const xchUnspent = Object.values(store.coins).filter((c) => !c.spent).length;
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

    // 5. Verify still-unspent set in chunks (in case the indexer says they're
    //    gone or now spent since the last tick).
    const unspentIds = Object.values(store.coins)
      .filter((c) => !c.spent)
      .map((c) => c.coin_id);
    for (let i = 0; i < unspentIds.length; i += 250) {
      if (Date.now() > deadline) break;
      const chunk = unspentIds.slice(i, i + 250);
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
        for (const s of res.spent) {
          const c = store.coins[s.coin_id];
          if (c) {
            c.spent = true;
            c.spent_block_index = s.spent_block_index;
          }
        }
        for (const missingId of res.missing) {
          delete store.coins[missingId];
        }
      } catch {
        // best-effort; continue with next chunk
      }
    }

    // ── ORDER NOTE ──
    // We run NFT scan BEFORE CAT scan. NFT hint responses are tiny (a few
    // singletons per PH at most) so the stage completes in ~5–10s, giving
    // the user immediate visual confirmation in the popup's NFTs tab.
    // CAT scans can take 30–60s on deep-history wallets and occasionally
    // OOM-crash the WASM module on a single huge hint response — running
    // them first would hide NFTs behind that risk. Order: XCH → NFTs → CATs.

    // 6a. NFT scan — chunked by inner_ph; per-chunk persistence.
    await writeTelemetry({ stage: "nfts" });
    const nftsMap: Record<string, NftView> = { ...(store.nfts ?? {}) };
    const nftsHintHeights: Record<string, number> = { ...(store.nft_hint_heights ?? {}) };
    const nftTotalChunks = Math.ceil(DERIVE_COUNT / SCAN_CHUNK_PHS);
    let nftChunksDone = 0;
    const nftsHasCursors = Object.keys(nftsHintHeights).length === addresses.length;
    const nftsStale =
      opts.force ||
      nftsHasCursors ||
      !store.nfts_synced_at ||
      Date.now() - store.nfts_synced_at > CAT_NFT_REFRESH_INTERVAL_MS;
    if (!nftsStale) {
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
            ? `addrs ${start}..${start + count - 1} · from #${minHintHeight.toLocaleString()}`
            : `addrs ${start}..${start + count - 1} · full sweep`,
        block_from: minHintHeight,
      });
      try {
        const nftRes = await withTimeout(
          callEngine<{
            nfts: NftView[];
            peak_height: number | null;
            failed_hints?: string[];
          }>("scan_nfts", {
            master_public_key: masterPk,
            start,
            count,
            testnet: false,
            endpoint: "mainnet",
            hint_start_heights: chunkHints,
            // Distribute hardened PHs one-per-chunk so chunk 0 isn't a
            // 50-PH monster. Each chunk gets the hardened entries at the
            // matching derivation slice — i.e. chunk `start` gets
            // `hardenedSorted[start..start+count]`. After we exhaust the
            // hardened list (if it's shorter than unhardened range) the
            // remaining chunks just scan their 1 unhardened PH.
            extra_inner_phs: hardenedSorted.slice(start, start + count),
          }),
          NFT_SCAN_TIMEOUT_MS,
          `scan_nfts[${start}..${start + count}]`,
        );
        const failedSet = new Set(nftRes.failed_hints ?? []);
        if (typeof nftRes.peak_height === "number") {
          for (let i = 0; i < count; i += 1) {
            const ph = allPhs[start + i]!;
            if (!failedSet.has(ph)) nftsHintHeights[ph] = nftRes.peak_height;
          }
        }
        if (failedSet.size > 0) {
          await patchStageProgress("nfts", {
            last_warning: `coinset blip — ${failedSet.size} hint(s) will retry next tick`,
          });
        }
        let chunkAdded = false;
        for (const n of nftRes.nfts) {
          const existing = nftsMap[n.launcher_id];
          if (
            !existing ||
            n.confirmed_block_index >= existing.confirmed_block_index
          ) {
            nftsMap[n.launcher_id] = n;
            chunkAdded = true;
          }
        }
        nftChunksDone += 1;
        // Persist the full store only when this chunk added NFTs. Writing
        // the entire store every chunk (40 times in ~15s on a deep wallet)
        // saturated chrome.storage.local and triggered SW crashes mid-scan.
        // Cursors advance even on empty chunks, but they're tiny and stored
        // separately at the END of the loop — losing them on crash only
        // costs one re-scan per affected PH, which is cheap.
        if (chunkAdded) {
          store.nfts = nftsMap;
          store.nfts_synced_at = Date.now();
          store.nft_hint_heights = nftsHintHeights;
          await writeCoinStore(wallet.fingerprint, store);
        }
      } catch (err) {
        console.warn("[Loroco] NFT chunk failed:", (err as Error).message);
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
    if (nftChunksDone > 0) {
      store.nfts = nftsMap;
      store.nfts_synced_at = Date.now();
      store.nft_hint_heights = nftsHintHeights;
      await writeCoinStore(wallet.fingerprint, store);
    }
    } // end of nftsStale branch

    // 6b. Discover CATs by hint matching, chunked across inner_phs so a
    //     single slow batch doesn't block the whole tick.
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
    const catTotalChunks = Math.ceil(DERIVE_COUNT / SCAN_CHUNK_PHS);
    let catChunksDone = 0;
    // With the incremental hint cursor in place, we no longer need the 5-min
    // staleness gate as load-bearing — every tick can run cheaply because we
    // ask coinset only for NEW hint matches since the per-PH cursor. The gate
    // still helps if the cursor is empty (first-time scan), so we keep it.
    const catsHintHeights: Record<string, number> = { ...(store.cat_hint_heights ?? {}) };
    const catsHasCursors = Object.keys(catsHintHeights).length === addresses.length;
    const catsStale =
      opts.force ||
      catsHasCursors || // cursors → always run, it's cheap
      !store.cats_synced_at ||
      Date.now() - store.cats_synced_at > CAT_NFT_REFRESH_INTERVAL_MS;
    if (!catsStale) {
      // Skip — recent enough. Report stage progress as "done" using the
      // chunks we'd have run, so the badge shows ✓ instead of pretending we
      // never scanned.
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
    for (let start = 0; start < DERIVE_COUNT; start += SCAN_CHUNK_PHS) {
      if (Date.now() > deadline) break;
      const count = Math.min(SCAN_CHUNK_PHS, DERIVE_COUNT - start);
      // Build hint_start_heights for the PHs in this chunk. Format: lowercase
      // 0x-prefixed hex keys — matches what the Rust side does with
      // `format!("0x{}", hex::encode(hint))`.
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
            ? `addrs ${start}..${start + count - 1} · from #${minHintHeight.toLocaleString()}`
            : `addrs ${start}..${start + count - 1} · full sweep`,
        block_from: minHintHeight,
      });
      try {
        const catRes = await withTimeout(
          callEngine<{
            cats: CatRecord[];
            peak_height: number | null;
            failed_hints?: string[];
          }>("scan_cats", {
            master_public_key: masterPk,
            start,
            count,
            testnet: false,
            endpoint: "mainnet",
            hint_start_heights: chunkHints,
            // Distribute hardened PHs one-per-chunk so chunk 0 isn't a
            // 50-PH monster. Each chunk gets the hardened entries at the
            // matching derivation slice — i.e. chunk `start` gets
            // `hardenedSorted[start..start+count]`. After we exhaust the
            // hardened list (if it's shorter than unhardened range) the
            // remaining chunks just scan their 1 unhardened PH.
            extra_inner_phs: hardenedSorted.slice(start, start + count),
          }),
          SCAN_TIMEOUT_MS,
          `scan_cats[${start}..${start + count}]`,
        );
        // Advance the per-PH cursors for this chunk to peak_height — but
        // ONLY for PHs whose hint queries actually succeeded. PHs in
        // failed_hints stay at their old cursor so the next tick retries.
        const failedSet = new Set(catRes.failed_hints ?? []);
        if (typeof catRes.peak_height === "number") {
          for (let i = 0; i < count; i += 1) {
            const ph = allPhs[start + i]!;
            if (!failedSet.has(ph)) catsHintHeights[ph] = catRes.peak_height;
          }
        }
        if (failedSet.size > 0) {
          await patchStageProgress("cats", {
            last_warning: `coinset blip — ${failedSet.size} hint(s) will retry next tick`,
          });
        }
        for (const c of catRes.cats) {
          const existing = catsMap[c.asset_id];
          if (existing) {
            // Merge coin sets from this chunk into the asset bucket.
            const seen = new Set(existing.coins.map((x) => x.coin_id));
            for (const coin of c.coins) {
              if (!seen.has(coin.coin_id)) existing.coins.push(coin);
            }
          } else {
            catsMap[c.asset_id] = c;
          }
          // Cap per-asset coin retention so wallets with deep CAT history
          // don't grow chrome.storage.local unbounded (a 47-asset wallet
          // with thousands of historical coins blew past the popup's
          // message-passing budget and crashed the renderer). Keep every
          // unspent + the 50 most recent spent per asset.
          const bucket = catsMap[c.asset_id]!;
          if (bucket.coins.length > 200) {
            const unspent = bucket.coins.filter((x) => !x.spent);
            const recentSpent = bucket.coins
              .filter((x) => x.spent)
              .sort((a, b) => b.spent_block_index - a.spent_block_index)
              .slice(0, 50);
            bucket.coins = [...unspent, ...recentSpent];
            bucket.unspent_coin_count = unspent.length;
            // Recompute the unspent total in case we dropped any.
            let total = 0n;
            for (const u of unspent) total += BigInt(u.amount);
            bucket.total_unspent_mojos = total.toString();
          }
        }
        catChunksDone += 1;
        // Persist after EVERY successful chunk so a mid-loop WASM crash
        // (deep-history wallets OOM the module while decoding a giant
        // coinset response) doesn't lose chunks 0..N-1. Without this, the
        // next tick restarts from genesis on every PH.
        store.cats = catsMap;
        store.cats_synced_at = Date.now();
        store.cat_hint_heights = catsHintHeights;
        await writeCoinStore(wallet.fingerprint, store);
      } catch (err) {
        console.warn("[Loroco] CAT chunk failed:", (err as Error).message);
        await patchStageProgress("cats", {
          last_warning: (err as Error).message,
        });
        // Continue to the next chunk — partial progress is still useful.
      }
      await patchStageProgress("cats", {
        done: catChunksDone,
        total: catTotalChunks,
        found: Object.keys(catsMap).length,
      });
    }
    if (catChunksDone > 0) {
      const assetIds = Object.keys(catsMap);
      if (assetIds.length > 0) {
        void resolveCatMetadata(assetIds).catch(() => {});
      }
    }
    } // end of catsStale branch

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
    running = false;
  }
}
