// Manual test launcher — opens Chromium with the Loroco extension loaded,
// sidecar route enabled, and (if FRESH=1) the bench mnemonic imported.
// The browser stays open until you close it manually.
//
// Run:
//   node scripts/pw-manual.mjs              # use saved profile (Loroco-Manual)
//   FRESH=1 node scripts/pw-manual.mjs      # wipe profile + import .env mnemonic
//   NO_SIDECAR=1 node scripts/pw-manual.mjs # disable sidecar route
//
// Make sure the sidecar is running first:
//   /Users/marvin/Projects/Ozone/loroco-local-sync/target/release/loroco-local-sync

import { chromium } from "playwright";
import { mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";

const ENV_PATH = "/Users/marvin/Projects/Ozone/loroco/.env";
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

const EXT_PATH =
  "/Users/marvin/Projects/Ozone/loroco/packages/extension/.output/chrome-mv3";
const USER_DATA = "/tmp/Loroco-Manual";
const MNEMONIC =
  process.env.MNEMONIC ??
  "charge day cloth frame purpose lake method segment fat gadget regret open better rent visual picnic crater degree budget satoshi shop maple depart host";

if (process.env.FRESH === "1") {
  rmSync(USER_DATA, { recursive: true, force: true });
}
mkdirSync(USER_DATA, { recursive: true });

console.log("[manual] profile:", USER_DATA);
console.log("[manual] launching Chromium with extension…");

const ctx = await chromium.launchPersistentContext(USER_DATA, {
  headless: false,
  channel: "chromium",
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,900",
  ],
});

let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
const extId = sw.url().split("/")[2];
console.log("[manual] extension id:", extId);
console.log(`[manual] popup URL: chrome-extension://${extId}/popup.html`);

// SW lifecycle tracker. Playwright doesn't surface SW destroyed events well,
// but each NEW serviceworker event = a revival. Re-subscribe to console on
// every revival so we see all SW lifecycle, not just the first one.
const attachSwLogs = (worker, label) => {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [sw-lifecycle] ${label} (url=${worker.url().slice(-40)})`);
  worker.on("console", (m) => {
    const t = m.text();
    if (/Loroco|coin-sync|scan_|error|warn|sidecar|keepalive|panic/i.test(t)) {
      const ts2 = new Date().toISOString().slice(11, 19);
      console.log(`[${ts2}] [sw ${m.type()}]`, t.slice(0, 220));
    }
  });
  // Capture ANY uncaught error/rejection — these are the silent SW killers.
  worker.on("pageerror", (err) => {
    const ts2 = new Date().toISOString().slice(11, 19);
    console.log(`[${ts2}] [sw PAGEERROR]`, String(err).slice(0, 400));
  });
  worker.on("crash", () => {
    const ts2 = new Date().toISOString().slice(11, 19);
    console.log(`[${ts2}] [sw CRASH]`);
  });
};
attachSwLogs(sw, "INITIAL");
ctx.on("serviceworker", (worker) => attachSwLogs(worker, "REVIVAL"));

const popup = await ctx.newPage();
await popup.setViewportSize({ width: 380, height: 680 });
await popup.goto(`chrome-extension://${extId}/popup.html`);
await popup.waitForLoadState("domcontentloaded");
await wait(800);

// Enable sidecar unless explicitly disabled.
if (process.env.NO_SIDECAR !== "1") {
  await popup.evaluate(async () => {
    await chrome.runtime.sendMessage({
      from: "popup",
      kind: "set-sidecar-settings",
      patch: { enabled: true, url: "http://127.0.0.1:8765" },
    });
  });
  console.log("[manual] sidecar route ENABLED (http://127.0.0.1:8765)");
} else {
  console.log("[manual] sidecar route DISABLED (NO_SIDECAR=1)");
}

if (process.env.FRESH === "1") {
  const bodyText = await popup.locator("body").innerText();
  if (/Import|Create/i.test(bodyText)) {
    console.log("[manual] importing bench mnemonic…");
    const importBtn = popup.locator("button", { hasText: /Import mnemonic/i }).first();
    if (await importBtn.isVisible().catch(() => false)) await importBtn.click();
    await wait(400);
    await popup.locator("textarea").first().fill(MNEMONIC);
    await popup.locator("input[type='password']").first().fill("marvin");
    await popup.locator("button", { hasText: /^Continue$/ }).first().click();
    await wait(3500);
    console.log("[manual] wallet imported, sync should be running");
  }
} else {
  // Saved profile: detect the unlock screen and enter the bench password
  // automatically so tickCoinSync has masterPublicKey and actually scans.
  // Without this, the SW stays alive but bails every tick.
  const bodyText = await popup.locator("body").innerText().catch(() => "");
  if (/Unlock|password/i.test(bodyText)) {
    console.log("[manual] wallet is locked — entering bench password");
    try {
      await popup.locator("input[type='password']").first().fill("marvin");
      const unlockBtn = popup.locator("button", { hasText: /Unlock|Continue/i }).first();
      await unlockBtn.click();
      await wait(2500);
      console.log("[manual] unlocked, sync should run on next alarm");
    } catch (e) {
      console.log("[manual] unlock failed:", String(e).slice(0, 120));
    }
  } else {
    console.log("[manual] using saved profile (no lock screen detected)");
  }
}

// Open dexie + tibetswap tabs for dApp testing if requested.
if (process.env.DAPPS === "1") {
  console.log("[manual] opening dexie + tibetswap…");
  try {
    const dexie = await ctx.newPage();
    await dexie.goto("https://dexie.space/", { waitUntil: "domcontentloaded" });
    console.log("[manual]   dexie.space opened");
  } catch (e) {
    console.log("[manual]   dexie failed:", String(e).slice(0, 100));
  }
  try {
    const tibet = await ctx.newPage();
    await tibet.goto("https://v2.tibetswap.io/", { waitUntil: "domcontentloaded" });
    console.log("[manual]   v2.tibetswap.io opened");
  } catch (e) {
    console.log("[manual]   tibetswap failed:", String(e).slice(0, 100));
  }
}

console.log("");
console.log("=".repeat(60));
console.log("Browser is open. Test the popup manually.");
console.log("Press Ctrl+C in this terminal to close.");
console.log("=".repeat(60));

// Block forever — exit by closing browser or Ctrl+C.
await new Promise(() => {});
