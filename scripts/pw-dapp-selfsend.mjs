// Real end-to-end spend through the dApp Console.
//
// Uses the funded wallet from .env (MNEMONIC/PASSWORD/USER_DATA — never
// committed). Connects the console, waits for coin sync, then SELF-SENDS a
// tiny XCH amount with NO fee and verifies the whole feedback loop the
// console promises:
//
//   Send form → ApprovalWait banner → approve in wallet popup →
//   TxResult (tx id) → "N pending" pill in TopBar → confirmation toast.
//
//   node scripts/pw-dapp-selfsend.mjs
//
// Env overrides: DAPP_URL (default http://localhost:5174), AMOUNT_XCH
// (default 0.000001), SYNC_TIMEOUT_MS, CONFIRM_TIMEOUT_MS.

import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

const __here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__here, "..");
const EXT_PATH = resolve(ROOT, "packages/extension/.output/chrome-mv3");
const SHOT_DIR = "/tmp/loroco-dapp-selfsend";
const DAPP_URL = process.env.DAPP_URL ?? "http://localhost:5174";
const AMOUNT_XCH = process.env.AMOUNT_XCH ?? "0.000001";
const SYNC_TIMEOUT_MS = Number(process.env.SYNC_TIMEOUT_MS ?? 300_000);
const CONFIRM_TIMEOUT_MS = Number(process.env.CONFIRM_TIMEOUT_MS ?? 360_000);

// ── .env loader (no dotenv dep) ───────────────────────────────────────────
function loadEnv() {
  const out = {};
  for (const line of readFileSync(resolve(ROOT, ".env"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, "").trim();
  }
  return out;
}
const ENV = loadEnv();
const MNEMONIC = ENV.MNEMONIC;
const PASSWORD = ENV.PASSWORD || "marvin";
const USER_DATA = process.env.USER_DATA ?? ENV.USER_DATA ?? "/tmp/Loroco-PW-Real";
if (!MNEMONIC) {
  console.error("[selfsend] .env is missing MNEMONIC");
  process.exit(1);
}

mkdirSync(SHOT_DIR, { recursive: true });
const log = (...a) => console.log("[selfsend]", ...a);

let passed = 0;
let failed = 0;
const fails = [];
function check(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    log(`   ✓ ${name}${detail ? " — " + detail : ""}`);
  } else {
    failed += 1;
    fails.push(name);
    log(`   ✗ ${name}${detail ? " — " + detail : ""}`);
  }
}

const ctx = await chromium.launchPersistentContext(USER_DATA, {
  headless: false,
  channel: "chromium",
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-position=0,0",
    "--window-size=1300,900",
  ],
});

