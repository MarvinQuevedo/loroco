// Background service worker — owns the wallet, brokers all RPC.
//
// Lifecycle: MV3 SWs are killed after ~30s idle. We re-init lazily on demand
// and keep the encrypted derived key in chrome.storage.session so unlock survives
// SW restarts (but not browser close).

import { defineBackground } from "wxt/utils/define-background";
import { Errors } from "@ozone/goby-provider/errors";
import type { ChiaMethod } from "@ozone/goby-provider/types";
import { handleApprovalMessage, isApprovalMessage } from "../src/background/approval";
import { tickCoinSync } from "../src/background/coin-sync";
import { setActiveWallet } from "../src/background/engine";
import { ensureSocket as ensureMempoolSocket, tickMempoolWatch } from "../src/background/mempool-watch";
import { initNotifications } from "../src/background/notifications";
import { handlePopupMessage, isPopupMessage } from "../src/background/popup-rpc";
import { canonicalizeMethod, handleRpc } from "../src/background/rpc-router";
import { startSyncLoop } from "../src/background/sync-loop";
import { ensurePermissions, purgeExpiredConnections, requireConnected } from "../src/background/permissions";

export default defineBackground(() => {
  console.log("[Loroco] background starting");

  // Register the notification click handler (opens the popup). Idempotent.
  initNotifications();

  // Silent SW killers: an uncaught error inside an async chain (e.g. a
  // wasm-bindgen JsValue rejection that isn't caught) terminates the SW
  // without any visible log. Wire up self.onerror + onunhandledrejection
  // so we get a console.error trail BEFORE the SW dies. Critical for
  // diagnosing sync-time bugs.
  self.addEventListener("error", (e) => {
    console.error("[Loroco/onerror]", e.message, e.filename, e.lineno, e.error);
  });
  self.addEventListener("unhandledrejection", (e) => {
    const r = e.reason as unknown;
    const msg =
      r instanceof Error ? `${r.name}: ${r.message}\n${r.stack ?? ""}`
      : typeof r === "string" ? r
      : JSON.stringify(r);
    console.error("[Loroco/unhandledrejection]", msg.slice(0, 500));
  });

  // Restore the active wallet from session storage (survives SW death but not
  // browser close). Setting walletId triggers IdbStorage open on the next
  // engine call.
  void chrome.storage.session.get("walletId").then((data) => {
    if (typeof data.walletId === "string" && data.walletId.length > 0) {
      setActiveWallet(data.walletId);
      console.log("[Loroco] restored wallet:", data.walletId);
    }
  });

  // Periodic sync triggers + SW keep-alive.
  //
  // MV3 SW idle timeout is ~30s. `chrome.alarms` clamps periodInMinutes to a
  // 30s minimum in some Chrome builds, which is exactly the idle threshold —
  // a race we can't win with a periodic alarm. Instead we use the canonical
  // recursive pattern: one-shot delay alarms, re-armed from inside the
  // handler. Each fire awaits a chrome.* API which bumps SW lifetime by
  // ~30s, then schedules the next fire at 20s — comfortably under the cap.
  chrome.alarms.create("sync", { periodInMinutes: 0.5 });
  chrome.alarms.create("coin-sync", { periodInMinutes: 0.5 });
  chrome.alarms.create("mempool-watch", { periodInMinutes: 0.5 });
  chrome.alarms.create("keepalive", { delayInMinutes: 20 / 60 });
  // #4 — reclaim connections whose 7-day sliding window has elapsed. The
  // lazy purge in ensurePermissions only fires when the dApp calls again;
  // an abandoned site would otherwise linger in the Connected-sites list
  // forever. Half-hourly is plenty for a day-scale TTL.
  chrome.alarms.create("purge-connections", { periodInMinutes: 30 });

  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === "sync") {
      void startSyncLoop();
    } else if (alarm.name === "coin-sync") {
      void tickCoinSync();
    } else if (alarm.name === "mempool-watch") {
      void tickMempoolWatch().catch(() => {});
    } else if (alarm.name === "purge-connections") {
      void purgeExpiredConnections()
        .then((n) => {
          if (n > 0) console.log(`[Loroco] purged ${n} expired connection(s)`);
        })
        .catch(() => {});
    } else if (alarm.name === "keepalive") {
      // Re-arm FIRST so a future panic in getPlatformInfo can't break the
      // chain. Then await the chrome.* call — the await is what extends
      // the SW lifetime by another ~30s.
      chrome.alarms.create("keepalive", { delayInMinutes: 20 / 60 });
      try {
        await chrome.runtime.getPlatformInfo();
      } catch {}
      console.log("[Loroco/keepalive]", new Date().toISOString());
    }
  });

  chrome.runtime.onInstalled.addListener(() => {
    console.log("[Loroco] installed");
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // ── Approval popup → SW ────────────────────────────────────────────
    if (isApprovalMessage(msg)) {
      void handleApprovalMessage(msg).then(sendResponse);
      return true;
    }

    // ── Popup → SW ─────────────────────────────────────────────────────
    if (isPopupMessage(msg)) {
      void handlePopupMessage(msg).then(sendResponse);
      return true;
    }

    // ── dApp content script → SW ───────────────────────────────────────
    if (!msg || msg.from !== "content") return false;
    const origin = sender.origin ?? msg.origin;
    if (!origin) {
      sendResponse({ error: Errors.invalidParams("Missing origin").toJSON() });
      return true;
    }

    // Defense-in-depth size cap. The content bridge enforces the same
    // limit (packages/goby-provider/src/content-bridge.ts) but a dApp
    // that bypasses the inpage script or that targets an alternate WXT
    // build could still reach here with an oversized payload, which
    // risks Chrome tearing down the extension context. We measure
    // `params` size directly so the common attack (one giant string
    // field) is O(1).
    const MAX_PARAMS_BYTES = 4 * 1024 * 1024;
    let paramsSize = 0;
    if (typeof msg.params === "string") {
      paramsSize = msg.params.length;
    } else if (msg.params != null) {
      try {
        paramsSize = JSON.stringify(msg.params).length;
      } catch {
        paramsSize = Number.POSITIVE_INFINITY;
      }
    }
    if (paramsSize > MAX_PARAMS_BYTES) {
      sendResponse({
        error: {
          code: 4029,
          message: `Request payload too large: ${paramsSize} bytes exceeds the ${MAX_PARAMS_BYTES}-byte cap.`,
        },
      });
      return true;
    }

    (async () => {
      try {
        // Normalise alias method names (chia_*, chip0002_*, snake_case) down
        // to the CHIP-0002 canonical surface before any gating runs. All
        // alias namespaces are baseline — the `legacyGoby` compat setting
        // only controls whether window.chia is shadow-injected (handled
        // in the content script), not which method names we honour here.
        // We keep the *original* name around so handlers with WC2-vs-Goby
        // shape differences (chia_getNfts, chia_send, chia_cancelOffer, …)
        // can branch on what the dApp actually asked for.
        const originalMethod = String(msg.method);
        const method = canonicalizeMethod(originalMethod) as ChiaMethod;
        // Trace every dApp message at the entry point so debug captures even
        // the calls that fail at the gating layer (unauthorized / not connected).
        // Useful when a dApp shows stale state — we can correlate its UI with
        // the exact sequence of calls.
        console.log(
          `[loroco/dapp-in] origin=${origin} method=${originalMethod}${
            method !== originalMethod ? ` (alias→${method})` : ""
          }`,
        );
        if (method !== "connect") {
          requireConnected(origin);
        }
        await ensurePermissions(origin, method);
        const result = await handleRpc(origin, method, msg.params, originalMethod);
        sendResponse({ result });
      } catch (err) {
        const e = err as Error & { code?: number; data?: unknown };
        console.log(
          `[loroco/dapp-err] origin=${origin} method=${String(msg.method)} →`,
          `code=${e.code ?? -32603} msg=${(e.message ?? String(err)).slice(0, 200)}`,
        );
        sendResponse({
          error: {
            code: e.code ?? -32603,
            message: e.message ?? String(err),
            data: e.data,
          },
        });
      }
    })();
    return true; // async response
  });

  // Keep-alive port. When the popup is open it opens a long-lived port to
  // us; Chrome won't kill the SW while any port is connected. Without this,
  // Chrome's MV3 idle timeout (~30s) kills the SW mid-CAT-scan on wallets
  // with deep history, restarting the loop from scratch every tick.
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "loroco-keepalive") return;
    port.onMessage.addListener(() => {
      // No-op — every message we receive bumps Chrome's lifetime timer.
      // The popup sends a heartbeat every 20s.
    });
    port.onDisconnect.addListener(() => {
      // Port closed (popup closed or crashed). Nothing to clean up.
    });
  });

  ensureMempoolSocket();
});
