// Smoke test for the Loroco dApp Console (apps/dapp).
//
// Launches Chrome-for-Testing with the extension loaded + the persistent
// test profile (wallet already imported), opens the dApp dev/preview server,
// drives the real ConnectGate → approves the connection in the inline popup,
// and asserts the Dashboard renders live wallet reads.
//
// Mirrors the launch/import/auto-approve recipe from pw-wc-coverage.mjs.
//
//   DAPP_URL   default http://localhost:5174   (run `vite preview --port 5174` first)
//   USER_DATA  default /tmp/Loroco-PW-Shared
//   MNEMONIC   default = the shared throwaway test wallet

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

const __here = dirname(fileURLToPath(import.meta.url));
const EXT_PATH = resolve(__here, "..", "packages/extension/.output/chrome-mv3");
const USER_DATA = process.env.USER_DATA ?? "/tmp/Loroco-PW-Shared";
const DAPP_URL = process.env.DAPP_URL ?? "http://localhost:5174";
const SHOT_DIR = "/tmp/loroco-dapp-smoke";
const MNEMONIC =
  process.env.MNEMONIC ??
  "charge day cloth frame purpose lake method segment fat gadget regret open better rent visual picnic crater degree budget satoshi shop maple depart host";

mkdirSync(SHOT_DIR, { recursive: true });
const log = (...a) => console.log("[dapp]", ...a);

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

  // ── Import wallet if the profile hasn't been bootstrapped ────────────────
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForLoadState("domcontentloaded");
  await wait(1000);
  const popupText = await popup.locator("body").innerText();
  if (/Import|Create/i.test(popupText) && !/balance/i.test(popupText)) {
    const importBtn = popup.locator("button", { hasText: /Import mnemonic/i }).first();
    if (await importBtn.isVisible().catch(() => false)) await importBtn.click();
    await wait(400);
    await popup.locator("textarea").first().fill(MNEMONIC);
    await popup.locator("input[type='password']").first().fill("marvin");
    await popup.locator("button", { hasText: /^Continue$/ }).first().click();
    await wait(3500);
    log("wallet imported");
  } else {
    log("wallet already present");
  }

  // Unlock if the session-locked screen is up (fresh browser session).
  const pwField = popup.locator("input[type='password']").first();
  if (await pwField.isVisible().catch(() => false)) {
    await pwField.fill("marvin");
    const unlockBtn = popup
      .locator("button", { hasText: /Unlock|Continue|Enter/i })
      .first();
    if (await unlockBtn.isVisible().catch(() => false)) {
      await unlockBtn.click();
    } else {
      await pwField.press("Enter");
    }
    await wait(2500);
    log("wallet unlocked");
  }

  // ── Open the dApp ────────────────────────────────────────────────────────
  const app = await ctx.newPage();
  app.on("console", (m) => {
    if (m.type() === "error") log("   [page error]", m.text().slice(0, 200));
  });
  await app.goto(DAPP_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await wait(2000);

  // Provider must be detected — not the InstallGate.
  const bodyEarly = await app.locator("body").innerText();
  check("provider detected (no InstallGate)", !/not detected/i.test(bodyEarly));
  await app.screenshot({ path: `${SHOT_DIR}/01-initial.png` });

  // Inline-popup auto-approver. Reloads the popup if the prompt hasn't surfaced.
  async function autoApprove(maxTries = 24) {
    for (let i = 0; i < maxTries; i += 1) {
      const btn = popup.locator("button", { hasText: /^Approve$/ }).first();
      if (await btn.isVisible().catch(() => false)) {
        try {
          await btn.click({ timeout: 1500 });
          log("   approved in popup");
          await wait(600);
          return true;
        } catch {}
      }
      if (i === 6) await popup.reload().catch(() => {});
      await wait(350);
    }
    return false;
  }

  // ── Connect (or detect an already-granted origin) ────────────────────────
  const statsSel = '[data-testid="dash-stats"]';
  const alreadyIn = await app
    .locator(statsSel)
    .first()
    .isVisible({ timeout: 4000 })
    .catch(() => false);

  if (!alreadyIn) {
    const connectBtn = app.getByRole("button", { name: /^Connect$/ }).first();
    const sawGate = await connectBtn.isVisible({ timeout: 8000 }).catch(() => false);
    check("ConnectGate rendered", sawGate);
    if (sawGate) {
      await app.screenshot({ path: `${SHOT_DIR}/02-connect-gate.png` });
      await connectBtn.click();
      await wait(800);
      const approved = await autoApprove();
      check("connection approved in wallet popup", approved);
    }
  } else {
    log("origin already connected (grant restored)");
    check("ConnectGate rendered", true, "skipped — already connected");
    check("connection approved in wallet popup", true, "skipped — already connected");
  }

  // ── Dashboard renders live reads ─────────────────────────────────────────
  const dashVisible = await app
    .locator(statsSel)
    .first()
    .isVisible({ timeout: 25_000 })
    .catch(() => false);
  check("Dashboard rendered after connect", dashVisible);

  if (dashVisible) {
    // Give the read calls (getAssetBalance/getCats/…) time to settle.
    await wait(2500);
    const statsText = await app.locator(statsSel).innerText();
    log("   stats:\n" + statsText.split("\n").map((l) => "      " + l).join("\n"));
    check(
      "network read returned",
      /mainnet|testnet/i.test(statsText),
      (statsText.match(/mainnet|testnet\w*/i) || [""])[0],
    );
    check("XCH balance row present", /XCH \(confirmed\)/i.test(statsText));
    await app.screenshot({ path: `${SHOT_DIR}/03-dashboard.png`, fullPage: true });
  }

  // ── Every feature page renders its real UI (no placeholders left) ───────
  const PAGES = [
    ["Send", /Recipient address/i],
    ["Batch", /Bulk send — XCH/i],
    ["Tokens", /Owned CATs/i],
    ["NFTs", /Owned NFTs/i],
    ["Offers", /Create an offer/i],
    ["DIDs", /Create a DID/i],
    ["Coins", /Coin explorer/i],
    ["Activity", /Transactions/i],
    ["Signing", /signMessage/i],
    ["Advanced", /Raw method console/i],
  ];
  let shot = 4;
  for (const [name, sig] of PAGES) {
    const link = app.locator(`.sidebar .nav-link:has-text("${name}")`).first();
    if (!(await link.isVisible().catch(() => false))) {
      check(`nav → ${name}`, false, "nav link not visible");
      continue;
    }
    await link.click();
    await wait(900);
    const body = await app.locator(".content").innerText();
    const placeholder = /UI arrives in the features phase/i.test(body);
    check(`nav → ${name} renders real UI`, sig.test(body) && !placeholder);
    await app.screenshot({
      path: `${SHOT_DIR}/${String(shot++).padStart(2, "0")}-${name.toLowerCase()}.png`,
      fullPage: true,
    });
  }

  // ── Full write-feedback loop: signMessage → ApprovalWait → popup → ✓ ────
  {
    await app.locator('.sidebar .nav-link:has-text("Signing")').first().click();
    await wait(900);
    const msgBox = app.locator(".content textarea").first();
    if (await msgBox.isVisible().catch(() => false)) {
      await msgBox.fill("loroco smoke test");
      await app.getByRole("button", { name: /Review in wallet/ }).first().click();
      const sawWait = await app
        .locator(".approval-wait")
        .first()
        .isVisible({ timeout: 5000 })
        .catch(() => false);
      check("ApprovalWait banner shown while popup gates the call", sawWait);
      await app.screenshot({ path: `${SHOT_DIR}/98-approval-wait.png` });
      const approved = await autoApprove();
      check("signMessage approved in wallet popup", approved);
      if (approved) {
        const ok = await app
          .locator(".note.success")
          .first()
          .isVisible({ timeout: 15_000 })
          .catch(() => false);
        check("signature success note rendered", ok);
        await app.screenshot({ path: `${SHOT_DIR}/98b-signed.png` });
      }
    } else {
      check("ApprovalWait banner shown while popup gates the call", false, "message box missing");
    }
  }

  // ── Raw console round-trip: chainId through the new Advanced UI ─────────
  {
    await app.locator('.sidebar .nav-link:has-text("Advanced")').first().click();
    await wait(900);
    const methodInput = app.locator('input[list="all-methods"]').first();
    if (await methodInput.isVisible().catch(() => false)) {
      await methodInput.fill("chainId");
      await app.getByRole("button", { name: /^Call$/ }).first().click();
      await wait(1500);
      const summary = app.locator(".json-view summary").first();
      if (await summary.isVisible().catch(() => false)) await summary.click();
      await wait(300);
      const consoleText = await app.locator(".content").innerText();
      check("raw console chainId returns a network", /mainnet|testnet/i.test(consoleText));
      await app.screenshot({ path: `${SHOT_DIR}/99-raw-console.png` });
    } else {
      check("raw console chainId returns a network", false, "method input not found");
    }
  }

  log("");
  log("=== SUMMARY ===");
  log(`passed: ${passed}  failed: ${failed}`);
  log(`screenshots: ${SHOT_DIR}`);
  if (failed > 0) {
    log("FAIL: " + fails.join(", "));
    process.exitCode = 1;
  } else {
    log("✓ dApp console smoke passed");
  }
} catch (err) {
  console.error("[dapp] ERROR:", err);
  process.exitCode = 1;
} finally {
  await wait(800);
  await ctx.close();
}
