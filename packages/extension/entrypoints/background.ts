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
import { handlePopupMessage, isPopupMessage } from "../src/background/popup-rpc";
import { handleRpc } from "../src/background/rpc-router";
import { startSyncLoop } from "../src/background/sync-loop";
import { ensurePermissions, requireConnected } from "../src/background/permissions";

export default defineBackground(() => {
  console.log("[Loroco] background starting");

  // Restore the active wallet from session storage (survives SW death but not
  // browser close). Setting walletId triggers IdbStorage open on the next
  // engine call.
  void chrome.storage.session.get("walletId").then((data) => {
    if (typeof data.walletId === "string" && data.walletId.length > 0) {
      setActiveWallet(data.walletId);
      console.log("[Loroco] restored wallet:", data.walletId);
    }
  });

  // Keep-alive + periodic sync trigger
  chrome.alarms.create("sync", { periodInMinutes: 0.5 });
  chrome.alarms.create("coin-sync", { periodInMinutes: 0.5 });
  chrome.alarms.create("keepalive", { periodInMinutes: 0.25 });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "sync") {
      void startSyncLoop();
    } else if (alarm.name === "coin-sync") {
      void tickCoinSync();
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

    (async () => {
      try {
        if (msg.method !== "connect") {
          requireConnected(origin);
        }
        await ensurePermissions(origin, msg.method as ChiaMethod);
        const result = await handleRpc(origin, msg.method as ChiaMethod, msg.params);
        sendResponse({ result });
      } catch (err) {
        const e = err as Error & { code?: number; data?: unknown };
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
});
