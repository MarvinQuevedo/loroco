// Content script — runs in ISOLATED world. Injects inpage.js into MAIN world
// and bridges window.postMessage ↔ chrome.runtime.sendMessage.

import { defineContentScript } from "wxt/utils/define-content-script";
import { installContentBridge } from "@ozone/goby-provider";
import { readCompatSettings } from "../src/background/compat-settings";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  world: "ISOLATED",
  async main() {
    // Read the Goby-compat preference BEFORE injecting inpage.js so the MAIN
    // world script knows which window globals to claim. The setting lives in
    // chrome.storage.local, which is available in content scripts. We hang
    // it off <html>.dataset (shared DOM) — the inpage script reads it back
    // before defining window.chia. Awaiting one microtask before injection
    // is fine: the page itself hasn't parsed any script yet at document_start.
    let legacyGoby = false;
    try {
      const compat = await readCompatSettings();
      legacyGoby = compat.legacyGoby;
    } catch {
      // chrome.storage failure — keep the safe default (no window.chia).
    }
    document.documentElement.dataset.lorocoLegacyGoby = legacyGoby ? "1" : "0";

    // Inject inpage.js into MAIN world via <script src=...>.
    const url = chrome.runtime.getURL("/inpage.js");
    const script = document.createElement("script");
    script.src = url;
    script.async = false;
    (document.head ?? document.documentElement).prepend(script);
    script.onload = () => script.remove();

    installContentBridge();
  },
});
