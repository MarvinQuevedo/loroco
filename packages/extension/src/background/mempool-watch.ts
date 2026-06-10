// Mempool watcher — coinset.org WebSocket.
//
// Connects to `wss://api.coinset.org/ws` and reacts to push events:
//
//   • `peak`         → new block height. Triggers an immediate
//                      `tickCoinSync()` so confirmations land fast instead
//                      of waiting up to 30s for the next alarm.
//   • `transaction`  → a mempool item the indexer just saw. We pattern-
//                      match its additions/removals against:
//                        – derived puzzle hashes (XCH incoming)
//                        – store.coins / store.cats[*].coins (outgoing
//                          spends, ours or another wallet's that shares
//                          this seed)
//                      Matches land in `store.mempool.{incoming,outgoing}`.
//   • `offer`        → an offer file showed up on dexie. Out of scope for
//                      now; future work could surface this in the offers
//                      tab.
//
// Lifecycle:
//   • The SW opens the socket on startup (alarm fires immediately) and
//     reconnects with exponential backoff on disconnect.
//   • Chrome MV3 SWs let WebSocket activity reset the idle timer (Chrome
//     116+), so a steady stream of `peak`/`transaction` events keeps the
//     SW alive without our `chrome.alarms("keepalive")` doing all the
//     work. A 30s `mempool-watch` alarm re-arms `ensureSocket()` after
//     any forced SW restart.
//   • No localhost sidecar today — when sage-wallet's sync_manager grows
//     a `/events` SSE endpoint we can swap behind a flag without
//     restructuring this file.

import { tickCoinSync } from "./coin-sync.js";
import {
  type MempoolIncoming,
  type MempoolOutgoing,
  MEMPOOL_TTL_MS,
  findCatCoinIdByOutpoint,
  findXchCoinIdByOutpoint,
  readCoinStore,
  writeCoinStore,
} from "./coin-store.js";
import { callEngine } from "./engine.js";

const WS_URL = "wss://api.coinset.org/ws";

// NOTE: coinset's public WS only ever emits `peak` — it never pushes
// per-transaction events. We deliberately do NOT poll the full mempool
// (get_all_mempool_tx_ids + per-item fetches every few seconds) — that
// saturates coinset and competes with the coin-sync scans. Instead, all
// user-facing notifications are CONFIRMATION-based and fire from the
// peak-triggered coin-sync (see coin-sync.ts): a received coin, our own send
// confirming, or a coin spent by another device. No extra network load.

interface RawCoin {
  parent_coin_info: string;
  puzzle_hash: string;
  amount: number;
}

interface CoinSpendRaw {
  coin: RawCoin;
  puzzle_reveal?: string;
  solution?: string;
}

/**
 * Best-effort shape for the `transaction` event. The doc only formalises
 * `offer`; this is the empirical superset of fields seen in the wild and
 * what other Chia indexers emit. Fields are optional so a partial payload
 * still parses.
 */
interface TransactionEventData {
  /** spend bundle name = tx_id, hex-prefixed with 0x. */
  spend_bundle_name?: string;
  /** Alternative name some emitters use. */
  tx_id?: string;
  additions?: RawCoin[];
  removals?: RawCoin[];
  spend_bundle?: {
    coin_spends?: CoinSpendRaw[];
    aggregated_signature?: string;
  };
}

interface PeakEventData {
  height?: number;
  peak?: { height?: number };
}

/**
 * Real shape coinset emits — the inner `message: { type, data }` wraps
 * the documented event, and the outer envelope carries `network`, `seq`
 * and an `instance_id` we don't use today. Empirically observed by
 * dumping the first few raw frames; the public docs only show the inner
 * shape so this took some fishing.
 */
interface CoinsetEvent {
  network?: string;
  region?: string;
  instance_id?: string;
  seq?: number;
  message?: {
    type?: string;
    data?: unknown;
  };
}

interface StoredWalletEntry {
  fingerprint: number;
  masterPublicKey?: string;
}

function with0x(s: string): string {
  return s.startsWith("0x") ? s : `0x${s}`;
}
function strip0x(s: string): string {
  return s.startsWith("0x") ? s.slice(2) : s;
}

async function loadActiveContext(): Promise<{ fp: number; masterPk: string } | null> {
  const session = await chrome.storage.session.get("activeFingerprint");
  const fp = session.activeFingerprint;
  if (typeof fp !== "number") return null;
  const local = await chrome.storage.local.get("wallets");
  const wallets = (local.wallets as Record<string, StoredWalletEntry> | undefined) ?? {};
  const masterPk = wallets[fp.toString()]?.masterPublicKey;
  if (!masterPk) return null;
  return { fp, masterPk };
}

