// End-to-end test for the optimistic-spent + mempool-watch flow:
//
//   1. Import the public dev mnemonic into an isolated profile.
//   2. Wait for the XCH balance to populate.
//   3. Submit 1 mojo to the target address via the Send tab.
//   4. Snapshot chrome.storage.local at four checkpoints:
//        T0: before submit
//        T1: immediately after submit  → expect pending=true on inputs
//        T2: ~10s after submit         → expect mempool.outgoing populated
//        T3: ~60s after submit         → expect pending cleared + spent_block
//   5. Print a diff showing the lifecycle so we can verify each phase.
//
// Run:  TARGET=xch1... node scripts/pw-mempool-send-flow.mjs

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const EXT_PATH = resolve(repoRoot, "packages/extension/.output/chrome-mv3");
const USER_DATA = process.env.USER_DATA ?? "/tmp/Loroco-PW-MempoolSend";
const SHOTS = resolve(repoRoot, "shots/mempool-send");
mkdirSync(SHOTS, { recursive: true });

const TARGET =
  process.env.TARGET ??
  "xch12sgtlpm58wxkdjdycn8rapd7j2c9g3trn93hqh49uqnjvne8hleqwjwrcq";
const MNEMONIC =
  process.env.MNEMONIC ??
  "charge day cloth frame purpose lake method segment fat gadget regret open better rent visual picnic crater degree budget satoshi shop maple depart host";

console.log("▸ TARGET:", TARGET);
console.log("▸ USER_DATA:", USER_DATA);

const ctx = await chromium.launchPersistentContext(USER_DATA, {
  headless: false,
  channel: "chromium",
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=520,800",
  ],
});

const log = (...a) => console.log("[send-flow]", ...a);

let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
const extId = sw.url().split("/")[2];
log("ext id:", extId);

sw.on("console", (m) => {
  const t = m.text();
  if (t.includes("[mempool-watch]") || t.includes("[Loroco/onerror]") || t.includes("[Loroco/unhandledrejection]")) {
    log("SW:", t);
  }
});

const popup = await ctx.newPage();
await popup.setViewportSize({ width: 380, height: 600 });
await popup.goto(`chrome-extension://${extId}/popup.html`);
await popup.waitForLoadState("domcontentloaded");
await wait(1500);

// Import wallet if onboarding, else unlock.
const bodyText = await popup.locator("body").innerText();
if (/Import|Create/i.test(bodyText) && !/Unlock/i.test(bodyText)) {
  log("onboarding — importing dev mnemonic");
  const imp = popup.locator("button", { hasText: /Import mnemonic/i }).first();
  if (await imp.isVisible().catch(() => false)) {
    await imp.click();
    await wait(400);
  }
  await popup.locator("textarea").first().fill(MNEMONIC);
  await popup.locator("input[type='password']").first().fill("marvin");
  await popup.locator("button", { hasText: /^Continue$/ }).first().click();
  await wait(4500);
} else if (/Unlock/i.test(bodyText)) {
  log("unlocking");
  await popup.locator("input[type='password']").first().fill("marvin");
  await popup.locator("button", { hasText: /^Unlock$/ }).first().click();
  await wait(3000);
}

await popup.screenshot({ timeout: 5000, path: `${SHOTS}/00-home.png` });

// Wait for XCH balance > 1 mojo.
log("waiting for XCH balance…");
let hadBalance = false;
for (let i = 0; i < 60; i += 1) {
  const bal = await popup.locator(".balance").first().innerText().catch(() => "");
  if (/[1-9]/.test(bal)) {
    hadBalance = true;
    log("balance:", bal);
    break;
  }
  await wait(2000);
}
if (!hadBalance) {
  log("FAIL: no balance after 120s. The dev wallet is probably empty — fund it first or pass MNEMONIC=...");
  await popup.screenshot({ timeout: 5000, path: `${SHOTS}/00-no-balance.png` });
  await ctx.close();
  process.exit(1);
}

