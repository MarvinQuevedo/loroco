// Content script bridge — runs in ISOLATED world.
// Relays messages between the inpage script (MAIN world via window.postMessage)
// and the extension background (chrome.runtime.sendMessage).

import {
  CONTENT_TARGET,
  type PageEventMessage,
  PAGE_TARGET,
  type PageRequestMessage,
  type PageResponseMessage,
} from "./types.js";

// `chrome` is the standard WebExtension global on Chrome / Edge / current
// Firefox. Content scripts are bundled per-target by WXT; this single source
// works for both manifest builds.
const runtime = chrome.runtime;

/**
 * Hard cap on inbound page → SW message size, in bytes.
 *
 * Why: Chrome MV3 tears down the entire extension context ("Extension
 * context invalidated") when chrome.runtime.sendMessage carries a payload
 * around ~10 MiB, which lets any unconnected page DoS the wallet by
 * blasting a single oversized request. Legitimate calls cap out under a
 * few hundred KB (a signCoinSpends with a deep bundle), so 4 MiB is
 * generous slack with comfortable margin to the death zone.
 *
 * This is one of two layers — the SW also enforces the same cap so a
 * dApp that bypasses the inpage script (raw postMessage) still can't
 * push oversized payloads through.
 *
 * Surfaced as CHIP-0002 4029 (LimitExceeded).
 */
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

function approxByteSize(data: PageRequestMessage): number {
  // Fast path: avoid a full JSON.stringify of huge params just to measure.
  // Any string field on the payload (the typical attack vector — message,
  // spendBundle hex) gets size-checked directly. Everything else falls
  // back to JSON.stringify which is fine for small structured params.
  const params = data.params as unknown;
  if (typeof params === "string") return params.length;
  try {
    return JSON.stringify(params ?? null).length;
  } catch {
    // Cyclic params or BigInt — treat as oversized; the SW couldn't
    // serialise them anyway.
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Install the bridge.
 *
 * @returns cleanup function (removes listeners).
 */
export function installContentBridge(): () => void {
  const onPageMessage = async (ev: MessageEvent) => {
    if (ev.source !== window) return;
    const data = ev.data as PageRequestMessage | undefined;
    if (!data || data.target !== CONTENT_TARGET) return;

    const sizeBytes = approxByteSize(data);
    if (sizeBytes > MAX_REQUEST_BYTES) {
      const reply: PageResponseMessage = {
        target: PAGE_TARGET,
        id: data.id,
        error: {
          code: 4029,
          message: `Request payload too large: ${sizeBytes} bytes exceeds the ${MAX_REQUEST_BYTES}-byte cap. ` +
            `Loroco rejects oversized messages before forwarding to the wallet to prevent extension-context DoS.`,
        },
      };
      window.postMessage(reply, window.location.origin);
      return;
    }

    try {
      const response = await runtime.sendMessage({
        from: "content",
        origin: data.origin,
        id: data.id,
        method: data.method,
        params: data.params,
      });
      const reply: PageResponseMessage = {
        target: PAGE_TARGET,
        id: data.id,
        ...(response?.error ? { error: response.error } : { result: response?.result }),
      };
      window.postMessage(reply, window.location.origin);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const reply: PageResponseMessage = {
        target: PAGE_TARGET,
        id: data.id,
        error: { code: -32603, message },
      };
      window.postMessage(reply, window.location.origin);
    }
  };

  const onRuntimeMessage = (msg: unknown) => {
    // Background pushes events (chainChanged, accountChanged) here.
    if (
      typeof msg === "object" &&
      msg !== null &&
      (msg as { kind?: string }).kind === "event"
    ) {
      const event = msg as { event: PageEventMessage["event"]; payload: unknown };
      const out: PageEventMessage = {
        target: PAGE_TARGET,
        event: event.event,
        payload: event.payload,
      };
      window.postMessage(out, window.location.origin);
    }
  };

  window.addEventListener("message", onPageMessage);
  runtime.onMessage.addListener(onRuntimeMessage);

  return () => {
    window.removeEventListener("message", onPageMessage);
    runtime.onMessage.removeListener(onRuntimeMessage);
  };
}
