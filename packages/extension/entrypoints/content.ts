// Content script — runs in ISOLATED world. Injects inpage.js into MAIN world
// and bridges window.postMessage ↔ chrome.runtime.sendMessage.

import { defineContentScript } from "wxt/utils/define-content-script";
import { installContentBridge } from "@ozone/goby-provider";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  world: "ISOLATED",
  main() {
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
