// Full dexie connect smoke. Now that `requestAccounts` is implemented,
// clicking dexie's Connect → Goby Wallet should:
//   1. Trigger our approval popup
//   2. After approve, grant the origin connection
//   3. Return the wallet's derived xch1 addresses
//   4. Dexie shows the connected account on the picker row

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";

const EXT_PATH =
  "/Users/marvin/Projects/Ozone/sage-web/ozone-web-extension/packages/extension/.output/chrome-mv3";
const USER_DATA = "/tmp/Ozone-PW-DxConn";
const SHOT_DIR = "/tmp/ozone-pw-dxconn";
const MNEMONIC =
  process.env.MNEMONIC ??
  "charge day cloth frame purpose lake method segment fat gadget regret open better rent visual picnic crater degree budget satoshi shop maple depart host";

mkdirSync(SHOT_DIR, { recursive: true });
const log = (...a) => console.log("[dxconn]", ...a);

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

  // ── Step 1: import wallet via the popup ─────────────────────────────────
  log("opening popup to import wallet");
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForLoadState("domcontentloaded");
  await wait(1000);
  const popupText = await popup.locator("body").innerText();
  if (/Import|Create/i.test(popupText)) {
    log("importing dev mnemonic");
    const importBtn = popup.locator("button", { hasText: /Import mnemonic/i }).first();
    if (await importBtn.isVisible().catch(() => false)) await importBtn.click();
    await wait(400);
    await popup.locator("textarea").first().fill(MNEMONIC);
    await popup.locator("input[type='password']").first().fill("marvin");
    await popup.locator("button", { hasText: /^Continue$/ }).first().click();
    await wait(3500);
  }
  await popup.screenshot({ path: `${SHOT_DIR}/01-popup-imported.png` });

  // ── Step 2: open dexie and click Connect → Goby ─────────────────────────
  log("opening dexie.space");
  const dexie = await ctx.newPage();
  dexie.on("console", (m) => {
    if (m.type() === "error") log("dexie console.error:", m.text().slice(0, 160));
  });
  await dexie.goto("https://dexie.space", { waitUntil: "networkidle", timeout: 30_000 });
  await wait(2500);

  log("opening Connect Wallet picker");
  await dexie.locator("button:has-text('Connect Wallet')").first().click();
  await wait(1200);
  await dexie.screenshot({ path: `${SHOT_DIR}/02-picker.png` });

  log("clicking Connect on Goby row (kicks chia.request → SW)");
  const connectBtns = dexie.locator(":visible >> button:has-text('Connect')").filter({
    hasText: /^Connect$/,
  });
  await connectBtns.nth(1).click(); // Goby row

  // Approval no longer pops its own window — it now lives inside the
  // extension popup. Reuse the popup page we already have open.
  log("polling popup for pending approval");
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
  if (!approvalReady) {
    log("FAIL: popup never surfaced an Approve button");
    process.exit(1);
  }
  await wait(400);
  await popup.screenshot({ path: `${SHOT_DIR}/03-approval.png` });

  const approvalText = await popup.locator("body").innerText();
  log("approval text:", approvalText.slice(0, 200).replace(/\s+/g, " "));
  if (!approvalText.includes("dexie.space")) {
    log("WARN: approval doesn't mention dexie.space");
  }

  log("clicking Approve inside popup");
  await popup.locator("button", { hasText: /^Approve$/ }).first().click();
  await wait(2500);

  // Back on dexie: the picker should close, and the Goby row should show
  // "Connected" with a truncated xch1 address.
  await dexie.screenshot({ path: `${SHOT_DIR}/04-after-approve.png` });

  const connectedTag = await dexie.locator(":visible >> text=Connected").count();
  log("'Connected' badges on dexie:", connectedTag);
  if (connectedTag === 0) {
    log("WARN: no 'Connected' state visible on dexie — maybe the picker reopened or the connect failed");
  } else {
    log("✓ dexie shows Connected");
  }

  // Read selectedAddress directly from the page for verification.
  const probe = await dexie.evaluate(async () => {
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
  console.error("[dxconn] ERROR:", err);
  process.exit(1);
} finally {
  await ctx.close();
}
