// End-to-end: connect dexie → see it in popup's Settings → revoke → verify
// dexie loses access (chia.request({method:'accounts'}) returns 4001).

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";

const EXT_PATH =
  "/Users/marvin/Projects/Ozone/sage-web/ozone-web-extension/packages/extension/.output/chrome-mv3";
const USER_DATA = "/tmp/Ozone-PW-Conn";
const SHOT_DIR = "/tmp/ozone-pw-conn";
const MNEMONIC =
  process.env.MNEMONIC ??
  "charge day cloth frame purpose lake method segment fat gadget regret open better rent visual picnic crater degree budget satoshi shop maple depart host";

mkdirSync(SHOT_DIR, { recursive: true });
const log = (...a) => console.log("[conn]", ...a);
const fail = (m) => {
  console.error("[conn] FAIL:", m);
  process.exit(1);
};

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

  // Import wallet.
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForLoadState("domcontentloaded");
  await wait(1000);
  if (/Import|Create/i.test(await popup.locator("body").innerText())) {
    const importBtn = popup.locator("button", { hasText: /Import mnemonic/i }).first();
    if (await importBtn.isVisible().catch(() => false)) await importBtn.click();
    await wait(400);
    await popup.locator("textarea").first().fill(MNEMONIC);
    await popup.locator("input[type='password']").first().fill("marvin");
    await popup.locator("button", { hasText: /^Continue$/ }).first().click();
    await wait(3500);
  }
  log("wallet imported");

  // ── Connect dexie ──────────────────────────────────────────────────────
  const dexie = await ctx.newPage();
  await dexie.goto("https://dexie.space", { waitUntil: "networkidle", timeout: 30_000 });
  await wait(2500);
  await dexie.locator("button:has-text('Connect Wallet')").first().click();
  await wait(1200);
  const connectBtns = dexie.locator(":visible >> button:has-text('Connect')").filter({
    hasText: /^Connect$/,
  });
  await connectBtns.nth(1).click();
  // Approval lives inside the popup — bring it forward and approve.
  await popup.bringToFront();
  let approvalReady = false;
  for (let i = 0; i < 15; i += 1) {
    const cnt = await popup
      .locator(":visible >> button:has-text('Approve')")
      .count()
      .catch(() => 0);
    if (cnt > 0) {
      approvalReady = true;
      break;
    }
    await wait(500);
  }
  if (!approvalReady) fail("popup didn't surface Approve button");
  await popup.locator("button", { hasText: /^Approve$/ }).first().click();
  await wait(2500);
  log("dexie connected");

  // ── Verify popup shows the connection ──────────────────────────────────
  // Open Settings tab in popup, then look at "Connected sites".
  await popup.bringToFront();
  // Settings button is the gear icon in the header.
  await popup
    .locator(".header-actions .icon-btn[aria-label='Settings']")
    .first()
    .click();
  await wait(600);
  await popup.screenshot({ path: `${SHOT_DIR}/01-settings.png` });

  // Look for the host inside the connections list.
  const hostCells = await popup
    .locator(".connection-host")
    .allInnerTexts();
  log("connection hosts in popup:", hostCells);
  if (!hostCells.includes("dexie.space")) {
    fail(`expected dexie.space in connections list, got ${JSON.stringify(hostCells)}`);
  }

  // ── Revoke ─────────────────────────────────────────────────────────────
  log("clicking Disconnect on dexie.space");
  // Find the row containing dexie.space and click its Disconnect button.
  const dexieRow = popup
    .locator(".connection-row")
    .filter({ hasText: /dexie\.space/ })
    .first();
  await dexieRow.locator("button:has-text('Disconnect')").click();
  await wait(1500);
  await popup.screenshot({ path: `${SHOT_DIR}/02-after-revoke.png` });

  const hostsAfter = await popup.locator(".connection-host").allInnerTexts();
  log("connection hosts after revoke:", hostsAfter);
  if (hostsAfter.includes("dexie.space")) {
    fail("dexie.space still listed after Disconnect");
  }

  // ── Verify dexie loses access ──────────────────────────────────────────
  await dexie.bringToFront();
  await wait(500);
  const probe = await dexie.evaluate(async () => {
    try {
      const r = await window.chia.request({ method: "accounts" });
      return { ok: true, value: r };
    } catch (e) {
      return { ok: false, code: e?.code, message: e?.message };
    }
  });
  log("dexie.accounts after revoke:", JSON.stringify(probe));
  if (probe.ok) {
    fail("dexie still has access after revoke");
  }
  if (probe.code !== 4001) {
    log(`WARN: expected code 4001 (Unauthorized), got ${probe.code}`);
  }

  log("ALL CHECKS PASSED");
} catch (err) {
  console.error("[conn] ERROR:", err);
  process.exit(1);
} finally {
  await ctx.close();
}
