// Capture every extension popup screen at the real 380x600 size for a UX
// review pass. Unlocks the shared synced profile, then screenshots each tab
// (home/send/receive/nfts/activity) plus settings + status overlays.
//
//   node scripts/pw-ext-ux.mjs
//
//   USER_DATA  default /tmp/Loroco-PW-Shared (synced wallet)
//   PASSWORD   default marvin

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

const __here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__here, "..");
const EXT_PATH = resolve(ROOT, "packages/extension/.output/chrome-mv3");
const USER_DATA = process.env.USER_DATA ?? "/tmp/Loroco-PW-Shared";
const PASSWORD = process.env.PASSWORD ?? "marvin";
const SHOT_DIR = "/tmp/loroco-ext-ux";
const MNEMONIC =
  process.env.MNEMONIC ??
  "charge day cloth frame purpose lake method segment fat gadget regret open better rent visual picnic crater degree budget satoshi shop maple depart host";

mkdirSync(SHOT_DIR, { recursive: true });
const log = (...a) => console.log("[ext-ux]", ...a);

const ctx = await chromium.launchPersistentContext(USER_DATA, {
  headless: false,
  channel: "chromium",
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=900,820",
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
  // Fresh profiles need the SW to install + fetch the WASM module before the
  // engine can answer an import — clicking too early throws "Failed to fetch".
  await wait(4000);

  const body = await popup.locator("body").innerText();
  let shot = 1;
  const snap = async (name) => {
    await wait(700);
    await popup.screenshot({ path: `${SHOT_DIR}/${String(shot++).padStart(2, "0")}-${name}.png` });
    log("shot", name);
  };

  // ── Onboarding / locked capture before unlocking ─────────────────────────
  if (/Import|Create|Get started/i.test(body) && !/balance|Receive/i.test(body)) {
    await snap("onboarding");
    const importBtn = popup.locator("button", { hasText: /Import mnemonic/i }).first();
    if (await importBtn.isVisible().catch(() => false)) await importBtn.click();
    await wait(400);
    await popup.locator("textarea").first().fill(MNEMONIC);
    await popup.locator("input[type='password']").first().fill(PASSWORD);
    // Retry Continue while the engine warms up ("Failed to fetch" on a cold SW).
    for (let i = 0; i < 5; i += 1) {
      await popup.locator("button", { hasText: /^Continue$/ }).first().click().catch(() => {});
      await wait(4000);
      const t = await popup.locator("body").innerText();
      if (!/Failed to fetch|error/i.test(t)) break;
      log("import retry", i + 1);
      await wait(2000);
    }
    log("imported");
  }

  // Locked screen (password prompt)?
  const pw = popup.locator("input[type='password']").first();
  if (await pw.isVisible().catch(() => false)) {
    await snap("locked");
    await pw.fill(PASSWORD);
    const unlock = popup.locator("button", { hasText: /Unlock|Continue|Enter/i }).first();
    if (await unlock.isVisible().catch(() => false)) await unlock.click();
    else await pw.press("Enter");
    await wait(3000);
    log("unlocked");
  }

  // Let the balance/CAT/NFT reads settle.
  await wait(3500);

  // ── Tabs ─────────────────────────────────────────────────────────────────
  async function clickTab(label) {
    const t = popup.locator(`nav.tabs-bottom button[aria-label="${label}"]`).first();
    if (await t.isVisible().catch(() => false)) {
      await t.click().catch(() => {});
      await wait(1200);
      return true;
    }
    return false;
  }

  await snap("home");
  if (await clickTab("Send")) await snap("send");
  if (await clickTab("Receive")) await snap("receive");
  if (await clickTab("NFTs")) await snap("nfts");
  if (await clickTab("Activity")) await snap("activity");
  await clickTab("Home");

  // ── Settings + Status via header icons ───────────────────────────────────
  const gear = popup.locator("button[title*='Settings'], button[aria-label*='Settings']").first();
  if (await gear.isVisible().catch(() => false)) {
    await gear.click();
    await wait(1000);
    await snap("settings");
  }
  // Back home, then status icon.
  await clickTab("Home").catch(() => {});
  const status = popup.locator("button[title*='Status'], button[aria-label*='Status']").first();
  if (await status.isVisible().catch(() => false)) {
    await status.click();
    await wait(1000);
    await snap("status");
  }

  log("");
  log(`done — ${shot - 1} screenshots in ${SHOT_DIR}`);
} catch (err) {
  console.error("[ext-ux] ERROR:", err);
  process.exitCode = 1;
} finally {
  await wait(800);
  await ctx.close();
}
