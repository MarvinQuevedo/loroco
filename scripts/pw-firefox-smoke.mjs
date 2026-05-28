// Firefox smoke test for the Loroco dApp surface.
//
// Uses geckodriver + selenium-webdriver to drive Firefox Developer Edition
// because Playwright can't sideload unsigned extensions in its bundled
// Firefox. Geckodriver speaks Mozilla's `moz/addon/install` endpoint
// natively, which is the same path web-ext uses interactively.
//
// What it verifies, on https://example.com/:
//   • window.loroco exists and has .request()
//   • chia_chainId via window.loroco.request() reaches the SW
//     (returns 4001 "not connected" — proves the alias resolved instead
//     of being rejected as MethodNotFound 4004, which was the previous
//     bug when legacyGoby=false)
//   • chip0002_chainId likewise
//   • canonical chainId likewise
//
// Smoke only. The full interactive flow (popup approval, signing, offers)
// is exercised by the Chromium pw-* suite — Firefox here is a parallel
// surface check that the dApp-facing window.loroco contract works.
//
// Usage:
//   pnpm --filter @ozone/extension build:firefox
//   node scripts/pw-firefox-smoke.mjs
//
// Env:
//   FIREFOX_BIN  path to firefox binary (default: Dev Edition macOS)
//   HEADLESS     '1' for headless (default headed for visual debug)

import { Builder } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(new URL(".", import.meta.url).pathname, "..");
// firefox-mv3 keeps the chrome.action.* API; firefox-mv2 would need a
// browserAction shim. We default to mv3 because Loroco's background code
// already targets the MV3 surface.
const EXT_DIR = resolve(
  REPO,
  process.env.FF_BUILD === "mv2"
    ? "packages/extension/.output/firefox-mv2"
    : "packages/extension/.output/firefox-mv3",
);
const FIREFOX_BIN =
  process.env.FIREFOX_BIN ??
  "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox";

if (!existsSync(EXT_DIR)) {
  console.error(`Missing: ${EXT_DIR}`);
  console.error(`Build first: pnpm --filter @ozone/extension build:firefox`);
  process.exit(1);
}
if (!existsSync(FIREFOX_BIN)) {
  console.error(`Firefox binary not found: ${FIREFOX_BIN}`);
  console.error(`Install: brew install --cask firefox@developer-edition`);
  process.exit(1);
}

console.log("[ff-smoke] ext:", EXT_DIR);
console.log("[ff-smoke] bin:", FIREFOX_BIN);

const opts = new firefox.Options()
  .setBinary(FIREFOX_BIN)
  // Required so Firefox accepts an unsigned, sideloaded extension.
  .setPreference("xpinstall.signatures.required", false)
  .setPreference("extensions.experiments.enabled", true)
  // Skip first-run distractions.
  .setPreference("browser.startup.homepage", "about:blank")
  .setPreference("browser.aboutwelcome.enabled", false)
  .setPreference("datareporting.policy.firstRunURL", "");

if (process.env.HEADLESS === "1") opts.addArguments("-headless");

const driver = await new Builder()
  .forBrowser("firefox")
  .setFirefoxOptions(opts)
  .build();

let failed = false;
try {
  // installAddon takes either a path to an .xpi OR a path to an unpacked
  // extension directory. We pass the WXT-built firefox-mv2/ as a
  // temporary install — survives until the session ends.
  const addonId = await driver.installAddon(EXT_DIR, true);
  console.log("[ff-smoke] addon installed, id:", addonId);

  // Give the background script a beat to spawn and the content script
  // a beat to inject on first navigation.
  await driver.sleep(2500);
  await driver.get("https://example.com/");
  await driver.sleep(1500);

  const probe = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    (async () => {
      const hasLoroco = typeof window.loroco !== "undefined";
      const lorocoIsObj = typeof window.loroco?.request === "function";
      if (!lorocoIsObj) return done({ hasLoroco, lorocoIsObj });
      const probe = async (m) =>
        window.loroco.request({ method: m })
          .then((r) => ({ ok: true, result: r }))
          .catch((e) => ({ ok: false, code: e?.code, msg: e?.message }));
      const chia = await probe("chia_chainId");
      const chip = await probe("chip0002_chainId");
      const canon = await probe("chainId");
      done({ hasLoroco, lorocoIsObj, chia, chip, canon });
    })();
  `);

  console.log("[ff-smoke] probe:", JSON.stringify(probe, null, 2));

  // A successful smoke = the methods resolve to the SW. 4001 "not connected"
  // is the expected response when example.com isn't a connected origin —
  // proves the alias dispatched correctly. 4004 means the alias table is
  // broken (the legacy-Goby gating bug we already fixed).
  const aliasDispatched = (r) =>
    r?.ok === true || (r?.ok === false && r?.code === 4001);

  const held =
    probe.hasLoroco === true &&
    probe.lorocoIsObj === true &&
    aliasDispatched(probe.chia) &&
    aliasDispatched(probe.chip) &&
    aliasDispatched(probe.canon);

  if (held) {
    console.log(
      "[ff-smoke] ✓ PASS — Loroco surface reachable in Firefox; chia_/chip0002_/canonical all dispatch",
    );
  } else {
    console.log("[ff-smoke] ✗ FAIL — see probe above");
    failed = true;
  }
} catch (err) {
  console.error("[ff-smoke] error:", err?.message ?? err);
  failed = true;
} finally {
  await driver.quit();
  process.exit(failed ? 1 : 0);
}
