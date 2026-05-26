// Persisted settings for the optional ozone-sidecar peer-sync daemon.
//
// When `enabled` is true and the sidecar is reachable, coin-sync.ts
// routes XCH discovery (scan_puzzle_hashes / check_coins_spent) through
// the local daemon instead of the WASM engine's coinset.org backend.
// CAT and NFT classification still runs through the WASM engine — the
// sidecar only provides raw coin states, the engine does the typing.

const STORAGE_KEY = "settings.sidecar";

export interface SidecarSettings {
  enabled: boolean;
  url: string;
}

const DEFAULTS: SidecarSettings = {
  enabled: false,
  url: "http://127.0.0.1:8765",
};

export async function readSidecarSettings(): Promise<SidecarSettings> {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  const stored = raw[STORAGE_KEY] as Partial<SidecarSettings> | undefined;
  return { ...DEFAULTS, ...(stored ?? {}) };
}

export async function writeSidecarSettings(
  patch: Partial<SidecarSettings>,
): Promise<SidecarSettings> {
  const current = await readSidecarSettings();
  const next: SidecarSettings = { ...current, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}
