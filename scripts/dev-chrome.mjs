// Launches a persistent Chrome with Loroco loaded so the user can test
// manually. Opens dexie + tibet + the extension popup as a starting point.
// Stays alive until the user closes Chrome (or hits Ctrl-C in the terminal).
//
// Run:
//   node scripts/dev-chrome.mjs           # opens dexie + tibet
//   PROFILE=/tmp/Loroco-Manual node scripts/dev-chrome.mjs
//
// The profile directory persists between runs so wallet + connections
// survive across launches. Delete it to start fresh.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const EXT_PATH =
  "/Users/marvin/Projects/Ozone/sage-web/ozone-web-extension/packages/extension/.output/chrome-mv3";

const USER_DATA = process.env.PROFILE ?? "/Users/marvin/Library/Application Support/LorocoManual";

mkdirSync(USER_DATA, { recursive: true });

const log = (...a) => console.log("[loroco]", ...a);

log("profile dir:", USER_DATA);
log("loading extension from:", EXT_PATH);

const ctx = await chromium.launchPersistentContext(USER_DATA, {
  headless: false,
  channel: "chromium",
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-position=0,0",
    "--window-size=1400,900",
  ],
  viewport: null,
});

let sw = ctx.serviceWorkers()[0];
if (!sw) {
  log("waiting for service worker…");
  sw = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
}
const extId = sw.url().split("/")[2];
log("extension id:", extId);
log("popup url:", `chrome-extension://${extId}/popup.html`);

// Open a couple of dApps + the popup so the user has them ready.
const home = ctx.pages()[0] ?? (await ctx.newPage());
await home.goto("https://dexie.space").catch(() => {});

const tibet = await ctx.newPage();
await tibet.goto("https://v2.tibetswap.io").catch(() => {});

const popup = await ctx.newPage();
await popup.setViewportSize({ width: 380, height: 680 });
await popup.goto(`chrome-extension://${extId}/popup.html`).catch(() => {});

log("");
log("Loroco is running. The Chrome window has:");
log("  • Tab 1 — dexie.space");
log("  • Tab 2 — v2.tibetswap.io");
log("  • Tab 3 — popup at 380×680");
log("");
log("Close the Chrome window when you're done. The profile at");
log(`  ${USER_DATA}`);
log("will persist your wallet + connections for the next run.");
log("");
log("Press Ctrl-C in this terminal to kill Chrome.");

// Keep the script alive until Chrome closes or the user hits Ctrl-C.
await new Promise((resolve) => {
  ctx.on("close", resolve);
  process.on("SIGINT", () => {
    log("received SIGINT, closing Chrome");
    void ctx.close().finally(resolve);
  });
});
log("done.");
