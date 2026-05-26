// Same flow as pw-dexie-connect but against v2.tibetswap.io.
// Verifies the requestAccounts + accounts handlers work on a different
// Goby-based dApp.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";

const EXT_PATH =
  "/Users/marvin/Projects/Ozone/sage-web/ozone-web-extension/packages/extension/.output/chrome-mv3";
const USER_DATA = "/tmp/Ozone-PW-TbConn";
const SHOT_DIR = "/tmp/ozone-pw-tbconn";
const MNEMONIC =
  process.env.MNEMONIC ??
  "charge day cloth frame purpose lake method segment fat gadget regret open better rent visual picnic crater degree budget satoshi shop maple depart host";

mkdirSync(SHOT_DIR, { recursive: true });
const log = (...a) => console.log("[tbconn]", ...a);

const ctx = await chromium.launchPersistentContext(USER_DATA, {
  headless: false,
  channel: "chromium",
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-position=0,0",
    "--window-size=1200,900",
  ],
});

try {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
  const extId = sw.url().split("/")[2];
  log("ext id:", extId);

  // Import wallet
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForLoadState("domcontentloaded");
  await wait(1000);
  const popupText = await popup.locator("body").innerText();
  if (/Import|Create/i.test(popupText)) {
    const importBtn = popup.locator("button", { hasText: /Import mnemonic/i }).first();
    if (await importBtn.isVisible().catch(() => false)) await importBtn.click();
    await wait(400);
    await popup.locator("textarea").first().fill(MNEMONIC);
    await popup.locator("input[type='password']").first().fill("marvin");
    await popup.locator("button", { hasText: /^Continue$/ }).first().click();
    await wait(3500);
  }

  // Tibet swap
  log("opening tibetswap");
  const tibet = await ctx.newPage();
  await tibet.goto("https://v2.tibetswap.io", { waitUntil: "networkidle", timeout: 30_000 });
  await wait(2500);
  await tibet.screenshot({ path: `${SHOT_DIR}/01-loaded.png` });

  const approvalPromise = ctx.waitForEvent("page", { timeout: 10_000 }).catch(() => null);

  log("opening Connect Wallet picker");
  await tibet.locator("button:has-text('Connect Wallet')").first().click();
  await wait(1500);
  await tibet.screenshot({ path: `${SHOT_DIR}/02-picker.png` });

  log("clicking Connect on Goby row");
  const connectBtns = tibet.locator(":visible >> button:has-text('Connect')").filter({
    hasText: /^Connect$/,
  });
  const total = await connectBtns.count();
  log("connect buttons total:", total);
  // On tibet, the picker is just 2 entries: Goby Wallet, Wallet Connect.
  // So Goby = index 0.
  await connectBtns.first().click();

  const approval = await approvalPromise;
  if (!approval) {
    log("FAIL: no approval popup opened");
    process.exit(1);
  }
  await approval.waitForLoadState("domcontentloaded").catch(() => {});
  await approval.setViewportSize({ width: 400, height: 600 }).catch(() => {});
  await wait(500);
  await approval.screenshot({ path: `${SHOT_DIR}/03-approval.png` });
  const approvalText = await approval.locator("body").innerText();
  log("approval:", approvalText.slice(0, 180).replace(/\s+/g, " "));

  log("approving");
  await approval.locator("button", { hasText: /Approve/i }).first().click();
  await wait(2500);
  await tibet.screenshot({ path: `${SHOT_DIR}/04-after-approve.png` });

  const probe = await tibet.evaluate(async () => {
    try {
      const r = await window.chia.request({ method: "accounts" });
      return { ok: true, accounts: r };
    } catch (e) {
      return { ok: false, error: { message: e?.message, code: e?.code } };
    }
  });
  log("post-approve accounts probe:", JSON.stringify(probe));

  log("DONE — screenshots in:", SHOT_DIR);
} catch (err) {
  console.error("[tbconn] ERROR:", err);
  process.exit(1);
} finally {
  await ctx.close();
}
