// Persisted dApp-compatibility settings.
//
// `legacyGoby` controls ONLY whether Loroco impersonates Goby's window slot:
//   • true  → inject window.chia (and window.ozone alias) so Goby-only
//             dApps that probe window.chia find Loroco.
//   • false → only window.loroco is defined. Real Goby (if installed)
//             keeps window.chia without conflict.
//
// The method-name surface is independent of this setting: chia_*,
// chip0002_* and snake_case aliases are ALWAYS accepted by the RPC
// router via window.loroco.request(). The setting governs the global,
// not the methods.
//
// Default per build:
//   • dev / WXT serve → true  (so the pw-* test scripts that look for
//     window.chia keep working without flipping the toggle manually).
//   • production build → false (don't ambush Goby users — they still
//     can call our methods through window.loroco if they choose).
//
// User can override in Settings → Advanced.

const STORAGE_KEY = "settings.compat";

export interface CompatSettings {
  legacyGoby: boolean;
}

export function getCompatDefaults(): CompatSettings {
  // Vite (WXT) inlines import.meta.env.DEV at build time.
  const env = (import.meta as { env?: { DEV?: boolean } }).env;
  return { legacyGoby: env?.DEV === true };
}

export async function readCompatSettings(): Promise<CompatSettings> {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  const stored = raw[STORAGE_KEY] as Partial<CompatSettings> | undefined;
  return { ...getCompatDefaults(), ...(stored ?? {}) };
}

export async function writeCompatSettings(
  patch: Partial<CompatSettings>,
): Promise<CompatSettings> {
  const current = await readCompatSettings();
  const next: CompatSettings = { ...current, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}
