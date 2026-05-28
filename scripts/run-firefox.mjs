// Launch Firefox Developer Edition with the Loroco firefox-mv2 build loaded
// as a temporary extension. Uses web-ext under the hood so reloads and
// browser-console logging work.
//
// Usage:
//   pnpm --filter @ozone/extension build:firefox
//   node scripts/run-firefox.mjs                # opens about:debugging
//   node scripts/run-firefox.mjs https://dexie.space  # plus a target page
//
// Env overrides:
//   FIREFOX_BIN  full path to firefox binary (default: Dev Edition macOS)
//   PROFILE      profile dir for state persistence (default: ephemeral)

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const EXT_DIR = resolve(
  new URL(".", import.meta.url).pathname,
  "..",
  "packages/extension/.output/firefox-mv2",
);

if (!existsSync(EXT_DIR)) {
  console.error(`Build first: pnpm --filter @ozone/extension build:firefox`);
  console.error(`Missing: ${EXT_DIR}`);
  process.exit(1);
}

const FIREFOX_BIN =
  process.env.FIREFOX_BIN ??
  "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox";

if (!existsSync(FIREFOX_BIN)) {
  console.error(`Firefox binary not found: ${FIREFOX_BIN}`);
  console.error(`Install:  brew install --cask firefox@developer-edition`);
  console.error(`Or set FIREFOX_BIN to your firefox path.`);
  process.exit(1);
}

const startUrls = [
  "about:debugging#/runtime/this-firefox",
  ...process.argv.slice(2),
];

const args = [
  "run",
  "--source-dir", EXT_DIR,
  "--firefox", FIREFOX_BIN,
  "--browser-console",
  ...startUrls.flatMap((u) => ["--start-url", u]),
];

if (process.env.PROFILE) {
  args.push("--firefox-profile", process.env.PROFILE, "--keep-profile-changes");
}

console.log("[firefox] ext:", EXT_DIR);
console.log("[firefox] bin:", FIREFOX_BIN);
console.log("[firefox] urls:", startUrls.join(" · "));

const child = spawn("web-ext", args, { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
