// Quick visual probe — open popup, import wallet (if needed), screenshot each
// tab so we can eyeball the new terra/green/teal palette.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";

const EXT_PATH =
  "/Users/marvin/Projects/Ozone/loroco/packages/extension/.output/chrome-mv3";
const USER_DATA = process.env.USER_DATA ?? "/tmp/Loroco-PW-Shared";
const SHOT_DIR = "/tmp/loroco-palette-shots";
const MNEMONIC =
  process.env.MNEMONIC ??
  "charge day cloth frame purpose lake method segment fat gadget regret open better rent visual picnic crater degree budget satoshi shop maple depart host";

mkdirSync(SHOT_DIR, { recursive: true });
const log = (...a) => console.log("[palette]", ...a);

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
  await wait(1500);

  const text = await popup.locator("body").innerText();
  if (/Import|Create/i.test(text) && !/Unlock|password/i.test(text)) {
    log("importing wallet");
    await popup.locator("button", { hasText: /Import mnemonic/i }).first().click();
    await wait(400);
    await popup.locator("textarea").first().fill(MNEMONIC);
    await popup.locator("input[type='password']").first().fill("marvin");
    await popup.locator("button", { hasText: /^Continue$/ }).first().click();
    await wait(3500);
  } else if (/Unlock|password/i.test(text)) {
    log("unlocking wallet");
    await popup.locator("input[type='password']").first().fill("marvin");
    await popup.locator("button", { hasText: /Unlock/i }).first().click();
    await wait(2000);
  }
  log("wallet ready");
  await wait(2500);

  // Shot the lock screen first (re-lock to capture it).
  await popup.screenshot({ path: `${SHOT_DIR}/00-home.png` });
  log("shot home");

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

  const gear = popup
    .locator(".header-actions .icon-btn[aria-label='Settings']")
    .first();
  if (await gear.isVisible().catch(() => false)) {
    await gear.click();
    await wait(800);
    await popup.screenshot({ path: `${SHOT_DIR}/tab-settings.png` });
    log("settings shot");
  }

  const statusBtn = popup
    .locator(".header-actions .icon-btn[aria-label='Status']")
    .first();
  if (await statusBtn.isVisible().catch(() => false)) {
    await statusBtn.click();
    await wait(800);
    await popup.screenshot({ path: `${SHOT_DIR}/tab-status.png` });
    log("status shot");
  }

  // Capture the lock screen too: close settings and lock from header.
  const lockBtn = popup.locator("button", { hasText: /^Lock$/i }).first();
  if (await lockBtn.isVisible().catch(() => false)) {
    await lockBtn.click();
    await wait(1000);
    await popup.screenshot({ path: `${SHOT_DIR}/lock-screen.png` });
    log("lock screen shot");
  }
} catch (err) {
  console.error("[palette] ERROR:", err);
  process.exit(1);
} finally {
  await ctx.close();
}
