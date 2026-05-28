// Live sync benchmark — non-headless so you can SEE the popup, with
// streaming output you can `tail -f` while it runs.
//
// Run:
//   node scripts/pw-sync-bench.mjs        # uses MNEMONIC from .env
//   FRESH=1 node scripts/pw-sync-bench.mjs # wipe profile before bench
//
// What you see:
//   • Chrome window opens at 0,0 (left of any external monitor) with the
//     popup tab at 380×680 — same size as the real extension popup.
//   • Each stage transition prints "[stage] xch / cats / nfts / done"
//   • Each chunk transition prints "[chunk] cats 3/9 · addrs 6..8 · from #N"
//   • Final block prints all timings + final totals.
//
// You can also tail the log live:
//   tail -f /tmp/bench-live.log

import { chromium } from "playwright";
import { mkdirSync, readFileSync, existsSync, rmSync, appendFileSync } from "node:fs";
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
const USER_DATA = "/tmp/Loroco-Bench";
const SHOT_DIR = "/tmp/loroco-bench";
const LIVE_LOG = "/tmp/bench-live.log";
const MNEMONIC =
  process.env.MNEMONIC ??
  "charge day cloth frame purpose lake method segment fat gadget regret open better rent visual picnic crater degree budget satoshi shop maple depart host";

if (process.env.FRESH === "1") {
  rmSync(USER_DATA, { recursive: true, force: true });
  rmSync(SHOT_DIR, { recursive: true, force: true });
}
mkdirSync(SHOT_DIR, { recursive: true });
try {
  // Truncate live log on each run so `tail -f` from the start makes sense.
  appendFileSync(LIVE_LOG, "", { flag: "w" });
} catch {}

