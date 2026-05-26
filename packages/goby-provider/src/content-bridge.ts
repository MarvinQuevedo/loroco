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
 * Install the bridge.
 *
 * @returns cleanup function (removes listeners).
 */
export function installContentBridge(): () => void {
  const onPageMessage = async (ev: MessageEvent) => {
    if (ev.source !== window) return;
    const data = ev.data as PageRequestMessage | undefined;
    if (!data || data.target !== CONTENT_TARGET) return;

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
