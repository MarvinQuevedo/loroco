// Thin typed transport to the injected Loroco provider.
//
// window.loroco is ALWAYS present when the extension is installed; window.chia
// and window.ozone only exist under the Goby-compat setting (see inpage.ts).
// So we prefer loroco, then fall back to the compat slots.

import type {
  ChiaMethod,
  ChiaMethodMap,
  ChiaWallet,
} from "@ozone/goby-provider/types";

export function detectProvider(): ChiaWallet | null {
  if (typeof window === "undefined") return null;
  return window.loroco ?? window.chia ?? window.ozone ?? null;
}

export async function call<M extends ChiaMethod>(
  method: M,
  params?: ChiaMethodMap[M]["params"],
): Promise<ChiaMethodMap[M]["result"]> {
  const p = detectProvider();
  if (!p) throw new Error("Loroco wallet not detected");
  return p.request({ method, params } as { method: M; params?: ChiaMethodMap[M]["params"] });
}

// ── Error helpers ─────────────────────────────────────────────────────────
// The provider rejects with an Error carrying numeric `code` + `message`.

export interface ProviderError extends Error {
  code?: number;
  data?: unknown;
}

export const ERROR_CODES: Record<number, string> = {
  4000: "Invalid parameters",
  4001: "Unauthorized — connect first",
  4002: "Rejected in the wallet",
  4004: "Method not available to dApps (wallet-only)",
  4029: "Payload too large (over 4 MiB)",
  4900: "Not connected",
};

export function errCode(e: unknown): number | undefined {
  return (e as ProviderError | null)?.code;
}

/** Human-readable message for a thrown provider error. */
export function describeError(e: unknown): string {
  const code = errCode(e);
  const base = (e as ProviderError | null)?.message ?? String(e);
  if (code && ERROR_CODES[code]) return `${ERROR_CODES[code]} (${code})`;
  return base;
}
