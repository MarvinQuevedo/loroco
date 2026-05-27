// Real-dApp smoke against v2.tibetswap.io.
//
// Mirrors pw-dexie-real.mjs but for tibetswap. Uses the new loroco extension
// build and the MetaMask-style inline approval (the popup itself shows the
// Approve button — there is no separate approval window).
//
// Persistent userData dir → wallet + sync state survive across runs. First
// run: import mnemonic + wait for sync. Subsequent runs: unlock + skip
// sync wait if the coin store is already populated.

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

const __here = dirname(fileURLToPath(import.meta.url));
const EXT_PATH = resolve(__here, "..", "packages/extension/.output/chrome-mv3");
// Shared with pw-dexie-real.mjs so both dApps can reuse the same imported +
// synced wallet between runs.
const USER_DATA = process.env.USER_DATA ?? "/tmp/Loroco-PW-Shared";
const SHOT_DIR = "/tmp/loroco-pw-tibet";
const MNEMONIC =
  process.env.MNEMONIC ??
  "charge day cloth frame purpose lake method segment fat gadget regret open better rent visual picnic crater degree budget satoshi shop maple depart host";
const PASSWORD = process.env.PASSWORD ?? "marvin";

mkdirSync(SHOT_DIR, { recursive: true });
const log = (...a) => console.log("[tibet]", ...a);

const ctx = await chromium.launchPersistentContext(USER_DATA, {
  headless: false,
  channel: "chromium",
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1400,900",
  ],
});

