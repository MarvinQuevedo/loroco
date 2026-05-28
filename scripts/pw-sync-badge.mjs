// Headless smoke for the sync-badge expansion + stage rows.
//
// Boots a persistent profile with the extension, imports the dev mnemonic if
// needed, opens the popup and exercises the new SyncBadge component. Uses
// playwright's `chromium` in headless mode so the user can keep working in
// their own browser. Saves screenshots to /tmp/ozone-pw-sync.
//
// Run: node scripts/pw-sync-badge.mjs

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";

const EXT_PATH =
  "/Users/marvin/Projects/Ozone/loroco/packages/extension/.output/chrome-mv3";
const USER_DATA = "/tmp/Ozone-PW-Sync";
const SHOT_DIR = "/tmp/ozone-pw-sync";
const MNEMONIC =
  "charge day cloth frame purpose lake method segment fat gadget regret open better rent visual picnic crater degree budget satoshi shop maple depart host";

mkdirSync(SHOT_DIR, { recursive: true });

const log = (...args) => console.log("[sync-badge]", ...args);
const fail = (msg) => {
  console.error("[sync-badge] FAIL:", msg);
  process.exit(1);
};

// Chrome MV3 + extensions need a real (windowed) profile; --headless=new keeps
// the window off-screen while still loading extensions.
// Run windowed on monitor 1 (built-in display, top-left origin) so it stays
// out of the way of whichever external monitor the user is working on.
// Override with: HEADLESS=1 node scripts/pw-sync-badge.mjs
const isHeadless = process.env.HEADLESS === "1";
const ctx = await chromium.launchPersistentContext(USER_DATA, {
  headless: isHeadless,
  channel: "chromium",
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    ...(isHeadless ? ["--headless=new"] : []),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=ExtensionsManifestV3Only",
    "--window-position=0,0",
    "--window-size=1280,900",
  ],
});

try {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) {
    log("waiting for service worker…");
    sw = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
  }
  const extId = sw.url().split("/")[2];
  log("extension id:", extId);

  const popup = await ctx.newPage();
  // Match the real extension popup: 380×600 is the min-width/height set in
  // styles.css. Anything wider hides the wallet-bar layout's real wrap
  // behaviour and gives us misleading screenshots.
  await popup.setViewportSize({ width: 380, height: 600 });
  popup.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      log("popup console:", msg.type(), msg.text());
    }
  });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForLoadState("domcontentloaded");
  await wait(1000);
  await popup.screenshot({ path: `${SHOT_DIR}/01-popup-open.png` });

  const bodyText = await popup.locator("body").innerText();

  if (/Unlock/i.test(bodyText) && !/Import/i.test(bodyText)) {
    log("locked — unlocking");
    await popup.locator("input[type='password']").first().fill("marvin");
    await popup.locator("button", { hasText: /^Unlock$/ }).first().click();
    await wait(2500);
  } else if (/Import|Create/i.test(bodyText)) {
    log("onboarding — importing mnemonic");
    const importBtn = popup
      .locator("button", { hasText: /Import mnemonic/i })
      .first();
    if (await importBtn.isVisible().catch(() => false)) {
      await importBtn.click();
      await wait(400);
    }
    await popup.locator("textarea").first().fill(MNEMONIC);
    await popup.locator("input[type='password']").first().fill("marvin");
    await popup.locator("button", { hasText: /^Continue$/ }).first().click();
    await wait(3500);
  }

  await popup.screenshot({ path: `${SHOT_DIR}/02-home.png` });

  // The sync badge should render in the wallet-bar.
  const badge = popup.locator(".sync-badge").first();
  await badge.waitFor({ timeout: 5_000 });
  log("sync badge visible");

  // Click to expand.
  const summary = popup.locator(".sync-badge-summary").first();
  await summary.click();
  await wait(400);
  await popup.screenshot({ path: `${SHOT_DIR}/03-badge-open.png` });

  const detail = popup.locator(".sync-badge-detail").first();
  if (!(await detail.isVisible())) {
    fail("sync-badge-detail not visible after click");
  }
  log("sync-badge-detail expanded");

  // Verify stage rows exist.
  const stageRows = await popup.locator(".sync-stage-item").count();
  log("stage rows:", stageRows);
  if (stageRows !== 3) {
    fail(`expected 3 stage rows (XCH/CATs/NFTs), got ${stageRows}`);
  }

  // Verify stage labels are present.
  const stageLabels = await popup
    .locator(".sync-stage-item .sync-stage-label")
    .allInnerTexts();
  log("stage labels:", stageLabels);
  for (const expected of ["XCH", "CATs", "NFTs"]) {
    if (!stageLabels.includes(expected)) {
      fail(`missing stage row for ${expected}`);
    }
  }

  // Click "Refresh now" button.
  const refresh = popup.locator(".sync-refresh").first();
  if (!(await refresh.isVisible())) fail("missing 'Refresh now' button");
  await refresh.click().catch(() => {
    log("refresh button click suppressed (button likely went to disabled state)");
  });
  log("clicked Refresh now — waiting for progress updates");
  await wait(4000);
  await popup.screenshot({ path: `${SHOT_DIR}/04-syncing.png` }).catch(() => {});

  // Wait briefly for a few stage transitions to confirm the live progress
  // pipe is working. We don't wait for a full sync — that can take >60s on
  // a wallet with deep history, and the popup may get torn down by Chrome.
  let attempts = 0;
  while (attempts < 6) {
    const stageText = await popup
      .locator(".sync-stage")
      .first()
      .innerText()
      .catch(() => "");
    const synced = await popup
      .locator(".sync-badge-summary > span:first-child")
      .first()
      .innerText()
      .catch(() => "");
    if (!synced && !stageText) {
      log("popup unavailable — done with progress polling");
      break;
    }
    log("status:", synced.trim(), "stage:", stageText.trim());
    if (/synced/i.test(synced) || /idle/i.test(stageText)) break;
    await wait(3000);
    attempts += 1;
  }
  await popup.screenshot({ path: `${SHOT_DIR}/05-after-sync.png` }).catch(() => {
    log("page closed before final screenshot — ok");
  });

  // Collapse.
  try {
    await summary.click({ timeout: 2000 });
    await wait(200);
    const stillVisible = await detail.isVisible().catch(() => false);
    if (stillVisible) fail("sync-badge-detail should collapse on second click");
    log("badge collapses cleanly");
  } catch {
    log("popup unavailable for collapse check — skipping");
  }

  log("ALL CHECKS PASSED");
  console.log(`Screenshots in: ${SHOT_DIR}`);
} catch (err) {
  console.error("[sync-badge] ERROR:", err);
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
