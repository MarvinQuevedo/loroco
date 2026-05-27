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

interface CoinsetEvent {
  type?: string;
  data?: unknown;
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

  // Walk additions → incoming.
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
    });
  }

  // Walk removals → outgoing.
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
  if (newIncoming.length === 0 && !haveOutgoing) return;

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

function handleMessage(raw: string): void {
  let event: CoinsetEvent;
  try {
    event = JSON.parse(raw) as CoinsetEvent;
  } catch {
    return;
  }
  if (event.type === "peak") {
    void processPeak(event.data as PeakEventData);
  } else if (event.type === "transaction") {
    void processTransaction(event.data as TransactionEventData).catch((err) => {
      console.warn("[mempool-watch] processTransaction failed:", err);
    });
  }
  // `offer` events ignored for now.
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
    handleMessage(typeof ev.data === "string" ? ev.data : "");
  });
  socket.addEventListener("close", (ev) => {
    socket = null;
    scheduleReconnect(`close (${ev.code} ${ev.reason || "no reason"})`);
  });
  socket.addEventListener("error", () => {
    // Some browsers don't emit close after error — force a reconnect.
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
