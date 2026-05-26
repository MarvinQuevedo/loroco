// Headed Playwright run that opens the popup at the real 380x600 size,
// imports the dev wallet, and screenshots each tab so we can eyeball the
// new bottom-nav layout + compact balance.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";

const EXT_PATH =
  "/Users/marvin/Projects/Ozone/sage-web/ozone-web-extension/packages/extension/.output/chrome-mv3";
const USER_DATA = "/tmp/Loroco-PW-Layout";
const SHOT_DIR = "/tmp/loroco-pw-layout";
const MNEMONIC =
  process.env.MNEMONIC ??
  "charge day cloth frame purpose lake method segment fat gadget regret open better rent visual picnic crater degree budget satoshi shop maple depart host";

mkdirSync(SHOT_DIR, { recursive: true });
const log = (...a) => console.log("[layout]", ...a);

const ctx = await chromium.launchPersistentContext(USER_DATA, {
  headless: false,
  channel: "chromium",
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=900,800",
  ],
});

try {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
  const extId = sw.url().split("/")[2];
  log("ext id:", extId);

  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForLoadState("domcontentloaded");
  await wait(1000);

  if (/Import|Create/i.test(await popup.locator("body").innerText())) {
    log("importing wallet");
    await popup.locator("button", { hasText: /Import mnemonic/i }).first().click();
    await wait(400);
    await popup.locator("textarea").first().fill(MNEMONIC);
    await popup.locator("input[type='password']").first().fill("marvin");
    await popup.locator("button", { hasText: /^Continue$/ }).first().click();
    await wait(3500);
  }
  log("wallet ready");
  await wait(2500);

  const tabs = ["HOME", "SEND", "RECEIVE", "NFTS", "ACTIVITY"];
  for (const t of tabs) {
    const btn = popup.locator(".tabs-bottom button", { hasText: t }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await wait(800);
      const file = `${SHOT_DIR}/tab-${t.toLowerCase()}.png`;
      await popup.screenshot({ path: file });
      log(`shot ${file}`);
    } else {
      log(`tab ${t} not visible`);
    }
  }

  // Settings (gear icon) — verify it still works without showing the
  // balance bar twice.
  const gear = popup.locator(".header-actions .icon-btn").last();
  await gear.click();
  await wait(800);
  await popup.screenshot({ path: `${SHOT_DIR}/tab-settings.png` });
  log("settings shot");
} catch (err) {
  console.error("[layout] ERROR:", err);
  process.exit(1);
} finally {
  await ctx.close();
}