try {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
  const extId = sw.url().split("/")[2];
  log("ext id:", extId);

  sw.on("console", (msg) => {
    const t = msg.text();
    if (t.includes("[loroco/")) console.log(`  SW: ${t}`);
  });

  // ── 1. Import or unlock the wallet ─────────────────────────────────────
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForLoadState("domcontentloaded");
  await wait(700);

  const body0 = await popup.locator("body").innerText();
  if (/Import|Create/i.test(body0)) {
    log("importing wallet from mnemonic…");
    const importBtn = popup.locator("button", { hasText: /Import mnemonic/i }).first();
    if (await importBtn.isVisible().catch(() => false)) await importBtn.click();
    await wait(400);
    await popup.locator("textarea").first().fill(MNEMONIC);
    await popup.locator("input[type='password']").first().fill(PASSWORD);
    await popup.locator("button", { hasText: /^Continue$/ }).first().click();
    await wait(3500);
  } else {
    const pw = popup.locator("input[type='password']").first();
    if (await pw.isVisible().catch(() => false)) {
      await pw.fill(PASSWORD);
      await popup.locator("button", { hasText: /^Unlock$/ }).first().click();
      await wait(2000);
    }
  }
  log("wallet ready");

  // ── 2. Wait briefly for sync — short-circuit if already populated ──────
  async function snapshot() {
    return popup.evaluate(async () => {
      const fp = (await chrome.storage.session.get("activeFingerprint")).activeFingerprint;
      const res = await chrome.runtime.sendMessage({
        from: "popup",
        kind: "get-coin-store",
        fingerprint: fp,
      });
      if (!res?.ok) return null;
      const v = res.value;
      let xchMojos = 0n;
      for (const c of Object.values(v?.coins ?? {})) {
        if (!c.spent) xchMojos += BigInt(c.amount);
      }
      return {
        fp,
        xch_mojos: xchMojos.toString(),
        xch_coins: Object.values(v?.coins ?? {}).filter((c) => !c.spent).length,
        cats: Object.keys(v?.cats ?? {}).length,
        nfts: Object.keys(v?.nfts ?? {}).length,
      };
    });
  }

  let snap = await snapshot();
  const SYNC_TIMEOUT_S = Number.parseInt(process.env.SYNC_TIMEOUT_S ?? "60", 10);
  if (snap && (BigInt(snap.xch_mojos) > 0n || snap.cats > 0)) {
    log("✓ wallet already synced (reusing persistent userData):", JSON.stringify(snap));
  } else {
    log(`waiting up to ${SYNC_TIMEOUT_S}s for first sync…`);
    for (let i = 0; i < SYNC_TIMEOUT_S; i += 1) {
      snap = await snapshot();
      if (snap && (BigInt(snap.xch_mojos) > 0n || snap.cats > 0)) break;
      await wait(1000);
    }
    log("post-sync state:", JSON.stringify(snap));
  }
  await popup.screenshot({ path: `${SHOT_DIR}/01-popup.png` });

  // ── 3. Open tibetswap with a wire tracer attached pre-injection ────────
  const dapp = await ctx.newPage();
  await dapp.addInitScript(() => {
    const STORE_KEY = "__loroco_trace_calls";
    function loadCalls() {
      try { return JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]"); } catch { return []; }
    }
    function pushCall(entry) {
      const calls = loadCalls();
      calls.push(entry);
      try { localStorage.setItem(STORE_KEY, JSON.stringify(calls)); } catch {}
      window.__lorocoCalls = calls;
    }
    window.__lorocoCalls = loadCalls();
    const start = Date.now();
    const wrap = () => {
      if (!window.chia || window.chia.__lorocoTraced) {
        if (Date.now() - start < 5000) setTimeout(wrap, 50);
        return;
      }
      const original = window.chia.request.bind(window.chia);
      window.chia.request = async function tracedRequest(args) {
        const entry = { t: Date.now(), method: args?.method, params: args?.params };
        try {
          const result = await original(args);
          entry.result = result;
          pushCall(entry);
          console.log(`[dApp/chia.request] ${entry.method} →`, JSON.stringify(result).slice(0, 300));
          return result;
        } catch (err) {
          entry.error = { code: err?.code, message: err?.message };
          pushCall(entry);
          console.log(`[dApp/chia.request] ${entry.method} ✗ code=${err?.code} msg=${err?.message?.slice(0, 200)}`);
          throw err;
        }
      };
      window.chia.__lorocoTraced = true;
      console.log("[dApp] wire tracer attached");
    };
    wrap();
  });

  dapp.on("console", (m) => {
    const t = m.text();
    if (t.startsWith("[dApp")) console.log(`  PAGE: ${t}`);
  });

  log("opening v2.tibetswap.io…");
  await dapp.goto("https://v2.tibetswap.io", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await wait(3000);
  await dapp.screenshot({ path: `${SHOT_DIR}/02-tibet-home.png` });

  // ── 4. Click Connect Wallet → Goby row ─────────────────────────────────
  log("clicking Connect Wallet…");
  const connectWallet = dapp.locator("button:has-text('Connect Wallet')").first();
  if (await connectWallet.isVisible({ timeout: 3000 }).catch(() => false)) {
    await connectWallet.click({ timeout: 2000 }).catch(() => {});
  } else {
    log("⚠ no Connect Wallet button visible — trying requestAccounts directly");
    void dapp.evaluate(() => window.chia.request({ method: "requestAccounts" }).catch(() => {}));
  }
  await wait(1500);
  await dapp.screenshot({ path: `${SHOT_DIR}/03-picker.png` });

  // Tibet's picker shows two providers (Goby + Wallet Connect). Goby is the
  // first row, so the first button whose text is exactly "Connect" is the
  // one we want. Wait for the picker to render before grabbing it.
  await dapp.locator("text=Goby Wallet").first().waitFor({ timeout: 5_000 }).catch(() => {});
  const connectButtons = dapp.locator("button").filter({ hasText: /^Connect$/ });
  const buttonCount = await connectButtons.count();
  log(`picker visible — ${buttonCount} Connect button(s)`);
  if (buttonCount > 0) {
    await connectButtons.first().click({ timeout: 2000 }).catch((e) => {
      log(`⚠ click failed: ${e?.message?.slice(0, 120)}`);
    });
    log("clicked first Connect (Goby row)");
  } else {
    log("⚠ no Connect buttons found in picker — falling back to direct requestAccounts");
    void dapp.evaluate(() => window.chia.request({ method: "requestAccounts" }).catch(() => {}));
  }
  await wait(1500);

  // ── 5. Approve in the popup (inline, not a new window) ─────────────────
  log("auto-approving in popup…");
  for (let i = 0; i < 20; i += 1) {
    const approve = popup.locator("button", { hasText: /^Approve$/ }).first();
    if (await approve.isVisible().catch(() => false)) {
      await approve.click({ timeout: 1500 }).catch(() => {});
      log("approved");
      break;
    }
    await wait(300);
  }
  await wait(2500);
  await dapp.screenshot({ path: `${SHOT_DIR}/04-after-approve.png` });

  // ── 6. Confirm accounts + balance respond ──────────────────────────────
  const probe = await dapp.evaluate(async () => {
    const out = { accounts: null, balance: null };
    try {
      out.accounts = await window.chia.request({ method: "accounts" });
    } catch (e) {
      out.accountsErr = { code: e?.code, message: e?.message };
    }
    try {
      out.balance = await window.chia.request({
        method: "getAssetBalance",
        params: { type: null, assetId: null },
      });
    } catch (e) {
      out.balanceErr = { code: e?.code, message: e?.message };
    }
    return out;
  });
  log("probe:", JSON.stringify(probe).slice(0, 400));

  // ── 7. Dump trace ──────────────────────────────────────────────────────
  const calls = await dapp.evaluate(() => {
    try { return JSON.parse(localStorage.getItem("__loroco_trace_calls") ?? "[]"); } catch { return []; }
  });
  log(`captured ${calls.length} dApp → wallet calls:`);
  for (const c of calls) {
    const summary = c.error
      ? `✗ ${c.error.code} ${c.error.message?.slice(0, 120)}`
      : `✓ ${JSON.stringify(c.result).slice(0, 200)}`;
    log(`  ${(c.method ?? "?").padEnd(22)} ${summary}`);
  }
  writeFileSync(`${SHOT_DIR}/calls.json`, JSON.stringify(calls, null, 2));

  const headerText = await dapp.locator("body").innerText().catch(() => "");
  const xchAddrMatch = headerText.match(/xch1[a-z0-9]{40,}/);
  if (xchAddrMatch) log(`tibet shows our XCH address: ${xchAddrMatch[0].slice(0, 16)}…`);
  else log("⚠ no xch1… address visible — connection may have failed silently");

  log(`screenshots saved under ${SHOT_DIR}`);
} catch (err) {
  console.error("[tibet] ERROR:", err);
  process.exit(1);
} finally {
  await wait(1500);
  await ctx.close();
}
