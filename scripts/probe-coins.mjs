import { chromium } from "playwright";
const EXT = "/Users/marvin/Projects/Ozone/loroco/packages/extension/.output/chrome-mv3";
const ctx = await chromium.launchPersistentContext("/tmp/Loroco-Manual", {
  headless: true, channel: "chromium",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run"]
});
let sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker", {timeout:15000});
const extId = sw.url().split("/")[2];
const popup = await ctx.newPage();
await popup.goto(`chrome-extension://${extId}/popup.html`);
await popup.waitForLoadState("domcontentloaded");
await new Promise(r => setTimeout(r, 1000));
const result = await popup.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  const k = Object.keys(all).find(x => x.startsWith("coins."));
  const s = all[k];
  let totalMojos = 0n;
  const byPh = {};
  for (const c of Object.values(s.coins ?? {})) {
    if (!c.spent) {
      totalMojos += BigInt(c.amount);
      byPh[c.puzzle_hash] = (byPh[c.puzzle_hash] ?? 0) + 1;
    }
  }
  return {
    total_unspent_mojos: totalMojos.toString(),
    total_unspent_xch: (Number(totalMojos) / 1e12).toString(),
    unspent_count: Object.values(s.coins ?? {}).filter(c => !c.spent).length,
    distinct_ph_count: Object.keys(byPh).length,
    first_few_phs: Object.entries(byPh).slice(0,5),
  };
});
console.log(JSON.stringify(result, null, 2));
await ctx.close();