/**
 * Owned PHs cache — refreshed lazily. Computing 200 unhardened addresses
 * costs an engine call (a few ms but blocks the SW); we keep the set in
 * memory for `OWNED_PHS_TTL_MS` so each transaction event is a pure
 * `Set.has(ph)` lookup. The wallet's PH set doesn't change unless the
 * user adds derivations, so a long TTL is safe.
 */
const OWNED_PHS_TTL_MS = 5 * 60_000;
let ownedPhsCache: { fp: number; phs: Set<string>; cached_at: number } | null = null;

async function getOwnedPhs(fp: number, masterPk: string): Promise<Set<string>> {
  if (
    ownedPhsCache &&
    ownedPhsCache.fp === fp &&
    Date.now() - ownedPhsCache.cached_at < OWNED_PHS_TTL_MS
  ) {
    return ownedPhsCache.phs;
  }
  const phs = new Set<string>();
  const store = await readCoinStore(fp);
  for (const ph of Object.keys(store.hardened_phs ?? {})) phs.add(strip0x(ph));
  try {
    const res = await callEngine<{ addresses: { puzzle_hash: string }[] }>(
      "derive_addresses",
      { master_public_key: masterPk, start: 0, count: 200, testnet: false },
    );
    for (const a of res.addresses) phs.add(strip0x(a.puzzle_hash));
  } catch {
    // engine not yet ready (fresh SW). Fall back to whatever hardened set we
    // already cached — better than zero matches.
  }
  ownedPhsCache = { fp, phs, cached_at: Date.now() };
  return phs;
}

/**
 * Force-refresh of the owned PHs cache. Called from outside (e.g. when a
 * wallet switches) so the next transaction event uses the new owner set.
 */
export function invalidateOwnedPhsCache(): void {
  ownedPhsCache = null;
}

/**
 * Process one `transaction` event. Idempotent — if we already have this
 * tx_id in `store.mempool`, we just bump its `seen_at` so the TTL doesn't
 * evict an item that's still in the mempool.
 */
async function processTransaction(data: TransactionEventData): Promise<void> {
  const ctx = await loadActiveContext();
  if (!ctx) return;
  const { fp, masterPk } = ctx;

  // Normalize coins+tx_id across the two field-name conventions we've
  // observed in the wild.
  const txId = with0x(data.spend_bundle_name ?? data.tx_id ?? "");
  if (!txId || txId === "0x") return;

  const additions = data.additions ?? [];
  // Removals may live either at the top level or inside spend_bundle.coin_spends[].coin.
  let removals = data.removals ?? [];
  if (removals.length === 0 && data.spend_bundle?.coin_spends?.length) {
    removals = data.spend_bundle.coin_spends.map((cs) => cs.coin);
  }
  if (additions.length === 0 && removals.length === 0) return;

  const ownedPhs = await getOwnedPhs(fp, masterPk);
  const store = await readCoinStore(fp);
  const prev = store.mempool ?? { incoming: [], outgoing: [], last_polled_at: 0 };

  // Walk removals → outgoing FIRST so we can tell a genuine receive from our
  // own change (a tx that spends our coins AND pays an output back to us).
  const xchSpent: string[] = [];
  const catSpent: Record<string, string[]> = {};
  for (const rem of removals) {
    const parent = with0x(rem.parent_coin_info);
    const ph = with0x(rem.puzzle_hash);
    const amt = String(rem.amount);
    const xchId = findXchCoinIdByOutpoint(store, parent, ph, amt);
    if (xchId) {
      xchSpent.push(xchId);
      continue;
    }
    const cat = findCatCoinIdByOutpoint(store, parent, ph, amt);
    if (cat) {
      const list = catSpent[cat.assetId] ?? [];
      list.push(cat.coinId);
      catSpent[cat.assetId] = list;
    }
  }
  const haveOutgoing = xchSpent.length > 0 || Object.keys(catSpent).length > 0;

  // Walk additions → incoming. A receive is "genuine" only when the tx didn't
  // also spend our coins (otherwise the addition is just change).
  const newIncoming: MempoolIncoming[] = [];
  for (const add of additions) {
    const ph = strip0x(add.puzzle_hash);
    if (!ownedPhs.has(ph)) continue;
    newIncoming.push({
      tx_id: txId,
      parent_coin_info: with0x(add.parent_coin_info),
      puzzle_hash: with0x(add.puzzle_hash),
      amount: String(add.amount),
      asset_id: null,
      seen_at: Date.now(),
      genuine: !haveOutgoing,
    });
  }

  if (newIncoming.length === 0 && !haveOutgoing) return;

  // NOTE: notifications are NOT fired here. This path only runs if coinset ever
  // starts pushing WS `transaction` events (it doesn't today) and we no longer
  // poll the mempool. All user-facing alerts are confirmation-based and live in
  // coin-sync.ts so they cost no extra network traffic.

  // Merge: replace existing entries with same identity, append new ones,
  // expire stale (>TTL old).
  const now = Date.now();
  const keep = (seen: number) => now - seen < MEMPOOL_TTL_MS;
  const incomingKey = (i: MempoolIncoming) =>
    `${i.tx_id}|${i.parent_coin_info}|${i.puzzle_hash}|${i.amount}`;
  const newKeys = new Set(newIncoming.map(incomingKey));
  const mergedIncoming: MempoolIncoming[] = [
    ...prev.incoming.filter((i) => keep(i.seen_at) && !newKeys.has(incomingKey(i))),
    ...newIncoming,
  ];

  const mergedOutgoing: MempoolOutgoing[] = prev.outgoing.filter(
    (o) => keep(o.seen_at) && o.tx_id !== txId,
  );
  if (haveOutgoing) {
    const prevHit = prev.outgoing.find((o) => o.tx_id === txId);
    mergedOutgoing.push({
      tx_id: txId,
      spent_xch_coin_ids: xchSpent,
      spent_cat_coin_ids: catSpent,
      seen_at: prevHit?.seen_at ?? now,
    });
  }

  store.mempool = {
    incoming: mergedIncoming,
    outgoing: mergedOutgoing,
    last_polled_at: now,
  };
  await writeCoinStore(fp, store);
}

