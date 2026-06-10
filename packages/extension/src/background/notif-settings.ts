// Persisted notification preferences.
//
// A master switch plus per-event toggles. The master off-switch short-circuits
// everything; the per-event flags let a user keep, say, "received" alerts but
// silence the noisier "broadcast" ones. Stored in chrome.storage.local under
// `settings.notifications` so it survives SW restarts and is readable from both
// the background and the popup.

const STORAGE_KEY = "settings.notifications";

export interface NotifSettings {
  /** Master switch. When false, nothing is ever shown. */
  enabled: boolean;
  /** A payment to one of our addresses appeared in the mempool (pending). */
  incomingPending: boolean;
  /** That payment (or any new receive) confirmed in a block. */
  incomingConfirmed: boolean;
  /** One of our coins was spent by a DIFFERENT device sharing this seed. */
  outgoingExternal: boolean;
  /** A transaction we (or another device) sent confirmed on-chain. */
  outgoingConfirmed: boolean;
}

export function getNotifDefaults(): NotifSettings {
  return {
    enabled: true,
    incomingPending: true,
    incomingConfirmed: true,
    outgoingExternal: true,
    outgoingConfirmed: true,
  };
}

export async function readNotifSettings(): Promise<NotifSettings> {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  const stored = raw[STORAGE_KEY] as Partial<NotifSettings> | undefined;
  return { ...getNotifDefaults(), ...(stored ?? {}) };
}

export async function writeNotifSettings(
  patch: Partial<NotifSettings>,
): Promise<NotifSettings> {
  const current = await readNotifSettings();
  const next: NotifSettings = { ...current, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}
