// Broadcast Goby/CHIP-0002 events to every connected dApp tab.
//
// The content-bridge in goby-provider/src/content-bridge.ts already listens
// for chrome.runtime.onMessage events with `{kind: "event", event, payload}`
// and forwards them to the inpage via window.postMessage. The inpage in turn
// dispatches to listeners registered with provider.on(event, …).
//
// Without these broadcasts, dApps cache the balance/address they observed at
// connect-time and never re-fetch — which manifests as "0 available" in
// dexie even after the wallet finishes syncing.
//
// We only broadcast to tabs whose origin has an active connection (see
// permissions.ts); broadcasting to every tab would be a privacy leak.

import type { ChiaEvent } from "@ozone/goby-provider/types";
import { isConnected } from "./permissions.js";

/** Throttle map so we don't fire the same event 100×/second mid-sync. */
const lastEmit = new Map<string, number>();
const MIN_INTERVAL_MS = 800;

interface EventEnvelope {
  kind: "event";
  event: ChiaEvent;
  payload: unknown;
}

/**
 * Push an event to every tab whose origin has an active connection.
 *
 * Uses chrome.tabs.query → chrome.tabs.sendMessage. The content-bridge
 * silently ignores any tab where no inpage is listening (e.g. opaque
 * iframes), so over-broadcasting is safe but wastes a few messages.
 */
export interface BroadcastResult {
  event: ChiaEvent;
  delivered: number;
  scanned: number;
  not_connected: number;
  errors: Array<{ tab_id: number; origin: string; error: string }>;
  throttled: boolean;
}

export async function broadcastEvent(
  event: ChiaEvent,
  payload: unknown,
): Promise<BroadcastResult> {
  const result: BroadcastResult = {
    event,
    delivered: 0,
    scanned: 0,
    not_connected: 0,
    errors: [],
    throttled: false,
  };

  const throttleKey = `${event}`;
  const now = Date.now();
  const prev = lastEmit.get(throttleKey) ?? 0;
  if (now - prev < MIN_INTERVAL_MS) {
    result.throttled = true;
    return result;
  }
  lastEmit.set(throttleKey, now);

  const envelope: EventEnvelope = { kind: "event", event, payload };

  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return result;
  }

  for (const tab of tabs) {
    if (typeof tab.id !== "number" || !tab.url) continue;
    result.scanned += 1;
    let origin: string;
    try {
      origin = new URL(tab.url).origin;
    } catch {
      continue;
    }
    let connected = false;
    try {
      connected = await isConnected(origin);
    } catch (e) {
      result.errors.push({ tab_id: tab.id, origin, error: `isConnected: ${String(e)}` });
      continue;
    }
    if (!connected) {
      result.not_connected += 1;
      continue;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, envelope);
      result.delivered += 1;
    } catch (e) {
      result.errors.push({ tab_id: tab.id, origin, error: String(e) });
    }
  }
  if (result.delivered > 0) {
    console.log(
      `[loroco/event] ${event} → ${result.delivered} tab(s)`,
      typeof payload === "object" ? payload : `payload=${String(payload)}`,
    );
  }
  return result;
}
