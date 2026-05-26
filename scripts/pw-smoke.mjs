// Playwright smoke test for the loaded MV3 extension.
//
// - Boots a persistent Chromium profile with the extension loaded
// - Waits for the background service worker to come up
// - Opens the popup at chrome-extension://<id>/popup.html
// - Walks through onboarding (import with the dev mnemonic)
// - Asserts the new UI bits: tab icons, lock button, settings icon, persisted tab
// - Asserts the Send tab now exposes the asset selector
// - Saves screenshots to /tmp/ozone-pw/*.png

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";

const EXT_PATH =
  "/Users/marvin/Projects/Ozone/sage-web/ozone-web-extension/packages/extension/.output/chrome-mv3";
const USER_DATA = "/tmp/Ozone-PW-Profile";
const SHOT_DIR = "/tmp/ozone-pw";
const MNEMONIC =
  "charge day cloth frame purpose lake method segment fat gadget regret open better rent visual picnic crater degree budget satoshi shop maple depart host";

mkdirSync(SHOT_DIR, { recursive: true });

const log = (...args) => console.log("[smoke]", ...args);
const fail = (msg) => {
  console.error("[smoke] FAIL:", msg);
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
  // Wait for the SW
  let sw = ctx.serviceWorkers()[0];
  if (!sw) {
    log("waiting for service worker…");
    sw = await ctx.waitForEvent("serviceworker", { timeout: 15_000 });
  }
  const extId = sw.url().split("/")[2];
  log("extension id:", extId);

  // Open the popup
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForLoadState("domcontentloaded");
  await wait(800);
  await popup.screenshot({ path: `${SHOT_DIR}/01-popup-initial.png` });
  log("opened popup");

  // If we landed on the lock screen (wallet already imported but locked),
  // unlock with the test password.
  const bodyText = await popup.locator("body").innerText();
  if (/Unlock/i.test(bodyText) && !/Import existing/i.test(bodyText)) {
    log("locked wallet — unlocking");
    const pwd = popup.locator("input[type='password']").first();
    await pwd.fill("marvin");
    const unlockBtn = popup.locator("button", { hasText: /^Unlock$/ }).first();
    await unlockBtn.click();
    await wait(3000);
  } else if (/Import|Create/i.test(bodyText)) {
    log("onboarding flow detected — importing mnemonic");

    // Look for an "Import" button (label may vary)
    const importBtn = popup
      .locator("button", { hasText: /^Import( wallet| existing)?/i })
      .first();
    await importBtn.waitFor({ timeout: 5_000 }).catch(() => {});
    if (await importBtn.isVisible().catch(() => false)) {
      await importBtn.click();
      await wait(500);
    }

    // Paste the mnemonic into the textarea
    const mnemonicInput = popup.locator("textarea").first();
    await mnemonicInput.waitFor({ timeout: 5_000 });
    await mnemonicInput.fill(MNEMONIC);

    // Set the password
    const pwdInput = popup.locator("input[type='password']").first();
    await pwdInput.fill("marvin");
    await popup.screenshot({ path: `${SHOT_DIR}/02-mnemonic-typed.png` });

    // Continue
    const submit = popup.locator("button", { hasText: /^Continue$/ }).first();
    await submit.click();
    log("submitted import");
    await wait(3000);
    await popup.screenshot({ path: `${SHOT_DIR}/03-after-import.png` });
  } else {
    log("wallet already imported, continuing");
  }

  // Now we should be on Home. Verify the new UI elements.
  await wait(1500);
  await popup.screenshot({ path: `${SHOT_DIR}/04-home.png` });

  // Verify tabs exist with the icons
  const tabIcons = await popup.locator(".tab-icon").allInnerTexts();
  log("tab-icons rendered:", tabIcons);
  if (tabIcons.length < 5) {
    fail(`expected >=5 tab icons, got ${tabIcons.length}: ${tabIcons.join(",")}`);
  }

  // Verify header has lock + settings icon buttons
  const headerActions = await popup.locator(".header-actions .icon-btn").count();
  log("header icon buttons:", headerActions);
  if (headerActions < 2) {
    fail(`expected 2 header icon buttons (lock + settings), got ${headerActions}`);
  }

  // The settings tab must NOT be in the tabs row
  const tabLabels = await popup.locator(".tab-label").allInnerTexts();
  log("tab labels:", tabLabels);
  if (tabLabels.some((t) => /settings/i.test(t))) {
    fail("Settings appeared in tabs row — should be in header only");
  }

  // Click the Send tab and verify the new asset selector
  const sendTab = popup.locator(".tab", { hasText: /Send/i }).first();
  await sendTab.click();
  await wait(800);
  await popup.screenshot({ path: `${SHOT_DIR}/05-send-tab.png` });

  const assetSelect = popup.locator("select").first();
  await assetSelect.waitFor({ timeout: 3_000 });
  const optionCount = await assetSelect.locator("option").count();
  log("send: asset select options:", optionCount);
  if (optionCount < 1) {
    fail("Send tab has no asset options");
  }
  const firstOption = await assetSelect.locator("option").first().innerText();
  if (!/XCH/i.test(firstOption)) {
    fail(`first option should be XCH, got ${firstOption}`);
  }

  // Persistence: switch to NFTs tab, reload popup, verify NFTs still active.
  const nftTab = popup.locator(".tab", { hasText: /NFT/i }).first();
  await nftTab.click();
  await wait(500);
  await popup.screenshot({ path: `${SHOT_DIR}/06-nfts-tab.png` });

  log("reloading popup to test tab persistence…");
  await popup.reload();
  await popup.waitForLoadState("domcontentloaded");
  await wait(1500);
  await popup.screenshot({ path: `${SHOT_DIR}/07-after-reload.png` });

  const activeTab = await popup.locator(".tab.active").innerText();
  log("active tab after reload:", activeTab.replace(/\s+/g, " "));
  if (!/NFT/i.test(activeTab)) {
    fail(`tab did not persist across reload — expected NFTs, got ${activeTab}`);
  }

  // Settings icon: clicking it opens settings (no tab change).
  const settingsBtn = popup.locator(".header-actions .icon-btn").nth(1);
  await settingsBtn.click();
  await wait(500);
  const settingsBody = await popup.locator(".tab-body").innerText();
  await popup.screenshot({ path: `${SHOT_DIR}/08-settings.png` });
  log("settings body preview:", settingsBody.slice(0, 120).replace(/\s+/g, " "));

  // Verify Offer Inspector renders inside Settings.
  const offerTextarea = popup.locator("textarea").filter({ hasNotText: /./ }).first();
  // Click Settings (the icon was already clicked above) — now inspect the
  // textarea labelled with the offer1 placeholder.
  const placeholderMatch = await popup
    .locator("textarea[placeholder='offer1...']")
    .count();
  log("offer inspector textarea present:", placeholderMatch);
  if (placeholderMatch < 1) fail("OfferInspector textarea not rendered");

  // Submit a deliberately invalid offer string — engine should reject.
  await popup
    .locator("textarea[placeholder='offer1...']")
    .first()
    .fill("offer1xxxinvalid");
  await popup.locator("button", { hasText: /^Decode offer$/ }).first().click();
  await wait(800);
  const offerErr = await popup
    .locator(".error")
    .filter({ hasText: /decode_offer|InvalidParams|bech32|Invalid/i })
    .count();
  log("offer inspector error path:", offerErr);
  if (offerErr < 1) fail("OfferInspector did not surface decode error for bad string");

  // Suppress unused-variable warning
  void offerTextarea;

  await popup.screenshot({ path: `${SHOT_DIR}/09-offer-inspector.png` });

  log("ALL CHECKS PASSED");
  console.log(`Screenshots in: ${SHOT_DIR}`);
} catch (err) {
  console.error("[smoke] ERROR:", err);
  try {
    const pages = ctx.pages();
    for (const [i, p] of pages.entries()) {
      await p.screenshot({ path: `${SHOT_DIR}/err-${i}.png` }).catch(() => {});
    }
  } catch {}
  process.exit(1);
} finally {
  await ctx.close();
}
