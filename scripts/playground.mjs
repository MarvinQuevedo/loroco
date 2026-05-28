// Loroco Playground launcher.
//
// Serves scripts/playground/index.html on http://127.0.0.1:<PORT> (the content
// script injects on <all_urls> http origins but NOT on file://, so we need a
// real http origin) and launches Chrome — DETACHED — with the built extension
// loaded unpacked. Chrome stays open after this script exits; close the window
// when you're done.
//
// Usage:
//   pnpm build:fast           # make sure .output/chrome-mv3 is current
//   node scripts/playground.mjs
//
// Env:
//   PORT     http port (default 8137)
//   PROFILE  persistent Chrome profile dir (default ./.chrome-profile — reuses
//            an already-imported wallet so you don't re-import each run)

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// Stable Google Chrome (≥137) blocks the --load-extension command-line switch
// for security, so the extension never gets enabled. We prefer "Chrome for
// Testing" (shipped with Playwright), which still honours --load-extension.
// Resolution order: CHROME_BIN env → Chrome for Testing → installed Chrome.
function resolveChrome() {
  if (process.env.CHROME_BIN) return { bin: process.env.CHROME_BIN, forTesting: false };
  try {
    const { chromium } = require("playwright");
    const p = chromium.executablePath();
    if (p && existsSync(p)) return { bin: p, forTesting: true };
  } catch {}
  const installed =
    process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : process.platform === "win32"
        ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
        : "google-chrome";
  return { bin: installed, forTesting: false };
}
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const buildDir = join(repoRoot, "packages/extension/.output/chrome-mv3");
const htmlFile = join(here, "playground", "index.html");
// Default to the Chrome-for-Testing profile the pw-* suite already uses — it's
// CfT-native (a stable-Chrome profile can't be opened by an older CfT build)
// and usually already has the test wallet imported + synced.
const profileDir = process.env.PROFILE ?? "/tmp/Loroco-PW-Shared";
const PORT = Number(process.env.PORT ?? 8137);

if (!existsSync(buildDir)) {
  console.error(`\n❌ No build at ${buildDir}\n   Run "pnpm build:fast" first.\n`);
  process.exit(1);
}
if (!existsSync(htmlFile)) {
  console.error(`\n❌ Missing playground HTML at ${htmlFile}\n`);
  process.exit(1);
}

// Tiny static server — just the one HTML file.
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(readFileSync(htmlFile));
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}/`;
  const { bin: chromePath, forTesting } = resolveChrome();

  const args = [
    `--load-extension=${buildDir}`,
    `--disable-extensions-except=${buildDir}`,
    // Re-enable the load-extension switch on stable Chrome ≥137.
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1400,900",
    url,
    ...process.argv.slice(2),
  ];

  console.log(`▸ Playground:  ${url}`);
  console.log(`▸ Extension:   ${buildDir}`);
  console.log(`▸ Profile:     ${profileDir} (persistent — keeps your wallet)`);
  console.log(`▸ Chrome:      ${chromePath}${forTesting ? "  (Chrome for Testing — allows --load-extension)" : ""}\n`);
  if (!forTesting) {
    console.log("⚠ Using installed Chrome. If the extension still doesn't enable,");
    console.log("  run `pnpm exec playwright install chromium` and re-run — it ships a");
    console.log("  Chrome-for-Testing build that honours --load-extension.\n");
  }
  console.log("Chrome will open detached and stay up. Steps:");
  console.log("  1. Unlock / import the wallet in the Loroco popup (toolbar).");
  console.log("  2. On the playground page click Connect → Approve in the popup.");
  console.log("  3. Use 'Run all reads' for a quick sweep, or call endpoints one by one.\n");
  console.log("Ctrl-C here just stops the static server; close the Chrome window to finish.\n");

  const proc = spawn(chromePath, args, { stdio: "inherit", detached: true });
  proc.unref();
});
