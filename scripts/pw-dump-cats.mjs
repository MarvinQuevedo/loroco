// Import the wallet from .env, wait for sync, then dump every CAT the
// wallet tracks (asset id, # unspent coins, total mojos). Use this to
// pick an AIR asset id for follow-up offer/swap smoke tests.
//
//   node --env-file=.env scripts/pw-dump-cats.mjs
//
// Optional: SYNC_TIMEOUT_S=180 to extend the sync wait on a fresh import.

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

const __here = dirname(fileURLToPath(import.meta.url));
const EXT_PATH = resolve(__here, "..", "packages/extension/.output/chrome-mv3");
const USER_DATA = process.env.USER_DATA ?? "/tmp/Loroco-PW-Real";
const OUT_DIR = "/tmp/loroco-pw-dump";
const MNEMONIC = process.env.MNEMONIC;
const PASSWORD = process.env.PASSWORD ?? "marvin";

if (!MNEMONIC) {
  console.error("MNEMONIC env var required (use --env-file=.env)");
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const log = (...a) => console.log("[dump]", ...a);

const ctx = await chromium.launchPersistentContext(USER_DATA, {
  headless: false,
  channel: "chromium",
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1200,900",
  ],
});

try {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
  const extId = sw.url().split("/")[2];
  log("ext id:", extId);
  log("userData:", USER_DATA);

  sw.on("console", (m) => {
    const t = m.text();
    if (t.includes("[loroco/")) console.log(`  SW: ${t}`);
  });

  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForLoadState("domcontentloaded");
  await wait(700);

  const body0 = await popup.locator("body").innerText();
  if (/Import|Create/i.test(body0)) {
    log("importing mnemonic…");
    const importBtn = popup.locator("button", { hasText: /Import mnemonic/i }).first();
    if (await importBtn.isVisible().catch(() => false)) await importBtn.click();
    await wait(400);
    await popup.locator("textarea").first().fill(MNEMONIC);
    await popup.locator("input[type='password']").first().fill(PASSWORD);
    await popup.locator("button", { hasText: /^Continue$/ }).first().click();
    await wait(3500);
  } else {
    const pw = popup.locator("input[type='password']").first();
    if (await pw.isVisible().catch(() => false)) {
      await pw.fill(PASSWORD);
      await popup.locator("button", { hasText: /^Unlock$/ }).first().click();
      await wait(2000);
    }
  }
  log("wallet unlocked");

  async function snapshot() {
    return popup.evaluate(async () => {
      const fp = (await chrome.storage.session.get("activeFingerprint")).activeFingerprint;
      const res = await chrome.runtime.sendMessage({
        from: "popup",
        kind: "get-coin-store",
        fingerprint: fp,
      });
      if (!res?.ok) return null;
      const v = res.value;
      let xchMojos = 0n;
      for (const c of Object.values(v?.coins ?? {})) {
        if (!c.spent) xchMojos += BigInt(c.amount);
      }
      const cats = Object.entries(v?.cats ?? {}).map(([id, c]) => {
        let total = 0n;
        let unspent = 0;
        for (const coin of c.coins ?? []) {
          if (!coin.spent) {
            unspent += 1;
            total += BigInt(coin.amount);
          }
        }
        return { asset_id: id, unspent, total: total.toString() };
      });
      return {
        fp,
        xch_mojos: xchMojos.toString(),
        xch_coins: Object.values(v?.coins ?? {}).filter((c) => !c.spent).length,
        cats,
        nfts: Object.keys(v?.nfts ?? {}).length,
      };
    });
  }

  const SYNC_TIMEOUT_S = Number.parseInt(process.env.SYNC_TIMEOUT_S ?? "180", 10);
  log(`waiting up to ${SYNC_TIMEOUT_S}s for CATs to surface…`);
  let snap = null;
  let lastSummary = "";
  for (let i = 0; i < SYNC_TIMEOUT_S; i += 1) {
    snap = await snapshot();
    if (snap) {
      const summary = `xch=${snap.xch_mojos} xch_coins=${snap.xch_coins} cats=${snap.cats.length} nfts=${snap.nfts}`;
      if (summary !== lastSummary) {
        log(`  t+${i}s ${summary}`);
        lastSummary = summary;
      }
      if (snap.cats.length > 0) break;
    }
    await wait(1000);
  }

  log("=== FINAL ===");
  log(JSON.stringify(snap, null, 2));
  writeFileSync(`${OUT_DIR}/wallet-state.json`, JSON.stringify(snap, null, 2));

  if (snap?.cats?.length) {
    log("\nCATs (asset_id  unspent  total mojos):");
    for (const c of snap.cats) {
      log(`  ${c.asset_id}  ${c.unspent}  ${c.total}`);
    }
  } else {
    log("⚠ no CATs surfaced within timeout — try larger SYNC_TIMEOUT_S or check sync logs");
  }
} catch (err) {
  console.error("[dump] ERROR:", err);
  process.exit(1);
} finally {
  await wait(1000);
  await ctx.close();
}
