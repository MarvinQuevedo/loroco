// Open dexie + tibetswap in the running Chromium-for-Testing browser.
// Run AFTER pw-manual.mjs is already up (it needs the same instance).
//
// AIR asset_id (from your wallet snapshot):
//   0x... (the popup shows it as "AIR" with 3 tokens, 1 coin)
//
// What to test:
//   1. dexie.space — open an offer for AIR (XCH→AIR or AIR→XCH), Connect with Loroco
//   2. Click "Take Offer" — Loroco popup pops up for approval
//   3. Approve → take_offer fires
//
// Skip make_offer for now — engine.rs doesn't implement it yet.

import { chromium } from "playwright";

const EXT =
  "/Users/marvin/Projects/Ozone/loroco/packages/extension/.output/chrome-mv3";

// Connect to the SAME Chromium instance already running (via the user-data-dir).
// The browser MUST already be open from pw-manual.mjs.
const ctx = await chromium.launchPersistentContext("/tmp/Loroco-Manual", {
  headless: false,
  channel: "chromium",
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1400,900",
  ],
});

console.log("[dapps] opening dexie.space (filter for AIR token)…");
const dexie = await ctx.newPage();
await dexie.goto("https://dexie.space/offers/cat/0x6593c2d6f7d6f2e3aedb38c0d9d68b30728a5fa3f1a4baeac5cf3169247f3dba");
// note: this is a SAMPLE asset_id — dexie URL pattern for browsing offers of a specific CAT.
// If AIR has a different asset_id, dexie's search will still find it.

await new Promise((r) => setTimeout(r, 1500));

console.log("[dapps] opening v2.tibetswap.io…");
const tibet = await ctx.newPage();
await tibet.goto("https://v2.tibetswap.io/");

console.log("");
console.log("=".repeat(60));
console.log("Two tabs open: dexie + tibetswap.");
console.log("");
console.log("In each tab:");
console.log("  1. Click 'Connect' → choose 'Goby' (that's us, isGoby:true)");
console.log("  2. Loroco popup pops up → Approve");
console.log("  3. Then take an offer / swap (no fee since you're low on XCH)");
console.log("");
console.log("AIR balance from your wallet: 3 tokens (1 coin)");
console.log("XCH balance: 0.000140141088 XCH");
console.log("=".repeat(60));

await new Promise(() => {});
