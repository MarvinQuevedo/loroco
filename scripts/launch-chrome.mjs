#!/usr/bin/env node
// Launches a fresh Chrome session with the built Loroco extension loaded
// unpacked. Uses a per-repo profile directory so it doesn't touch your
// daily browsing profile. Run `pnpm build` first (or use `pnpm start`).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const buildDir = join(repoRoot, "packages/extension/.output/chrome-mv3");
const profileDir = join(repoRoot, ".chrome-profile");

if (!existsSync(buildDir)) {
  console.error(`\n❌ No build found at:\n   ${buildDir}\n`);
  console.error(`Run "pnpm build" first, or use "pnpm start" to build + launch.\n`);
  process.exit(1);
}

const chromePath =
  process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : process.platform === "win32"
      ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      : "google-chrome";

const extraArgs = process.argv.slice(2);

const args = [
  `--load-extension=${buildDir}`,
  `--user-data-dir=${profileDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  ...extraArgs,
];

console.log(`▸ Loading extension: ${buildDir}`);
console.log(`▸ Profile dir:       ${profileDir} (persistent)`);
console.log(`▸ Chrome:            ${chromePath}\n`);

const proc = spawn(chromePath, args, {
  stdio: "inherit",
  detached: true,
});
proc.unref();