try {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
  const extId = sw.url().split("/")[2];
  log("ext id:", extId);

  // ── Wallet ready: import or unlock ───────────────────────────────────────
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForLoadState("domcontentloaded");
  await wait(1200);
  const popupText = await popup.locator("body").innerText();
  if (/Import|Create/i.test(popupText) && !/balance/i.test(popupText)) {
    const importBtn = popup.locator("button", { hasText: /Import mnemonic/i }).first();
    if (await importBtn.isVisible().catch(() => false)) await importBtn.click();
    await wait(400);
    await popup.locator("textarea").first().fill(MNEMONIC);
    await popup.locator("input[type='password']").first().fill(PASSWORD);
    await popup.locator("button", { hasText: /^Continue$/ }).first().click();
    await wait(3500);
    log("wallet imported (fresh profile — sync will take a while)");
  } else {
    log("wallet already present");
  }
  const pwField = popup.locator("input[type='password']").first();
  if (await pwField.isVisible().catch(() => false)) {
    await pwField.fill(PASSWORD);
    const unlockBtn = popup.locator("button", { hasText: /Unlock|Continue|Enter/i }).first();
    if (await unlockBtn.isVisible().catch(() => false)) await unlockBtn.click();
    else await pwField.press("Enter");
    await wait(2500);
    log("wallet unlocked");
  }

  // ── dApp: connect ────────────────────────────────────────────────────────
  const app = await ctx.newPage();
  app.on("console", (m) => {
    if (m.type() === "error") log("   [page error]", m.text().slice(0, 200));
  });
  await app.goto(DAPP_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await wait(2000);

  async function autoApprove(maxTries = 30) {
    for (let i = 0; i < maxTries; i += 1) {
      const btn = popup.locator("button", { hasText: /^Approve$/ }).first();
      if (await btn.isVisible().catch(() => false)) {
        // signCoinSpends-style approvals gate Approve behind an ack checkbox.
        const ack = popup.locator('input[type="checkbox"]').first();
        if (await ack.isVisible().catch(() => false)) {
          await ack.check().catch(() => {});
        }
        try {
          await btn.click({ timeout: 1500 });
          log("   approved in popup");
          await wait(600);
          return true;
        } catch {}
      }
      if (i > 0 && i % 7 === 0) await popup.reload().catch(() => {});
      await wait(400);
    }
    return false;
  }

  const statsSel = '[data-testid="dash-stats"]';
  const alreadyIn = await app.locator(statsSel).first().isVisible({ timeout: 4000 }).catch(() => false);
  if (!alreadyIn) {
    const connectBtn = app.getByRole("button", { name: /^Connect$/ }).first();
    if (await connectBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
      await connectBtn.click();
      await wait(800);
      check("connection approved", await autoApprove());
    }
  } else {
    log("origin already connected");
  }
  await app.locator(statsSel).first().waitFor({ timeout: 30_000 });

  // ── Wait for sync: spendable balance > 0 (read via the provider) ────────
  log(`waiting for coin sync (up to ${SYNC_TIMEOUT_MS / 1000}s)…`);
  const t0 = Date.now();
  let spendable = 0n;
  while (Date.now() - t0 < SYNC_TIMEOUT_MS) {
    try {
      const bal = await app.evaluate(() =>
        window.loroco.request({ method: "getAssetBalance", params: { type: null, assetId: null } }),
      );
      spendable = BigInt(bal.spendable ?? "0");
      if (spendable > 0n) break;
    } catch {}
    await wait(5000);
  }
  check("wallet synced with spendable XCH", spendable > 0n, `${spendable} mojos`);
  if (spendable === 0n) throw new Error("no spendable balance — cannot test the spend flow");

  const { address } = await app.evaluate(() =>
    window.loroco.request({ method: "getAddress", params: {} }),
  );
  log("own address:", address);

  // ── Send page: self-send, no fee ─────────────────────────────────────────
  await app.locator('.sidebar .nav-link:has-text("Send")').first().click();
  await wait(900);
  await app.locator('.content input[placeholder="0.0"]').first().fill(AMOUNT_XCH); // Amount
  await app.locator('.content input[placeholder="xch1…"]').first().fill(address);
  await app.screenshot({ path: `${SHOT_DIR}/01-send-filled.png`, fullPage: true });
  await app.getByRole("button", { name: /Review in wallet/ }).first().click();

  const sawWait = await app
    .locator(".approval-wait")
    .first()
    .isVisible({ timeout: 5000 })
    .catch(() => false);
  check("ApprovalWait banner shown", sawWait);
  await app.screenshot({ path: `${SHOT_DIR}/02-approval-wait.png` });

  // The popup must show the REAL recipient + amount (display integrity).
  await wait(800);
  await popup.reload().catch(() => {});
  await wait(800);
  const popupBody = await popup.locator("body").innerText().catch(() => "");
  const shownOk = popupBody.includes(address.slice(0, 12)) || popupBody.includes(address);
  check("popup shows the recipient address", shownOk);
  await popup.screenshot({ path: `${SHOT_DIR}/03-popup-approval.png` });

  check("transfer approved in popup", await autoApprove());

  // ── TxResult with id ─────────────────────────────────────────────────────
  const txResult = app.locator('[data-testid="tx-result"]').first();
  const gotResult = await txResult.waitFor({ timeout: 90_000 }).then(() => true).catch(() => false);
  check("TxResult rendered after broadcast", gotResult);
  if (gotResult) {
    const txt = await txResult.innerText();
    log("   tx-result:", txt.split("\n")[0], "…");
    await app.screenshot({ path: `${SHOT_DIR}/04-tx-result.png`, fullPage: true });
  }

  // ── Pending pill appears, then confirmation toast ────────────────────────
  const pill = app.locator('[data-testid="pending-pill"]').first();
  const sawPill = await pill.waitFor({ timeout: 45_000 }).then(() => true).catch(() => false);
  check("pending pill visible in TopBar", sawPill);
  if (sawPill) await app.screenshot({ path: `${SHOT_DIR}/05-pending-pill.png` });

  log(`waiting for on-chain confirmation (up to ${CONFIRM_TIMEOUT_MS / 1000}s)…`);
  const t1 = Date.now();
  let confirmed = false;
  let sawToast = false;
  while (Date.now() - t1 < CONFIRM_TIMEOUT_MS) {
    if (!sawToast) {
      sawToast = await app
        .locator(".toast", { hasText: /confirmed/i })
        .first()
        .isVisible()
        .catch(() => false);
      if (sawToast) await app.screenshot({ path: `${SHOT_DIR}/06-confirmed-toast.png` });
    }
    const pillGone = !(await pill.isVisible().catch(() => false));
    if (sawToast || (sawPill && pillGone && Date.now() - t1 > 20_000)) {
      confirmed = true;
      break;
    }
    await wait(3000);
  }
  check("transaction confirmed (toast or pending pill cleared)", confirmed, sawToast ? "toast seen" : "pill cleared");

  // Activity should list it.
  await app.locator('.sidebar .nav-link:has-text("Activity")').first().click();
  await wait(1500);
  const actText = await app.locator(".content").innerText();
  check("Activity lists transactions", /confirmed|pending/i.test(actText));
  await app.screenshot({ path: `${SHOT_DIR}/07-activity.png`, fullPage: true });

  log("");
  log("=== SUMMARY ===");
  log(`passed: ${passed}  failed: ${failed}`);
  log(`screenshots: ${SHOT_DIR}`);
  if (failed > 0) {
    log("FAIL: " + fails.join(", "));
    process.exitCode = 1;
  } else {
    log("✓ self-send flow passed");
  }
} catch (err) {
  console.error("[selfsend] ERROR:", err);
  process.exitCode = 1;
} finally {
  await wait(1000);
  await ctx.close();
}
