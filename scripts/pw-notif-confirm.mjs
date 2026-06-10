// Verify the confirmation-based notification actually fires from coin-sync.
//
// Spies on chrome.notifications.create in the service worker, does a tiny XCH
// self-send (which marks our coin pending), then waits for the peak-triggered
// coin-sync to detect the coin confirm-spent and fire the "Transaction
// confirmed" notification — proving the no-polling notification path works.
//
//   set -a; . ./.env; set +a
//   USER_DATA=$USER_DATA PASSWORD=$PASSWORD MNEMONIC="$MNEMONIC" node scripts/pw-notif-confirm.mjs

import { chromium } from "playwright";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = resolve(ROOT, "packages/extension/.output/chrome-mv3");
const USER_DATA = process.env.USER_DATA ?? "/tmp/Loroco-PW-Real";
const PASSWORD = process.env.PASSWORD ?? "marvin";
const log = (...a) => console.log("[notif-confirm]", ...a);

const ctx = await chromium.launchPersistentContext(USER_DATA, {
  headless: false,
  channel: "chromium",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run", "--window-position=-2400,0", "--window-size=420,720"],
});

try {
  let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
  const id = sw.url().split("/")[2];
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 400, height: 700 });
  await p.goto(`chrome-extension://${id}/popup.html`);
  await wait(4000);
  const pw = p.locator("input[type='password']").first();
  if (await pw.isVisible().catch(() => false)) {
    await pw.fill(PASSWORD);
    await pw.press("Enter");
    await wait(2500);
  }

  // Spy on notifications.
  await sw.evaluate(() => {
    globalThis.__notifs = [];
    const orig = chrome.notifications.create;
    chrome.notifications.create = function (...args) {
      try { globalThis.__notifs.push({ id: args[0], opt: args[1] }); } catch {}
      return orig.apply(this, args);
    };
  });

  // Force a sync and wait for XCH to be spendable.
  log("forcing sync, waiting for XCH…");
  await p.evaluate(() => chrome.runtime.sendMessage({ from: "popup", kind: "force-coin-sync" })).catch(() => {});
  for (let i = 0; i < 30; i++) {
    const have = await sw.evaluate(async () => {
      const s = await chrome.storage.session.get("activeFingerprint");
      const store = (await chrome.storage.local.get(`coins.${s.activeFingerprint}`))[`coins.${s.activeFingerprint}`];
      let t = 0n;
      for (const c of Object.values(store?.coins ?? {})) if (!c.spent) t += BigInt(c.amount);
      return t > 0n;
    });
    if (have) break;
    await wait(5000);
  }

  // Self-send a tiny XCH to our own address.
  await p.locator('nav.tabs-bottom button[aria-label="Receive"]').first().click();
  await wait(1200);
  const addr = (await p.locator("body").innerText()).match(/\b(x|t)ch1[a-z0-9]{20,}\b/i)?.[0];
  await p.locator('nav.tabs-bottom button[aria-label="Send"]').first().click();
  await wait(1000);
  await p.locator('input[placeholder="xch1..."]').first().fill(addr);
  await p.locator('input[type="number"]').first().fill("0.0001");
  await wait(800);
  const btn = p.locator("button", { hasText: /^Send / }).first();
  if (!(await btn.isEnabled().catch(() => false))) {
    log("✗ Send disabled — can't run the test (no spendable XCH)");
    process.exitCode = 1;
  } else {
    await btn.click();
    const txEl = p.locator('button[title^="Copy 0x"]').last();
    await txEl.waitFor({ timeout: 90_000 });
    const txId = (await txEl.getAttribute("title"))?.replace(/^Copy\s+/, "").trim();
    log("✓ broadcast self-send", txId?.slice(0, 14));

    // Read the SW (re-grab if it restarted) and check the PERSISTENT dedup set
    // `notif.seen` — survives SW restarts, unlike an in-memory spy. notify()
    // writes the `${kind}:${dedupId}` key whenever it shows a notification.
    log("waiting up to 5min for coin-sync to fire the confirmation notification…");
    let result = null;
    for (let i = 0; i < 50; i++) {
      let cur = ctx.serviceWorkers()[0];
      if (!cur) cur = await ctx.waitForEvent("serviceworker", { timeout: 5000 }).catch(() => null);
      if (cur) {
        const state = await cur
          .evaluate(async () => {
            const seen = (await chrome.storage.local.get("notif.seen"))["notif.seen"] ?? [];
            const s = await chrome.storage.session.get("activeFingerprint");
            const store = (await chrome.storage.local.get(`coins.${s.activeFingerprint}`))[`coins.${s.activeFingerprint}`];
            const pending = Object.values(store?.coins ?? {}).filter((c) => c.pending).length;
            const tele = (await chrome.storage.session.get("coinSyncTelemetry")).coinSyncTelemetry;
            return { keys: seen.map((e) => e.key), pending, stage: tele?.stage };
          })
          .catch(() => null);
        if (state) {
          const hit = state.keys.find((k) => k.startsWith("outgoing-confirmed:") || k.startsWith("outgoing-external:"));
          if (hit) { result = hit; break; }
          if (i % 4 === 0) log(`  …pending=${state.pending} stage=${state.stage} notifKeys=${JSON.stringify(state.keys)}`);
        }
      }
      // Nudge a sync periodically to speed detection.
      if (i % 4 === 0) await p.evaluate(() => chrome.runtime.sendMessage({ from: "popup", kind: "force-coin-sync" })).catch(() => {});
      await wait(6000);
    }
    if (result) {
      log(`✓ notification fired — dedup key: ${result}`);
    } else {
      log(`✗ no outgoing notification within the window.`);
      process.exitCode = 1;
    }
  }
} catch (err) {
  console.error("[notif-confirm] ERROR:", err);
  process.exitCode = 1;
} finally {
  await wait(500);
  await ctx.close();
}
