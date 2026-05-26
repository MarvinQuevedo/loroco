// HTTP client for the ozone-sidecar daemon.
//
// Exposes drop-in equivalents of the engine's `scan_puzzle_hashes` and
// `check_coins_spent` calls so coin-sync.ts can swap between WASM/coinset
// and the local peer-sync sidecar without restructuring its main loop.
//
// All requests hit 127.0.0.1 over plain HTTP — no TLS (localhost is a
// secure context) and no auth in v1.

import type { CoinRecord } from "./coin-store.js";
import { readSidecarSettings, type SidecarSettings } from "./sidecar-settings.js";

const DEFAULT_TIMEOUT_MS = 60_000;

interface ApiCoinState {
  coin_id: string;
  parent_coin_info: string;
  puzzle_hash: string;
  amount: number;
  spent: boolean;
  spent_block_index: number | null;
  confirmed_block_index: number | null;
}

interface ScanResponse {
  peak_height: number;
  header_hash: string;
  coin_states: ApiCoinState[];
  is_finished: boolean;
  next_start_height: number | null;
}

interface CheckResponse {
  peak_height: number;
  coin_states: ApiCoinState[];
}

export interface SidecarHealth {
  status: string;
  network: string;
  peer_connected: boolean;
  peer_addr: string | null;
  peak_height: number | null;
  header_hash: string | null;
}

export class SidecarUnavailableError extends Error {
  constructor(cause: string) {
    super(`sidecar unavailable: ${cause}`);
    this.name = "SidecarUnavailableError";
  }
}

async function fetchJson<T>(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      let body = "";
      try {
        body = await res.text();
      } catch {
        // ignore
      }
      throw new SidecarUnavailableError(`HTTP ${res.status} ${body}`.trim());
    }
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof SidecarUnavailableError) throw e;
    throw new SidecarUnavailableError((e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

function withHexPrefix(s: string): string {
  return s.startsWith("0x") ? s : `0x${s}`;
}

function stripHex(s: string): string {
  return s.startsWith("0x") ? s.slice(2) : s;
}

// CoinRecord.amount is a string for big-int safety. The sidecar emits
// u64 as a JSON number which is precise up to 2^53; we still wrap with
// String() so the shape matches what coin-store expects downstream.
function toCoinRecord(cs: ApiCoinState): CoinRecord {
  return {
    coin_id: stripHex(cs.coin_id),
    parent_coin_info: stripHex(cs.parent_coin_info),
    puzzle_hash: stripHex(cs.puzzle_hash),
    amount: String(cs.amount),
    coinbase: false,
    confirmed_block_index: cs.confirmed_block_index ?? 0,
    spent: cs.spent,
    spent_block_index: cs.spent_block_index ?? 0,
    timestamp: 0,
  };
}

export async function sidecarHealth(
  settings?: SidecarSettings,
): Promise<SidecarHealth> {
  const s = settings ?? (await readSidecarSettings());
  const url = `${s.url.replace(/\/$/, "")}/health`;
  return fetchJson<SidecarHealth>(url, { method: "GET" }, 5_000);
}

/**
 * Asks the sidecar whether it has an active peer + a known peak. Returns
 * `null` if unreachable or not ready.
 */
export async function sidecarReady(
  settings?: SidecarSettings,
): Promise<SidecarHealth | null> {
  try {
    const h = await sidecarHealth(settings);
    if (h.peer_connected && h.peak_height) return h;
    return null;
  } catch {
    return null;
  }
}

export async function scanPuzzleHashes(
  args: {
    puzzle_hashes: string[];
    start_height?: number;
    start_header_hash?: string;
  },
  settings?: SidecarSettings,
): Promise<{ peak_height: number; coin_records: CoinRecord[] }> {
  const s = settings ?? (await readSidecarSettings());
  const url = `${s.url.replace(/\/$/, "")}/scan_puzzle_hashes`;
  const body: Record<string, unknown> = {
    puzzle_hashes: args.puzzle_hashes.map(withHexPrefix),
  };
  if (args.start_height !== undefined && args.start_header_hash !== undefined) {
    // The sidecar requires the pair together — the peer validates the
    // checkpoint to detect reorgs.
    body.start_height = args.start_height;
    body.start_header_hash = withHexPrefix(args.start_header_hash);
  }

  const resp = await fetchJson<ScanResponse>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  // Walk pagination if the peer can't return everything in one round trip.
  let collected = resp.coin_states.map(toCoinRecord);
  let cursor = resp.is_finished ? null : resp.next_start_height;
  let cursorHash = resp.header_hash;
  let safety = 32; // bounded — a wallet's full history fits in one batch normally
  while (cursor !== null && safety-- > 0) {
    const more = await fetchJson<ScanResponse>(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        puzzle_hashes: args.puzzle_hashes.map(withHexPrefix),
        start_height: cursor,
        start_header_hash: withHexPrefix(cursorHash),
      }),
    });
    collected = collected.concat(more.coin_states.map(toCoinRecord));
    cursorHash = more.header_hash;
    cursor = more.is_finished ? null : more.next_start_height;
  }

  return { peak_height: resp.peak_height, coin_records: collected };
}

export async function checkCoinsSpent(
  coinIds: string[],
  settings?: SidecarSettings,
): Promise<{ spent: { coin_id: string; spent_block_index: number }[]; missing: string[] }> {
  const s = settings ?? (await readSidecarSettings());
  const url = `${s.url.replace(/\/$/, "")}/check_coins_spent`;
  const resp = await fetchJson<CheckResponse>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ coin_ids: coinIds.map(withHexPrefix) }),
  });

  const spent: { coin_id: string; spent_block_index: number }[] = [];
  const seen = new Set<string>();
  for (const cs of resp.coin_states) {
    const id = stripHex(cs.coin_id);
    seen.add(id);
    if (cs.spent && cs.spent_block_index !== null) {
      spent.push({ coin_id: id, spent_block_index: cs.spent_block_index });
    }
  }
  const missing = coinIds
    .map(stripHex)
    .filter((id) => !seen.has(id));
  return { spent, missing };
}
