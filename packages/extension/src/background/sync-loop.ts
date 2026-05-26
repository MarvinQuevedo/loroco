// Sync loop driven by chrome.alarms.
//
// Every 30 s we call `engine.request("sync_tick")` and stash the latest
// blockchain snapshot in chrome.storage.session so the popup can render it
// without round-tripping through the SW on every poll.

import { callEngine } from "./engine.js";

const STATE_KEY = "syncState";

export interface SyncState {
  peak_height: number;
  peak_header_hash: string;
  synced: boolean;
  sync_mode: boolean;
  mempool_size: number;
  mempool_cost: number;
  difficulty: number;
  ticked_at: number;
  error?: string;
}

let running = false;

export async function startSyncLoop(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const snapshot = await callEngine<Omit<SyncState, "ticked_at">>("sync_tick", {
      endpoint: "mainnet",
    });
    const state: SyncState = { ...snapshot, ticked_at: Date.now() };
    await chrome.storage.session.set({ [STATE_KEY]: state });
  } catch (err) {
    const e = err as Error & { code?: number };
    if (e.code === 4999) return; // NotImplemented — expected for some methods
    const current = (await chrome.storage.session.get(STATE_KEY))[STATE_KEY] as
      | SyncState
      | undefined;
    await chrome.storage.session.set({
      [STATE_KEY]: {
        ...(current ?? {
          peak_height: 0,
          peak_header_hash: "",
          synced: false,
          sync_mode: false,
          mempool_size: 0,
          mempool_cost: 0,
          difficulty: 0,
        }),
        ticked_at: Date.now(),
        error: e.message,
      } satisfies SyncState,
    });
  } finally {
    running = false;
  }
}

export async function readSyncState(): Promise<SyncState | null> {
  const data = await chrome.storage.session.get(STATE_KEY);
  return (data[STATE_KEY] as SyncState | undefined) ?? null;
}
