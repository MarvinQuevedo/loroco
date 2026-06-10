// Browser notifications for wallet activity.
//
// Surfaces the mempool/confirmation transitions the watcher already detects:
//   • incoming payment pending / confirmed
//   • a coin spent by ANOTHER device on this seed (external send)
//   • a transaction confirmed
//
// Every notification is gated by the user's NotifSettings and de-duplicated by
// a persisted `${kind}:${txId}` key, so a service-worker restart (which re-runs
// the mempool reconciliation over the same items) never re-fires an alert the
// user already saw.

import { readNotifSettings, type NotifSettings } from "./notif-settings.js";

export type NotifKind =
  | "incoming-pending"
  | "incoming-confirmed"
  | "outgoing-external"
  | "outgoing-confirmed";

const SETTING_FOR_KIND: Record<NotifKind, keyof NotifSettings> = {
  "incoming-pending": "incomingPending",
  "incoming-confirmed": "incomingConfirmed",
  "outgoing-external": "outgoingExternal",
  "outgoing-confirmed": "outgoingConfirmed",
};

// ── Amount formatting (background has no access to the popup helpers) ───────
export function fmtXchMojos(mojos: string | bigint): string {
  try {
    const m = typeof mojos === "bigint" ? mojos : BigInt(mojos);
    const neg = m < 0n;
    const a = neg ? -m : m;
    const scale = 1_000_000_000_000n;
    const whole = a / scale;
    const frac = (a % scale).toString().padStart(12, "0").replace(/0+$/, "");
    return `${neg ? "-" : ""}${frac ? `${whole}.${frac}` : whole} XCH`;
  } catch {
    return `${mojos} mojos`;
  }
}

export function fmtCatMojos(mojos: string | bigint, decimals = 3, symbol?: string): string {
  try {
    const m = typeof mojos === "bigint" ? mojos : BigInt(mojos);
    const scale = 10n ** BigInt(decimals);
    const whole = m / scale;
    const frac = (m % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
    return `${frac ? `${whole}.${frac}` : whole} ${symbol || "CAT"}`;
  } catch {
    return `${mojos} ${symbol || "CAT"}`;
  }
}

// ── Dedup store ─────────────────────────────────────────────────────────────
const SEEN_KEY = "notif.seen";
const SEEN_MAX = 300;
const SEEN_TTL_MS = 24 * 60 * 60_000;

interface SeenEntry {
  key: string;
  at: number;
}

async function alreadyNotified(key: string): Promise<boolean> {
  const now = Date.now();
  const raw = (await chrome.storage.local.get(SEEN_KEY))[SEEN_KEY] as SeenEntry[] | undefined;
  const list = (raw ?? []).filter((e) => now - e.at < SEEN_TTL_MS);
  if (list.some((e) => e.key === key)) {
    // Refresh storage if we pruned expired entries, but report "seen".
    if ((raw?.length ?? 0) !== list.length) {
      await chrome.storage.local.set({ [SEEN_KEY]: list });
    }
    return true;
  }
  list.push({ key, at: now });
  // Keep the newest SEEN_MAX entries.
  const trimmed = list.slice(-SEEN_MAX);
  await chrome.storage.local.set({ [SEEN_KEY]: trimmed });
  return false;
}

// ── Public API ──────────────────────────────────────────────────────────────
export interface NotifyOpts {
  kind: NotifKind;
  /** Stable id used for dedup — usually the tx_id. */
  dedupId: string;
  title: string;
  message: string;
}

/**
 * Show a notification if (a) the master switch + per-kind toggle are on and
 * (b) we haven't already shown this `${kind}:${dedupId}`. Best-effort: any
 * chrome.notifications failure is swallowed so a notification never breaks the
 * sync/mempool path it's called from.
 */
export async function notify(opts: NotifyOpts): Promise<void> {
  let settings: NotifSettings;
  try {
    settings = await readNotifSettings();
  } catch {
    return;
  }
  if (!settings.enabled || !settings[SETTING_FOR_KIND[opts.kind]]) return;

  const key = `${opts.kind}:${opts.dedupId}`;
  if (await alreadyNotified(key)) return;

  try {
    chrome.notifications.create(`loroco:${key}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon/128.png"),
      title: opts.title,
      message: opts.message,
      priority: 1,
    });
  } catch {
    // notifications API unavailable (rare) — ignore.
  }
}

/**
 * Register the notification click handler ONCE. Clicking a Loroco notification
 * opens the wallet popup (best-effort — openPopup needs a focused window, so we
 * fall back to a popup tab) and clears the notification.
 */
let initialized = false;
export function initNotifications(): void {
  if (initialized) return;
  initialized = true;
  if (typeof chrome === "undefined" || !chrome.notifications?.onClicked) return;
  chrome.notifications.onClicked.addListener((id) => {
    if (!id.startsWith("loroco:")) return;
    void (async () => {
      try {
        await chrome.action.openPopup();
      } catch {
        try {
          await chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
        } catch {
          /* give up silently */
        }
      }
      try {
        chrome.notifications.clear(id);
      } catch {
        /* ignore */
      }
    })();
  });
}