/**
 * Process one `peak` event. We don't store peak height in the mempool
 * struct — the existing coin-sync loop tracks the global height. We just
 * use the event as a low-latency signal to run a sync tick so any newly
 * confirmed coin records (ours or external spends) propagate fast.
 */
async function processPeak(_data: PeakEventData): Promise<void> {
  // Fire-and-forget — don't await the tick (it can take seconds on deep
  // wallets). If a previous tick is still running, this is a no-op because
  // tickCoinSync guards itself.
  void tickCoinSync().catch((err) => {
    console.warn("[mempool-watch] peak-triggered tickCoinSync failed:", err);
  });
}

// ─── WebSocket lifecycle ─────────────────────────────────────────────────

let socket: WebSocket | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function backoffMs(attempt: number): number {
  // 1s, 2s, 4s, … capped at 60s. Cloudflare's 100s WS idle timeout means
  // we'll naturally get disconnected during quiet periods; backoff has to
  // be short enough that we never miss more than a few events.
  return Math.min(60_000, 1_000 * 2 ** attempt);
}

function scheduleReconnect(reason: string): void {
  if (reconnectTimer) return;
  const wait = backoffMs(reconnectAttempt);
  reconnectAttempt = Math.min(reconnectAttempt + 1, 6);
  console.log(`[mempool-watch] reconnect in ${wait}ms (${reason})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureSocket();
  }, wait);
}

// Wallet-independent message counter — proves the WS pipeline alone is
// working even when there's no active wallet (or no matches in the current
// poll). Read it from tests via chrome.storage.local["mempoolWatchStats"].
interface StatsBuffer {
  messages: number;
  lastEvent: string;
  lastSeenAt: number;
  rawSamples: string[];
  eventTypes: Record<string, number>;
  /**
   * Rolling timestamps (ms) of the last MSG_RATE_WINDOW messages — the popup
   * derives messages/sec from this. Capped to MSG_RATE_WINDOW entries.
   */
  msgTimestamps: number[];
}
let statsBuffer: StatsBuffer | null = null;
async function persistStats(): Promise<void> {
  if (!statsBuffer) return;
  try {
    await chrome.storage.local.set({ mempoolWatchStats: statsBuffer });
  } catch {
    // best-effort
  }
}

/**
 * Hydrate the in-memory `statsBuffer` from `chrome.storage.local` on SW
 * startup. Without this, every SW restart shows "messages: 0" in the popup
 * until the next event arrives — which on a quiet network can take a minute.
 */
async function loadStatsFromStorage(): Promise<void> {
  try {
    const { mempoolWatchStats } = await chrome.storage.local.get(
      "mempoolWatchStats",
    );
    if (mempoolWatchStats && typeof mempoolWatchStats === "object") {
      const s = mempoolWatchStats as Partial<StatsBuffer>;
      statsBuffer = {
        messages: s.messages ?? 0,
        lastEvent: s.lastEvent ?? "",
        lastSeenAt: s.lastSeenAt ?? 0,
        rawSamples: Array.isArray(s.rawSamples) ? s.rawSamples : [],
        eventTypes: s.eventTypes ?? {},
        msgTimestamps: Array.isArray(s.msgTimestamps) ? s.msgTimestamps : [],
      };
    }
  } catch {
    // best-effort
  }
}
void loadStatsFromStorage();

const MSG_RATE_WINDOW = 60;

/**
 * Rolling debug feed of recent `transaction` events with ownership
 * classification. Surfaces in the popup's Mempool Debug screen so the user
 * can see what's flying through the WS — including tx that don't touch the
 * active wallet (those are dropped by processTransaction's persistence path
 * since they have no place in store.mempool).
 *
 * Stored in chrome.storage.local under `mempoolDebugFeed`. Capped to
 * MEMPOOL_DEBUG_FEED_MAX entries to keep the storage write cheap.
 */
const MEMPOOL_DEBUG_FEED_MAX = 50;

export interface MempoolDebugEntry {
  tx_id: string;
  /** ms epoch */
  observed_at: number;
  additions_count: number;
  removals_count: number;
  /** Sum of additions[].amount in mojos (as decimal string — amounts can be big). */
  total_added_mojos: string;
  total_removed_mojos: string;
  /**
   * Ownership classification of the tx vs the active wallet:
   *   - `incoming`: at least one addition lands on one of our PHs.
   *   - `outgoing`: at least one removal matched an XCH/CAT coin we hold.
   *   - `both`:     mixed (e.g. send-to-self).
   *   - `none`:     no overlap with the active wallet.
   *   - `unknown`:  no active wallet, so we couldn't classify.
   */
  mine: "incoming" | "outgoing" | "both" | "none" | "unknown";
  /** Active fingerprint when we saw the tx (may be null). */
  fp: number | null;
  /** Owned addition PHs that matched (0x-prefixed), up to 4. */
  matched_in_phs: string[];
  /** Owned CAT asset ids that matched on the removal side, up to 4. */
  matched_out_cat_assets: string[];
  /** True if at least one removal hit an XCH coin we own. */
  matched_out_xch: boolean;
  /** Heuristic asset hint: "xch", "asset" (1-mojo coins → CAT/NFT child), or "mixed". */
  shape: "xch" | "asset" | "mixed";
}

let mempoolDebugFeed: MempoolDebugEntry[] = [];

async function loadDebugFeedFromStorage(): Promise<void> {
  try {
    const { mempoolDebugFeed: existing } = await chrome.storage.local.get(
      "mempoolDebugFeed",
    );
    if (Array.isArray(existing)) {
      mempoolDebugFeed = existing as MempoolDebugEntry[];
    }
  } catch {
    // best-effort
  }
}
void loadDebugFeedFromStorage();

async function appendDebugFeed(entry: MempoolDebugEntry): Promise<void> {
  // Dedupe — if we already have this tx_id, refresh in place. Saves popup
  // re-render churn for tx that get re-broadcast.
  const existing = mempoolDebugFeed.findIndex((e) => e.tx_id === entry.tx_id);
  if (existing >= 0) {
    mempoolDebugFeed.splice(existing, 1);
  }
  mempoolDebugFeed.unshift(entry);
  if (mempoolDebugFeed.length > MEMPOOL_DEBUG_FEED_MAX) {
    mempoolDebugFeed.length = MEMPOOL_DEBUG_FEED_MAX;
  }
  try {
    await chrome.storage.local.set({ mempoolDebugFeed });
  } catch {
    // best-effort
  }
}

export function readMempoolDebugFeed(): MempoolDebugEntry[] {
  return mempoolDebugFeed;
}

export function readMempoolWatchStats(): {
  messages: number;
  lastEvent: string;
  lastSeenAt: number;
  eventTypes: Record<string, number>;
  msgsPerSec: number;
  socketOpen: boolean;
  socketState: string;
  rawSamples: string[];
} {
  const now = Date.now();
  const ts = statsBuffer?.msgTimestamps ?? [];
  const oldest = ts[0] ?? now;
  const spanMs = Math.max(1, now - oldest);
  const msgsPerSec = ts.length > 1 ? (ts.length * 1000) / spanMs : 0;
  const rs = socket?.readyState;
  const socketState =
    rs === WebSocket.CONNECTING
      ? "connecting"
      : rs === WebSocket.OPEN
        ? "open"
        : rs === WebSocket.CLOSING
          ? "closing"
          : rs === WebSocket.CLOSED
            ? "closed"
            : "no-socket";
  return {
    messages: statsBuffer?.messages ?? 0,
    lastEvent: statsBuffer?.lastEvent ?? "",
    lastSeenAt: statsBuffer?.lastSeenAt ?? 0,
    eventTypes: { ...(statsBuffer?.eventTypes ?? {}) },
    msgsPerSec,
    socketOpen: rs === WebSocket.OPEN,
    socketState,
    rawSamples: [...(statsBuffer?.rawSamples ?? [])],
  };
}

function handleMessage(raw: string): void {
  let envelope: CoinsetEvent;
  try {
    envelope = JSON.parse(raw) as CoinsetEvent;
  } catch {
    return;
  }
  const inner = envelope.message;
  const type = inner?.type ?? "unknown";
  const data = inner?.data;
  if (!statsBuffer)
    statsBuffer = {
      messages: 0,
      lastEvent: "",
      lastSeenAt: 0,
      rawSamples: [],
      eventTypes: {},
      msgTimestamps: [],
    };
  const now = Date.now();
  statsBuffer.messages += 1;
  statsBuffer.lastEvent = type;
  statsBuffer.lastSeenAt = now;
  statsBuffer.eventTypes[type] = (statsBuffer.eventTypes[type] ?? 0) + 1;
  statsBuffer.msgTimestamps.push(now);
  if (statsBuffer.msgTimestamps.length > MSG_RATE_WINDOW) {
    statsBuffer.msgTimestamps.splice(
      0,
      statsBuffer.msgTimestamps.length - MSG_RATE_WINDOW,
    );
  }
  if (statsBuffer.rawSamples.length < 5) {
    statsBuffer.rawSamples.push(raw.slice(0, 500));
  }
  void persistStats();
  // Heartbeat the snapshot's timestamp every message so the test/UI can
  // tell the WS is alive even when no matches arrive. Cheap — no await.
  void heartbeatLastPolled(type);
  if (type === "peak") {
    void processPeak(data as PeakEventData);
  } else if (type === "transaction") {
    void processTransaction(data as TransactionEventData).catch((err) => {
      console.warn("[mempool-watch] processTransaction failed:", err);
    });
    // Debug feed runs independently of processTransaction so non-matching
    // tx (the majority of mempool traffic) still land in the popup's debug
    // view. Classification reuses ownedPhs + the same outpoint lookups.
    void recordDebugEntry(data as TransactionEventData).catch((err) => {
      console.warn("[mempool-watch] recordDebugEntry failed:", err);
    });
  }
  // `offer` events ignored for now.
}

async function recordDebugEntry(data: TransactionEventData): Promise<void> {
  const txId = with0x(data.spend_bundle_name ?? data.tx_id ?? "");
  if (!txId || txId === "0x") return;

  const additions = data.additions ?? [];
  let removals = data.removals ?? [];
  if (removals.length === 0 && data.spend_bundle?.coin_spends?.length) {
    removals = data.spend_bundle.coin_spends.map((cs) => cs.coin);
  }
  if (additions.length === 0 && removals.length === 0) return;

  const totalAdded = additions.reduce(
    (acc, a) => acc + BigInt(a.amount ?? 0),
    0n,
  );
  const totalRemoved = removals.reduce(
    (acc, r) => acc + BigInt(r.amount ?? 0),
    0n,
  );

  // Shape heuristic: 1-mojo coins are the CAT/NFT inner-puzzle convention;
  // anything else is "xch" sized. Mixed if both present.
  let hasOne = false;
  let hasBig = false;
  for (const c of [...additions, ...removals]) {
    if (Number(c.amount) === 1) hasOne = true;
    else hasBig = true;
  }
  const shape: MempoolDebugEntry["shape"] =
    hasOne && hasBig ? "mixed" : hasOne ? "asset" : "xch";

  const ctx = await loadActiveContext();
  let mine: MempoolDebugEntry["mine"] = "unknown";
  const matchedInPhs: string[] = [];
  const matchedOutCatAssets: string[] = [];
  let matchedOutXch = false;
  let fp: number | null = null;

  if (ctx) {
    fp = ctx.fp;
    const ownedPhs = await getOwnedPhs(ctx.fp, ctx.masterPk);
    const store = await readCoinStore(ctx.fp);
    for (const add of additions) {
      const ph = strip0x(add.puzzle_hash);
      if (ownedPhs.has(ph)) {
        if (matchedInPhs.length < 4 && !matchedInPhs.includes(`0x${ph}`)) {
          matchedInPhs.push(`0x${ph}`);
        }
      }
    }
    for (const rem of removals) {
      const parent = with0x(rem.parent_coin_info);
      const ph = with0x(rem.puzzle_hash);
      const amt = String(rem.amount);
      if (findXchCoinIdByOutpoint(store, parent, ph, amt)) {
        matchedOutXch = true;
        continue;
      }
      const cat = findCatCoinIdByOutpoint(store, parent, ph, amt);
      if (cat && !matchedOutCatAssets.includes(cat.assetId)) {
        if (matchedOutCatAssets.length < 4) matchedOutCatAssets.push(cat.assetId);
      }
    }
    const isIn = matchedInPhs.length > 0;
    const isOut = matchedOutXch || matchedOutCatAssets.length > 0;
    mine = isIn && isOut ? "both" : isIn ? "incoming" : isOut ? "outgoing" : "none";
  }

  await appendDebugFeed({
    tx_id: txId,
    observed_at: Date.now(),
    additions_count: additions.length,
    removals_count: removals.length,
    total_added_mojos: totalAdded.toString(),
    total_removed_mojos: totalRemoved.toString(),
    mine,
    fp,
    matched_in_phs: matchedInPhs,
    matched_out_cat_assets: matchedOutCatAssets,
    matched_out_xch: matchedOutXch,
    shape,
  });
}

async function heartbeatLastPolled(_eventType: string): Promise<void> {
  try {
    const ctx = await loadActiveContext();
    if (!ctx) return;
    const store = await readCoinStore(ctx.fp);
    const prev = store.mempool ?? { incoming: [], outgoing: [], last_polled_at: 0 };
    store.mempool = { ...prev, last_polled_at: Date.now() };
    await writeCoinStore(ctx.fp, store);
  } catch {
    // best-effort heartbeat
  }
}

/**
 * Open the socket if it isn't already. Idempotent — called from both the
 * alarm (every 30s, in case the SW was restarted) and one-off bootstrap
 * paths. Safe to call concurrently; only one connection lives at a time.
 */
export function ensureSocket(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  try {
    socket = new WebSocket(WS_URL);
  } catch (err) {
    console.warn("[mempool-watch] WebSocket constructor failed:", err);
    socket = null;
    scheduleReconnect("constructor-failed");
    return;
  }
  socket.addEventListener("open", () => {
    console.log("[mempool-watch] WebSocket open");
    reconnectAttempt = 0;
  });
  socket.addEventListener("message", (ev) => {
    // coinset emits text frames in practice, but Chrome's default
    // binaryType is "blob". If we ever get a Blob/ArrayBuffer we'd silently
    // drop the event — handle both so a server-side change doesn't lock us
    // out.
    if (typeof ev.data === "string") {
      handleMessage(ev.data);
    } else if (ev.data instanceof ArrayBuffer) {
      handleMessage(new TextDecoder().decode(ev.data));
    } else if (typeof Blob !== "undefined" && ev.data instanceof Blob) {
      void ev.data.text().then(handleMessage).catch(() => {});
    }
  });
  socket.addEventListener("close", (ev) => {
    socket = null;
    scheduleReconnect(`close (${ev.code} ${ev.reason || "no reason"})`);
  });
  socket.addEventListener("error", () => {
    try {
      socket?.close();
    } catch {
      // already closed
    }
    socket = null;
    scheduleReconnect("error");
  });
}

/**
 * Heartbeat from the alarm. Re-opens the socket after SW restarts and
 * keeps mempool reconciliation healthy. The actual mempool data flows
 * via WebSocket push — this alarm is just the safety net.
 */
export async function tickMempoolWatch(): Promise<void> {
  ensureSocket();
}