// Snapshot helper.
async function snap(label) {
  const data = await popup.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const ck = Object.keys(all).filter((k) => k.startsWith("coins."))[0];
    const store = all[ck];
    const coins = Object.values(store?.coins ?? {});
    const pending = coins.filter((c) => c.pending);
    const unspent = coins.filter((c) => !c.spent);
    return {
      ts: Date.now(),
      key: ck,
      _optDebug: all._optDebug ?? null,
      _optResult: all._optResult ?? null,
      total_coins: coins.length,
      unspent: unspent.length,
      total_unspent_mojos: unspent.reduce((s, c) => s + BigInt(c.amount), 0n).toString(),
      pending_coins: pending.map((c) => ({
        coin_id: c.coin_id,
        amount: c.amount,
        pending_at: c.pending_at,
        spent_block_index: c.spent_block_index,
      })),
      mempool: store?.mempool ?? null,
      stats: all.mempoolWatchStats ?? null,
    };
  });
  console.log(`\n=== T:${label} ===`);
  console.log(JSON.stringify(data, null, 2));
  return data;
}

// Force a fresh sync so we don't try to spend a coin that's already gone.
log("forcing coin-sync tick…");
await popup.evaluate(() =>
  chrome.runtime.sendMessage({ from: "popup", kind: "force-coin-sync" }),
);
await wait(8000);

const T0 = await snap("0-before-submit");

// Open Send tab + fill form.
log("opening Send tab");
await popup.locator(".tab .tab-label", { hasText: /^Send$/i }).first().click();
await wait(800);
await popup.locator("input[type='text']").first().fill(TARGET);
await wait(500);
await popup.locator("input[type='number']").first().fill("0.000000000001"); // 1 mojo
await wait(400);
await popup.screenshot({ timeout: 5000, path: `${SHOTS}/01-send-filled.png` });

const submit = popup.locator("button", { hasText: /^Send XCH$/ }).first();
if (!(await submit.isEnabled())) {
  log("FAIL: Send button not enabled");
  await popup.screenshot({ timeout: 5000, path: `${SHOTS}/01-disabled.png` });
  await ctx.close();
  process.exit(1);
}

log(">>> submitting tx");
await submit.click();

// Wait briefly for the engine to return tx_id (submit_transaction success).
let txId = null;
for (let i = 0; i < 25; i += 1) {
  await wait(1000);
  const txs = await popup
    .locator(".result code")
    .filter({ hasText: /^0x[0-9a-f]+/i })
    .allInnerTexts();
  if (txs.length) {
    txId = txs[0];
    break;
  }
  const err = await popup.locator(".error").allInnerTexts();
  if (err.length) {
    log("submit error:", err.join(" | "));
    await popup.screenshot({ timeout: 5000, path: `${SHOTS}/02-error.png` });
    await ctx.close();
    process.exit(1);
  }
}
log("tx_id:", txId);
await popup.screenshot({ timeout: 5000, path: `${SHOTS}/02-submitted.png` }).catch((e) => log("screenshot 02 failed:", e.message));

const T1 = await snap("1-just-after-submit");

log("waiting 12s for WS to see our tx in mempool…");
await wait(12000);
const T2 = await snap("2-mempool-window");

log("waiting 60s for block inclusion + confirmation…");
await wait(60000);
const T3 = await snap("3-post-confirmation");

// Summary diff.
console.log("\n=== LIFECYCLE SUMMARY ===");
console.log(`T0 → T1: pending added? ${T1.pending_coins.length > T0.pending_coins.length ? "YES" : "NO"} (${T0.pending_coins.length} → ${T1.pending_coins.length})`);
console.log(`T1 → T2: mempool.outgoing has our tx? ${(T2.mempool?.outgoing ?? []).some((o) => o.tx_id === txId) ? "YES" : "NO"}`);
console.log(`T2 → T3: pending cleared? ${T3.pending_coins.length < T1.pending_coins.length ? "YES" : "NO"} (${T1.pending_coins.length} → ${T3.pending_coins.length})`);
console.log(`unspent change: T0=${T0.unspent} → T3=${T3.unspent}`);
console.log(`mempool stats final: ${JSON.stringify(T3.stats?.eventTypes ?? {})}`);

await popup.screenshot({ timeout: 5000, path: `${SHOTS}/03-final.png` }).catch(() => {});
await ctx.close();
