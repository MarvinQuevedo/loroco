// Verify mempool-watch WS pipeline end-to-end.
//   1. Launch chromium with the built extension against /tmp/Loroco-PW-Shared
//      (persistent profile that already has a wallet imported).
//   2. Tail the SW console for [mempool-watch] / [Loroco/keepalive] lines.
//   3. Wait ~25s so the WS has time to open and receive at least one peak
//      or transaction event (mainnet block time ≈18s).
//   4. Read chrome.storage.local for store.mempool snapshot.
//   5. Screenshot the popup so we can eyeball the wallet state.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const EXT_PATH = resolve(repoRoot, "packages/extension/.output/chrome-mv3");
const USER_DATA = process.env.USER_DATA ?? "/tmp/Loroco-PW-MempoolWatch";
const SHOTS = resolve(repoRoot, "shots");
mkdirSync(SHOTS, { recursive: true });

console.log("▸ EXT_PATH:", EXT_PATH);
console.log("▸ USER_DATA:", USER_DATA);

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

const swLogs = [];
function attachLogger(sw, tag) {
  sw.on("console", (msg) => {
    const text = msg.text();
    swLogs.push({ ts: Date.now(), type: msg.type(), text, tag });
    console.log(`[SW/${tag}/${msg.type()}] ${text}`);
  });
}

let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15_000 });
const extId = sw.url().split("/")[2];
console.log("▸ extId:", extId);
attachLogger(sw, "sw0");

// SW may respawn during the test (alarm-triggered cold start). Attach a
// fresh logger to each new SW so we don't lose events.
let respawnCount = 0;
ctx.on("serviceworker", (next) => {
  respawnCount += 1;
  attachLogger(next, `sw${respawnCount}`);
  console.log(`[playwright] new serviceworker spawned (#${respawnCount})`);
});

// Open the popup so the keepalive port + UI render. We screenshot at the
// end; this also forces the SW to load active wallet / engine.
const popup = await ctx.newPage();
await popup.goto(`chrome-extension://${extId}/popup.html`);
await popup.waitForLoadState("domcontentloaded");
await new Promise((r) => setTimeout(r, 2000));

// Give the WS time to open + receive events. Chia mainnet block time ≈18s
// so a 60s window should catch at least one peak event + the 30s alarm fire.
const WAIT_MS = Number(process.env.WAIT_MS ?? 60_000);
console.log(`▸ Waiting ${WAIT_MS}ms for WS activity…`);
await new Promise((r) => setTimeout(r, WAIT_MS));

const mempoolState = await popup.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  const session = await chrome.storage.session.get(["mempoolWatchDebug"]);
  const alarms = await chrome.alarms.getAll();
  const coinKeys = Object.keys(all).filter((k) => k.startsWith("coins."));
  const out = {
    _bgBootCheck: all.bgBootCheck ?? null,
    _bgBootTrace: all.bgBootTrace ?? [],
    _bgTopLevelMark: all.bgTopLevelMark ?? null,
    _mempoolWatchStats: all.mempoolWatchStats ?? null,
    _alarms: alarms.map((a) => ({ name: a.name, periodInMinutes: a.periodInMinutes, scheduledTime: a.scheduledTime })),
    _debug: session.mempoolWatchDebug ?? [],
  };
  for (const k of coinKeys) {
    const s = all[k];
    out[k] = {
      mempool: s.mempool ?? null,
      pending_xch_count: Object.values(s.coins ?? {}).filter((c) => c.pending).length,
      pending_cat_count: Object.values(s.cats ?? {}).flatMap((cat) =>
        (cat.coins ?? []).filter((c) => c.pending),
      ).length,
    };
  }
  return out;
});

console.log("\n=== chrome.storage.local store.mempool ===");
console.log(JSON.stringify(mempoolState, null, 2));

// Filter SW log to mempool-watch lines for a tight summary.
const watchLogs = swLogs.filter((l) => l.text.includes("[mempool-watch]"));
console.log(`\n=== [mempool-watch] log lines (${watchLogs.length}) ===`);
for (const l of watchLogs) {
  console.log(`  ${new Date(l.ts).toISOString()} ${l.type} ${l.text}`);
}

console.log(`\n=== ALL captured SW logs (${swLogs.length}) ===`);
for (const l of swLogs) {
  console.log(`  ${new Date(l.ts).toISOString()} [${l.tag}/${l.type}] ${l.text.slice(0, 200)}`);
}

// Eval directly in the SW context to inspect runtime state.
const swProbe = await sw.evaluate(() => {
  return {
    hasWebSocket: typeof WebSocket !== "undefined",
    bgKeys: Object.keys(globalThis).filter((k) =>
      /mempool|ensure|tick|socket/i.test(k),
    ).slice(0, 30),
    runtimeId: chrome.runtime.id,
  };
}).catch((e) => ({ error: String(e) }));
console.log("\n=== SW global probe ===");
console.log(JSON.stringify(swProbe, null, 2));

// Try forcing a tick via SW eval.
try {
  await sw.evaluate(async () => {
    await chrome.storage.session.set({ swEvalPing: Date.now() });
  });
  const verify = await popup.evaluate(async () => {
    return (await chrome.storage.session.get("swEvalPing")).swEvalPing ?? null;
  });
  console.log("[swEvalPing]", verify);
} catch (e) {
  console.log("[swEval] failed:", e.message);
}

// Snapshot the popup so we can also eyeball UI state.
const shotPath = resolve(SHOTS, "pw-mempool-watch.png");
await popup.screenshot({ path: shotPath, fullPage: true });
console.log(`\n▸ screenshot: ${shotPath}`);

await ctx.close();
