// Real-dApp smoke against dexie.space.
//
// Why this exists: the user reported a screenshot showing
// `Offered CAT 0x34b14863…a58935 not in wallet` while attempting a
// Combined Swap. None of our prior smokes hit a real dApp — they used
// example.com and synthetic calls — so we missed:
//   • whether dexie even talks to our handlers correctly
//   • whether the assets dexie routes through are the ones the wallet
//     actually tracks
//   • the real error UX a user sees
//
// This smoke:
//   1. Imports a known wallet via the popup, waits for sync
//   2. Opens dexie.space and connects (auto-approves the popup)
//   3. Captures EVERY chia.request that dexie issues (method + params +
//      response) — printed as a wire-level trace
//   4. Snapshots dexie's UI for after-the-fact inspection
//   5. Reports both wire activity AND visible UI errors
//
// Run with the existing test mnemonic:
//   node scripts/pw-dexie-real.mjs
// To test the actual reported wallet, pass its mnemonic:
//   MNEMONIC="..." PASSWORD="..." node scripts/pw-dexie-real.mjs
//
// Note: dexie does most of its swap work as a SPA — the page never reloads,
// dexie just calls window.chia.request whenever it needs balances or to
// build an offer. We trace by monkey-patching window.chia.request from the
// page-side BEFORE dexie's bundle attaches handlers.

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

const __here = dirname(fileURLToPath(import.meta.url));
const EXT_PATH = resolve(__here, "..", "packages/extension/.output/chrome-mv3");
// Shared with pw-tibet-connect.mjs so the same imported + synced wallet is
// reused across dApp smoke runs. Override with USER_DATA=/tmp/some-other.
const USER_DATA = process.env.USER_DATA ?? "/tmp/Loroco-PW-Shared";
const SHOT_DIR = "/tmp/loroco-pw-dexie-real";
const MNEMONIC =
  process.env.MNEMONIC ??
  "charge day cloth frame purpose lake method segment fat gadget regret open better rent visual picnic crater degree budget satoshi shop maple depart host";
const PASSWORD = process.env.PASSWORD ?? "marvin";

