// Quick state probe — launches a tiny Chromium against the saved profile
// and dumps the current sync state (totals, telemetry, NFT/CAT counts).
// Run AFTER the bench so chrome.storage.local has accumulated state.

import { chromium } from "playwright";

const EXT_PATH =
  "/Users/marvin/Projects/Ozone/loroco/packages/extension/.output/chrome-mv3";
const USER_DATA = "/tmp/Loroco-Manual";

const ctx = await chromium.launchPersistentContext(USER_DATA, {
  headless: true,
  channel: "chromium",
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15_000 });
const extId = sw.url().split("/")[2];

const popup = await ctx.newPage();
await popup.goto(`chrome-extension://${extId}/popup.html`);
await popup.waitForLoadState("domcontentloaded");
await new Promise((r) => setTimeout(r, 1500));

const state = await popup.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  const session = await chrome.storage.session.get("coinSyncTelemetry");
  const coinKeys = Object.keys(all).filter((k) => k.startsWith("coins."));
  const out = {
    coinKeys,
    telemetry: session.coinSyncTelemetry ?? null,
  };
  for (const k of coinKeys) {
    const s = all[k];
    out[k] = {
      last_synced_height: s.last_synced_height,
      total_coins: Object.keys(s.coins ?? {}).length,
      unspent_coins: Object.values(s.coins ?? {}).filter((c) => !c.spent).length,
      cats: Object.keys(s.cats ?? {}).length,
      cats_synced_at: s.cats_synced_at
        ? new Date(s.cats_synced_at).toISOString()
        : null,
      nfts: Object.keys(s.nfts ?? {}).length,
      unspent_nfts: Object.values(s.nfts ?? {}).filter((n) => !n.spent).length,
      nfts_synced_at: s.nfts_synced_at
        ? new Date(s.nfts_synced_at).toISOString()
        : null,
      pending_nfts: Object.keys(s.pending_nft_candidates ?? {}).length,
      pending_cats: Object.keys(s.pending_cat_candidates ?? {}).length,
      nft_hint_cursors: Object.keys(s.nft_hint_heights ?? {}).length,
      cat_hint_cursors: Object.keys(s.cat_hint_heights ?? {}).length,
    };
  }
  return out;
});

console.log(JSON.stringify(state, null, 2));
await ctx.close();
