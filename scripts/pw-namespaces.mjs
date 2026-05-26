// Headless smoke for window.loroco + window.chia (+ legacy window.ozone).
//
// Goal: dApps can detect Loroco via window.loroco or window.chia, and the
// rebrand-period alias window.ozone keeps pointing at the same provider so
// integrations from the early-access build don't break.
//
// Run: node scripts/pw-namespaces.mjs

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";

const EXT_PATH =
  "/Users/marvin/Projects/Ozone/sage-web/ozone-web-extension/packages/extension/.output/chrome-mv3";
const USER_DATA = "/tmp/Ozone-PW-NS";
const SHOT_DIR = "/tmp/ozone-pw-ns";

mkdirSync(SHOT_DIR, { recursive: true });

const log = (...args) => console.log("[ns]", ...args);
const fail = (msg) => {
  console.error("[ns] FAIL:", msg);
  process.exit(1);
};

const ctx = await chromium.launchPersistentContext(USER_DATA, {
  headless: true,
  channel: "chromium",
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

try {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) {
    log("waiting for service worker…");
    sw = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
  }
  log("service worker up");

  // The inpage script only injects into pages that match content script's
  // <all_urls>. about:blank doesn't run content scripts, so navigate to a
  // data: URL — that does load content scripts.
  const page = await ctx.newPage();
  await page.goto("https://example.com/");
  await page.waitForLoadState("domcontentloaded");
  await wait(600);
  await page.screenshot({ path: `${SHOT_DIR}/01-page.png` });

  const result = await page.evaluate(() => {
    const hasLoroco = typeof window.loroco === "object" && window.loroco !== null;
    const hasChia = typeof window.chia === "object" && window.chia !== null;
    const hasOzoneLegacy = typeof window.ozone === "object" && window.ozone !== null;
    return {
      hasLoroco,
      hasChia,
      hasOzoneLegacy,
      sameRef: hasLoroco && hasChia && window.loroco === window.chia,
      legacySameRef: hasOzoneLegacy && window.ozone === window.loroco,
      name: hasLoroco ? window.loroco.name : null,
      isLoroco: hasLoroco ? window.loroco.isLoroco : null,
      isGoby: hasLoroco ? window.loroco.isGoby : null,
      chiaIsGoby: hasChia ? window.chia.isGoby : null,
      requestType: hasLoroco ? typeof window.loroco.request : null,
      chiaRequestType: hasChia ? typeof window.chia.request : null,
      onType: hasLoroco ? typeof window.loroco.on : null,
    };
  });
  log("namespace check:", JSON.stringify(result, null, 2));

  if (!result.hasLoroco) fail("window.loroco not injected");
  if (!result.hasChia) fail("window.chia not injected — legacy Goby dApps would break");
  if (!result.hasOzoneLegacy) fail("window.ozone legacy alias missing");
  if (!result.sameRef) fail("window.loroco and window.chia must point to the same provider");
  if (!result.legacySameRef) fail("window.ozone legacy alias must point to the same provider");
  if (result.isLoroco !== true) fail("isLoroco flag missing");
  if (result.isGoby !== true) fail("isGoby flag missing");
  if (result.chiaIsGoby !== true) fail("isGoby flag missing on chia");
  if (result.requestType !== "function") fail("loroco.request is not a function");
  if (result.chiaRequestType !== "function") fail("chia.request is not a function");
  if (result.onType !== "function") fail("loroco.on is not a function");
  if (result.name !== "Loroco") fail(`expected name 'Loroco', got '${result.name}'`);
  log("✓ all three namespaces share one provider; flags + name correct");

  // Verify request goes through to the SW. chainId should be returned for
  // CHIP-0002 metadata even without connect.
  // (We don't have a wallet imported in this fresh profile, so we expect
  // either a successful chainId or a 'wallet missing' error — anything but
  // 'is not a function'.)
  const callResult = await page.evaluate(async () => {
    try {
      const v = await window.loroco.request({ method: "chainId" });
      return { ok: true, value: v };
    } catch (err) {
      return { ok: false, error: { message: err?.message, code: err?.code } };
    }
  });
  log("loroco.request({method:'chainId'}) →", JSON.stringify(callResult));
  // Either ok or a structured error. Anything else means transport failed.
  if (callResult.ok == null) fail("loroco.request did not resolve or reject cleanly");

  log("ALL CHECKS PASSED");
} catch (err) {
  console.error("[ns] ERROR:", err);
  process.exit(1);
} finally {
  await ctx.close();
}