mkdirSync(SHOT_DIR, { recursive: true });
const log = (...a) => console.log("[dexie]", ...a);

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

  // ── 1. Import/unlock wallet via popup ──────────────────────────────────
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
  log("wallet unlocked");

  // ── 2. Wait until coin sync has XCH or any CAT (short-circuits if the
  //      persistent userData already has a populated store).
  const SYNC_TIMEOUT_S = Number.parseInt(process.env.SYNC_TIMEOUT_S ?? "90", 10);
  log(`waiting up to ${SYNC_TIMEOUT_S}s for sync (short-circuits on populated store)…`);
  let popupSnapshot = null;
  for (let i = 0; i < SYNC_TIMEOUT_S; i += 1) {
    popupSnapshot = await popup.evaluate(async () => {
      const fp = (await chrome.storage.session.get("activeFingerprint")).activeFingerprint;
      const res = await chrome.runtime.sendMessage({
        from: "popup",
        kind: "get-coin-store",
        fingerprint: fp,
      });
      if (!res?.ok) return null;
      const v = res.value;
      const cats = Object.entries(v?.cats ?? {}).map(([id, c]) => ({
        asset_id: id,
        unspent: (c.coins ?? []).filter((x) => !x.spent).length,
        total: BigInt(0),
      }));
      let xchMojos = 0n;
      for (const c of Object.values(v?.coins ?? {})) {
        if (!c.spent) xchMojos += BigInt(c.amount);
      }
      return {
        fp,
        xch_mojos: xchMojos.toString(),
        xch_coins: Object.values(v?.coins ?? {}).filter((c) => !c.spent).length,
        cats,
        nft_count: Object.keys(v?.nfts ?? {}).length,
      };
    });
    if (popupSnapshot && (BigInt(popupSnapshot.xch_mojos) > 0n || popupSnapshot.cats.length > 0)) {
      break;
    }
    await wait(1000);
  }
  log("popup state:", JSON.stringify(popupSnapshot, null, 2));
  await popup.screenshot({ path: `${SHOT_DIR}/01-popup.png` });

  // ── 3. Open dexie, attach a wire tracer, capture every chia.request call ─
  const dapp = await ctx.newPage();

  // The tracer must be installed BEFORE dexie's script wraps chia.request.
  // addInitScript runs on every navigation in main-world (where chia lives).
  await dapp.addInitScript(() => {
    // Defer until window.chia is injected — it's injected at document_start
    // by the content script, but in a separate microtask. Poll briefly.
    const start = Date.now();
    // Persist trace across SPA navigations via localStorage so we don't
    // lose calls when the dApp re-mounts.
    const STORE_KEY = "__loroco_trace_calls";
    function loadCalls() {
      try {
        return JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]");
      } catch {
        return [];
      }
    }
    function pushCall(entry) {
      const calls = loadCalls();
      calls.push(entry);
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(calls));
      } catch {}
      window.__lorocoCalls = calls;
    }
    window.__lorocoCalls = loadCalls();
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
          console.log(
            `[dApp/chia.request] ${entry.method} ✗ code=${err?.code} msg=${err?.message?.slice(0, 200)}`,
          );
          throw err;
        }
      };
      // Also wrap the legacy direct methods. They route through call() too
      // but dexie's older integrations call them directly.
      for (const m of [
        "connect",
        "requestAccounts",
        "getPublicKeys",
        "getAssetCoins",
        "getAssetBalance",
        "filterUnlockedCoins",
        "signMessage",
        "transfer",
        "createOffer",
        "takeOffer",
        "sendTransaction",
        "signCoinSpends",
      ]) {
        const fn = window.chia[m];
        if (typeof fn !== "function") continue;
        const bound = fn.bind(window.chia);
        window.chia[m] = async (...rest) => {
          // Pass through to request() via the underlying impl — but ALSO
          // track the call for parity with `.request()`.
          const entry = { t: Date.now(), method: m, params: rest[0], legacy: true };
          try {
            const r = await bound(...rest);
            entry.result = r;
            pushCall(entry);
            console.log(`[dApp/chia.${m}] →`, JSON.stringify(r).slice(0, 300));
            return r;
          } catch (err) {
            entry.error = { code: err?.code, message: err?.message };
            pushCall(entry);
            console.log(`[dApp/chia.${m}] ✗ code=${err?.code} msg=${err?.message?.slice(0, 200)}`);
            throw err;
          }
        };
      }
      window.chia.__lorocoTraced = true;
      console.log("[dApp] wire tracer attached");
    };
    wrap();
  });

  dapp.on("console", (m) => {
    const t = m.text();
    if (t.startsWith("[dApp") || t.startsWith("[dApp/")) console.log(`  PAGE: ${t}`);
  });

  log("opening dexie.space…");
  await dapp.goto("https://dexie.space/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await wait(3000);
  await dapp.screenshot({ path: `${SHOT_DIR}/02-dexie-home.png`, fullPage: false });

  // ── 4. Trigger the connect flow ────────────────────────────────────────
  // dexie usually shows a "Connect" button in the header. Click it then auto-
  // approve via the popup.
  log("looking for a wallet connect button on dexie…");
  const connectCandidates = [
    'button:has-text("Connect")',
    '[data-test*="connect"]',
    'button:has-text("Connect Wallet")',
    'a:has-text("Connect")',
  ];
  let clickedConnect = false;
  for (const sel of connectCandidates) {
    const btn = dapp.locator(sel).first();
    if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
      log(`clicking ${sel}`);
      await btn.click({ timeout: 2000 }).catch(() => {});
      clickedConnect = true;
      break;
    }
  }
  if (!clickedConnect) {
    log("no obvious Connect button — trying to call requestAccounts directly");
    void dapp.evaluate(() =>
      window.chia.request({ method: "requestAccounts" }).catch(() => {}),
    );
  }
  await wait(1500);

  // dexie shows a "Connect Wallet" modal with provider rows: WalletConnect,
  // Goby Wallet, Pawket Wallet. Each row has its own Connect button. We
  // click the one whose row contains "Goby".
  log("waiting for connect modal…");
  await dapp.locator("text=Goby Wallet").first().waitFor({ timeout: 5_000 }).catch(() => {});
  // The button is a sibling of the "Goby Wallet" label inside the row.
  // Robust selector: the row → its Connect button.
  const gobyRow = dapp.locator("div, li, tr", { hasText: /^Goby Wallet/ }).first();
  let gobyClicked = false;
  if (await gobyRow.isVisible({ timeout: 1500 }).catch(() => false)) {
    const btn = gobyRow.locator('button:has-text("Connect")').first();
    if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
      log("clicking 'Connect' next to Goby Wallet");
      await btn.click({ timeout: 1500 }).catch(() => {});
      gobyClicked = true;
    }
  }
  if (!gobyClicked) {
    log("⚠ Goby row not found — trying direct chia.request fallback");
    void dapp.evaluate(() =>
      window.chia.request({ method: "requestAccounts" }).catch(() => {}),
    );
  }
  await wait(1500);

  // Auto-approve in the popup.
  for (let i = 0; i < 15; i += 1) {
    const approve = popup.locator("button", { hasText: /^Approve$/ }).first();
    if (await approve.isVisible().catch(() => false)) {
      await approve.click({ timeout: 1500 }).catch(() => {});
      log("approved");
      break;
    }
    await wait(300);
  }
  await wait(2500);
  await dapp.screenshot({ path: `${SHOT_DIR}/03-dexie-connected.png`, fullPage: false });

  // ── 5. Wait a bit so dexie can fetch balances + render the home page ───
  await wait(4000);
  await dapp.screenshot({ path: `${SHOT_DIR}/04-after-connect.png`, fullPage: false });

  // Intermediate dump so we don't lose calls if /swap nav resets state.
  const callsBeforeSwap = await dapp.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("__loroco_trace_calls") ?? "[]");
    } catch {
      return [];
    }
  });
  log(`---- after connect: ${callsBeforeSwap.length} call(s)`);
  for (const c of callsBeforeSwap) {
    const summary = c.error
      ? `✗ ${c.error.code} ${c.error.message?.slice(0, 120)}`
      : `✓ ${JSON.stringify(c.result).slice(0, 200)}`;
    log(`     ${c.method.padEnd(22)} ${summary}`);
  }

  // ── 5.5. Synthetic createOffer probe to verify error UX ────────────────
  // We can't easily drive dexie's full swap UI without funded coins, but
  // we CAN simulate dexie's failure path from the same origin: try to
  // offer a CAT we don't have, and verify the error message lists our
  // available CATs (the improvement landed for the user's screenshot).
  log("synthetic createOffer probe (CAT we don't have)…");
  const probePromise = dapp.evaluate(async () => {
    try {
      const r = await window.chia.request({
        method: "createOffer",
        params: {
          offerAssets: [
            {
              assetId:
                "0x34b14863f51635a20b0f4ef2b1d85280e11552498f79bd74facdca1865a58935",
              amount: "1",
            },
          ],
          requestAssets: [{ assetId: "", amount: "100" }],
          fee: 0,
        },
      });
      return { ok: true, result: r };
    } catch (e) {
      return { ok: false, code: e?.code, message: e?.message };
    }
  });
  // Auto-approve in popup.
  await wait(600);
  for (let i = 0; i < 12; i += 1) {
    const approve = popup.locator("button", { hasText: /^Approve$/ }).first();
    if (await approve.isVisible().catch(() => false)) {
      await approve.click({ timeout: 1500 }).catch(() => {});
      log("approved synthetic createOffer");
      break;
    }
    await wait(300);
  }
  const probe = await probePromise;
  log("synthetic createOffer probe result:", JSON.stringify(probe).slice(0, 400));
  if (!probe.ok && /tracks|no CATs tracked|wallet tracks/i.test(probe.message ?? "")) {
    log("✓ error message now lists wallet contents (UX improvement working)");
  } else if (!probe.ok) {
    log(`⚠ error message did NOT include wallet contents — got: ${probe.message?.slice(0, 200)}`);
  }

  // ── 5.6. Navigate to a swap page to provoke organic balance queries ────
  log("navigating to /swap/XCH/ to provoke balance + CAT queries…");
  await dapp.goto("https://dexie.space/swap/XCH/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await wait(4000);
  await dapp.screenshot({ path: `${SHOT_DIR}/05-swap.png`, fullPage: false });

  // ── 6. Dump trace + UI snapshot ────────────────────────────────────────
  const calls = await dapp.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("__loroco_trace_calls") ?? "[]");
    } catch {
      return window.__lorocoCalls ?? [];
    }
  });
  log(`captured ${calls.length} dApp → wallet calls:`);
  for (const c of calls) {
    const summary = c.error
      ? `✗ ${c.error.code} ${c.error.message?.slice(0, 120)}`
      : `✓ ${JSON.stringify(c.result).slice(0, 200)}`;
    log(`  ${c.method.padEnd(22)} ${summary}`);
  }
  writeFileSync(`${SHOT_DIR}/calls.json`, JSON.stringify(calls, null, 2));

  // Check the visible header for the connected wallet address (proof end-to-end works).
  const headerText = await dapp.locator("body").innerText().catch(() => "");
  const xchAddrMatch = headerText.match(/xch1[a-z0-9]{40,}/);
  if (xchAddrMatch) {
    log(`dexie shows our XCH address in the page: ${xchAddrMatch[0].slice(0, 16)}…`);
  } else {
    log("⚠ no xch1… address visible in dexie page text — connection may have failed silently");
  }

  // Check for the specific failure mode the user hit: a CAT "not in wallet"
  // banner. Surface it loudly if present.
  if (/not in wallet/i.test(headerText)) {
    log("⚠ dexie page contains 'not in wallet' — this is the user's reported failure");
    const idx = headerText.search(/not in wallet/i);
    log("context:", headerText.slice(Math.max(0, idx - 200), idx + 80).replace(/\s+/g, " "));
  }

  log(`screenshots saved under ${SHOT_DIR}`);
} catch (err) {
  console.error("[dexie] ERROR:", err);
  process.exit(1);
} finally {
  await wait(1500);
  await ctx.close();
}