function log(...args) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ` + args.join(" ");
  console.log(line);
  try {
    appendFileSync(LIVE_LOG, line + "\n");
  } catch {}
}

log("live log:", LIVE_LOG);
log("profile:", USER_DATA);

const ctx = await chromium.launchPersistentContext(USER_DATA, {
  headless: false,
  channel: "chromium",
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-position=0,0",
    "--window-size=600,820",
  ],
});

try {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
  const extId = sw.url().split("/")[2];
  log("ext id:", extId);

  // Service worker console — surfaces engine errors that would otherwise
  // be invisible (timeouts, parse failures, etc.).
  sw.on("console", (m) => {
    const t = m.text();
    if (/Loroco|coin-sync|scan_|error|warn/i.test(t)) {
      log("sw:", m.type(), t.slice(0, 200));
    }
  });

  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 680 });
  popup.on("pageerror", (e) => log("popup pageerror:", e.message));
  popup.on("console", (m) => {
    const t = m.text();
    if (/popup-heartbeat|error/i.test(t)) {
      log(`popup-console[${m.type()}]:`, t.slice(0, 160));
    }
  });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForLoadState("domcontentloaded");
  await wait(800);

  // If SIDECAR env var is set, turn on the local peer-sync daemon route in
  // the extension's settings. The extension persists this in
  // chrome.storage.local under "settings.sidecar"; coin-sync.ts checks it
  // each tick and falls back to coinset on any sidecar failure.
  if (process.env.SIDECAR === "1") {
    await popup.evaluate(async () => {
      await chrome.runtime.sendMessage({
        from: "popup",
        kind: "set-sidecar-settings",
        patch: { enabled: true, url: "http://127.0.0.1:8765" },
      });
    });
    log("sidecar route ENABLED for this bench");
  }

  if (/Import|Create/i.test(await popup.locator("body").innerText())) {
    log("importing mnemonic");
    const importBtn = popup.locator("button", { hasText: /Import mnemonic/i }).first();
    if (await importBtn.isVisible().catch(() => false)) await importBtn.click();
    await wait(400);
    await popup.locator("textarea").first().fill(MNEMONIC);
    await popup.locator("input[type='password']").first().fill("marvin");
    await popup.locator("button", { hasText: /^Continue$/ }).first().click();
    await wait(3500);
  } else {
    log("wallet already imported (using persisted profile)");
  }

  // Resilient telemetry fetch — single transient failure shouldn't kill the
  // bench (Chrome MV3 SW can disappear momentarily during heavy WASM work).
  const fetchTelemetry = async () => {
    try {
      return await popup.evaluate(async () => {
        const res = await chrome.runtime.sendMessage({
          from: "popup",
          kind: "get-coin-sync-telemetry",
        });
        return res?.ok ? res.value : null;
      });
    } catch (e) {
      log("telemetry blip:", String(e).slice(0, 120));
      return null;
    }
  };

  // Force a sync; if it fails (SW churn), try again on the next tick.
  const triggerForce = async () => {
    try {
      await popup.evaluate(() =>
        chrome.runtime.sendMessage({ from: "popup", kind: "force-coin-sync" }),
      );
    } catch (e) {
      log("force-sync blip:", String(e).slice(0, 120));
    }
  };
  await triggerForce();
  log("kicked force-sync");

  // Track stage + per-stage progress transitions. Print on every change.
  const stageStart = new Map();
  const stageEnd = new Map();
  let prevStage = null;
  let prevDetail = { xch: "", cats: "", nfts: "" };
  const benchStart = Date.now();

  // Up to 20 minutes wallclock (2400 × 500ms). The SW dies at ~60s in MV3,
  // re-spawns on alarm, picks up cursors and continues. We poll silently
  // through any blips (the popup may briefly become unresponsive when the
  // SW recycles).
  let lastForcedAt = Date.now();
  for (let i = 0; i < 2400; i += 1) {
    const t = await fetchTelemetry();
    if (!t) {
      await wait(500);
      continue;
    }

    const s = t.stage;
    if (s !== prevStage) {
      if (prevStage && !stageEnd.has(prevStage)) {
        stageEnd.set(prevStage, Date.now());
      }
      if (!stageStart.has(s)) stageStart.set(s, Date.now());
      const elapsed = ((Date.now() - benchStart) / 1000).toFixed(1);
      log(`[+${elapsed}s] stage → ${s}` +
        (s === "done"
          ? ` (xch=${t.totals.xch_coins} cats=${t.totals.cat_assets} nfts=${t.totals.nfts})`
          : ""));
      prevStage = s;
    }

    // Per-stage chunk-level transitions (detail string changes).
    for (const stage of ["xch", "cats", "nfts"]) {
      const p = t.stage_progress[stage];
      const d = `${p.done}/${p.total} ${p.detail ?? ""}`.trim();
      if (d !== prevDetail[stage] && (p.total > 0 || p.detail)) {
        prevDetail[stage] = d;
        if (p.done > 0 || p.detail) {
          log(`  ${stage.padEnd(4)} ${p.done}/${p.total} ` +
            (p.detail ? "· " + p.detail : "") +
            (p.found != null ? ` · ${p.found} found` : "") +
            (p.last_warning ? ` · WARN: ${p.last_warning.slice(0, 60)}` : ""));
        }
      }
    }

    if (s === "done") {
      stageEnd.set("done", Date.now());
      break;
    }

    // If we've been idle for 60s+ AND not in scanning state, nudge the SW.
    if (
      s !== "xch" && s !== "cats" && s !== "nfts" && s !== "deriving" &&
      Date.now() - lastForcedAt > 60_000
    ) {
      lastForcedAt = Date.now();
      log("no progress for 60s, re-kicking force-sync");
      await triggerForce();
    }

    await wait(500);
  }
  const benchEnd = Date.now();

  log("================= TIMINGS =================");
  for (const stage of ["deriving", "xch", "cats", "nfts", "done"]) {
    if (!stageStart.has(stage)) {
      log(`  ${stage.padEnd(10)}  (skipped)`);
      continue;
    }
    const start = stageStart.get(stage);
    const end = stageEnd.get(stage) ?? Date.now();
    log(`  ${stage.padEnd(10)}  ${((end - start) / 1000).toFixed(2)}s`);
  }
  log(`  total      ${((benchEnd - benchStart) / 1000).toFixed(2)}s`);

  const final = await fetchTelemetry();
  if (final) {
    log("final totals:", JSON.stringify(final.totals));
    log(
      "stage progress final:",
      JSON.stringify({
        xch: final.stage_progress.xch.done + "/" + final.stage_progress.xch.total,
        cats: final.stage_progress.cats.done + "/" + final.stage_progress.cats.total,
        nfts: final.stage_progress.nfts.done + "/" + final.stage_progress.nfts.total,
      }),
    );
    if (final.last_error) log("last error:", final.last_error);
  }

  await popup.screenshot({ path: `${SHOT_DIR}/final.png` }).catch(() => {});
  log("DONE. Keeping browser open for 30s so you can poke around the popup.");
  await wait(30_000);
} catch (err) {
  log("FATAL:", String(err).slice(0, 300));
} finally {
  await ctx.close().catch(() => {});
}
