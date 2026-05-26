// Smoke test for the multi-wallet onboarding paths.
//
// - Boots a clean profile, walks through the "Welcome to Ozone" screen,
//   importing the dev mnemonic.
// - Then opens Settings and adds a SECOND wallet via the private-key import
//   flow (32 random bytes).
// - Verifies the wallet list shows both, switcher works, switching between
//   them flips the active fingerprint in the header.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { randomBytes } from "node:crypto";

// Generate a random scalar < BLS12-381 group order.
// Order r = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001
// Force the first byte below 0x73 so we're guaranteed < r.
function randomBlsSk() {
  const b = randomBytes(32);
  b[0] = b[0] % 0x73;
  return "0x" + b.toString("hex");
}

const EXT_PATH =
  "/Users/marvin/Projects/Ozone/sage-web/ozone-web-extension/packages/extension/.output/chrome-mv3";
const USER_DATA = "/tmp/Ozone-PW-Multi";
const SHOT_DIR = "/tmp/ozone-pw-multi";
const MNEMONIC_24 =
  "charge day cloth frame purpose lake method segment fat gadget regret open better rent visual picnic crater degree budget satoshi shop maple depart host";

mkdirSync(SHOT_DIR, { recursive: true });
const log = (...a) => console.log("[multi]", ...a);
const fail = (m) => {
  console.error("[multi] FAIL:", m);
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
  ],
});

try {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15_000 });
  const extId = sw.url().split("/")[2];
  log("ext id:", extId);

  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForLoadState("domcontentloaded");
  await wait(800);
  await popup.screenshot({ path: `${SHOT_DIR}/00-welcome.png` });

  // 1) Welcome screen — verify all 4 onboarding options exist
  const welcomeText = await popup.locator("body").innerText();
  if (!/Welcome to Ozone/i.test(welcomeText)) {
    fail("expected fresh onboarding (Welcome to Ozone)");
  }
  for (const label of [
    /Create new wallet \(24 words\)/i,
    /Create new wallet \(12 words\)/i,
    /Import mnemonic/i,
    /Import private key/i,
  ]) {
    const btn = popup.locator("button", { hasText: label }).first();
    if (!(await btn.isVisible().catch(() => false))) {
      fail(`onboarding option missing: ${label}`);
    }
  }
  log("welcome shows all 4 options");

  // 2) Import the dev mnemonic
  await popup.locator("button", { hasText: /Import mnemonic/i }).first().click();
  await wait(400);
  await popup.locator("textarea").first().fill(MNEMONIC_24);
  await popup.locator("input[type='password']").first().fill("marvin");
  await popup.screenshot({ path: `${SHOT_DIR}/01-import-mnemonic.png` });
  await popup.locator("button", { hasText: /^Continue$/ }).first().click();
  await wait(3000);
  await popup.screenshot({ path: `${SHOT_DIR}/02-after-mnemonic-import.png` });

  const fpFirst = (await popup.locator("body").innerText()).match(/fp (\d+)/)?.[1];
  log("first wallet fp:", fpFirst);
  if (!fpFirst) fail("could not parse first wallet fingerprint from home");

  // 3) Open Settings (gear icon, 2nd in header-actions)
  const settingsBtn = popup.locator(".header-actions .icon-btn").nth(1);
  await settingsBtn.click();
  await wait(600);
  await popup.screenshot({ path: `${SHOT_DIR}/03-settings-single-wallet.png` });

  // The Wallets section should be visible and have one row
  const rowsBeforeCount = await popup.locator(".wallet-row").count();
  log("wallet rows before add:", rowsBeforeCount);
  if (rowsBeforeCount !== 1) fail(`expected 1 wallet row, got ${rowsBeforeCount}`);

  // 4) Add another wallet via private key
  await popup.locator("button", { hasText: /Add another wallet/i }).first().click();
  await wait(500);

  await popup.locator("button", { hasText: /Import private key/i }).first().click();
  await wait(400);
  const randomSk = randomBlsSk();
  await popup.locator("textarea").first().fill(randomSk);
  await popup.locator("input[type='password']").first().fill("marvin");
  await popup.screenshot({ path: `${SHOT_DIR}/04-import-key.png` });
  await popup.locator("button", { hasText: /^Continue$/ }).first().click();
  await wait(3000);
  await popup.screenshot({ path: `${SHOT_DIR}/05-after-second-import.png` });

  // 5) Open settings again, verify 2 wallets now
  await popup.locator(".header-actions .icon-btn").nth(1).click();
  await wait(600);
  await popup.screenshot({ path: `${SHOT_DIR}/06-settings-two-wallets.png` });
  const rowsAfter = await popup.locator(".wallet-row").count();
  log("wallet rows after add:", rowsAfter);
  if (rowsAfter !== 2) fail(`expected 2 wallet rows, got ${rowsAfter}`);

  // 6) Header now should show a wallet-switcher select
  const hasSwitcher = await popup.locator(".wallet-switcher").count();
  log("wallet-switcher count:", hasSwitcher);
  if (hasSwitcher !== 1) fail("expected header wallet-switcher when 2+ wallets");

  // 7) Switch to the other wallet from the row list
  const inactive = popup.locator(".wallet-row:not(.active)").first();
  await inactive.click();
  await wait(2500);
  await popup.screenshot({ path: `${SHOT_DIR}/07-after-switch.png` });

  // Both wallets were unlocked during import in the same session, so the
  // engine still has both SKs cached; the switch goes straight to Home for
  // the other wallet, not the Lock screen.
  const bodyAfterSwitch = await popup.locator("body").innerText();
  log("after switch (first 200 chars):", bodyAfterSwitch.slice(0, 200).replace(/\s+/g, " "));
  if (!new RegExp(` ${fpFirst}`).test(bodyAfterSwitch)) {
    fail(`expected first wallet ( ${fpFirst}) to be active after switch`);
  }
  // The wallet-switcher in the header should still be present and show fpFirst as selected
  const headerSwitcherVal = await popup.locator(".wallet-switcher").first().inputValue();
  if (headerSwitcherVal !== fpFirst) {
    fail(`header switcher should be ${fpFirst}, got ${headerSwitcherVal}`);
  }

  log("ALL CHECKS PASSED");
  console.log(`Screenshots in: ${SHOT_DIR}`);
} catch (err) {
  console.error("[multi] ERROR:", err);
  for (const [i, p] of ctx.pages().entries()) {
    await p.screenshot({ path: `${SHOT_DIR}/err-${i}.png` }).catch(() => {});
  }
  process.exit(1);
} finally {
  await ctx.close();
}
