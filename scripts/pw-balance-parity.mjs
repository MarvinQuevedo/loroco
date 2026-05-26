// Reproduce the "dexie says 0 XCH but popup says 70M mojos" divergence
// from a clean automated run.
//
// Flow:
//   1. Import a known wallet via the popup
//   2. Wait for the first coin-sync to deposit something into coins.<fp>
//   3. From the popup-rpc surface, read the local coin store snapshot
//      (this is what the popup header balance uses)
//   4. From a real https://example.com page, call window.chia.request({
//        method: "getAssetBalance", params: { type: null, assetId: null },
//      }) — this is what dexie calls
//   5. Compare. If they match → the user's bug is timing / dexie cache.
//      If they diverge → it's our wiring bug; print enough state to
//      pinpoint the cause.
//
// Run: pnpm chrome  (in another tab) is NOT needed; this is self-contained.
//      MNEMONIC=... node scripts/pw-balance-parity.mjs

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

const __here = dirname(fileURLToPath(import.meta.url));
const EXT_PATH = resolve(__here, "..", "packages/extension/.output/chrome-mv3");
const USER_DATA = "/tmp/Loroco-PW-Balance";
const SHOT_DIR = "/tmp/loroco-pw-balance";
const MNEMONIC =
  process.env.MNEMONIC ??
  "charge day cloth frame purpose lake method segment fat gadget regret open better rent visual picnic crater degree budget satoshi shop maple depart host";

mkdirSync(SHOT_DIR, { recursive: true });
const log = (...a) => console.log("[bal]", ...a);
const fail = (msg) => {
  console.error("[bal] FAIL:", msg);
  process.exit(1);
};

const ctx = await chromium.launchPersistentContext(USER_DATA, {
  headless: false,
  channel: "chromium",
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1200,900",
  ],
});

try {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
  const extId = sw.url().split("/")[2];
  log("ext id:", extId);

  // Pipe SW console output to our stdout so the [loroco/*] log lines show up.
  sw.on("console", (msg) => {
    const txt = msg.text();
    // Show every SW log so we don't miss broadcast diagnostics.
    if (txt.length > 0) console.log(`  SW(${msg.type()}):`, txt);
  });

  // Open the popup and import the wallet (if not already imported).
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForLoadState("domcontentloaded");
  await wait(800);

  const body0 = await popup.locator("body").innerText();
  if (/Import|Create/i.test(body0)) {
    log("importing wallet…");
    const importBtn = popup.locator("button", { hasText: /Import mnemonic/i }).first();
    if (await importBtn.isVisible().catch(() => false)) await importBtn.click();
    await wait(400);
    await popup.locator("textarea").first().fill(MNEMONIC);
    await popup.locator("input[type='password']").first().fill("marvin");
    await popup.locator("button", { hasText: /^Continue$/ }).first().click();
    await wait(3500);
  } else {
    log("wallet already imported, may need unlock");
    const pw = popup.locator("input[type='password']").first();
    if (await pw.isVisible().catch(() => false)) {
      await pw.fill("marvin");
      await popup.locator("button", { hasText: /^Unlock$/ }).first().click();
      await wait(2000);
    }
  }
  log("wallet unlocked");

  // Read the popup balance display
  const headerText = await popup.locator(".balance, .wallet-bar").first().innerText().catch(() => "");
  log("popup header text:", headerText.replace(/\s+/g, " "));

  // Wait for sync to deposit at least one coin (or 60s, whichever first).
  log("waiting up to 60s for coin sync…");
  for (let i = 0; i < 60; i += 1) {
    const t = await popup.locator(".wallet-bar").first().innerText().catch(() => "");
    if (/XCH/.test(t) && !/0\.0000\sXCH/.test(t)) {
      log("balance appeared:", t.replace(/\s+/g, " ").slice(0, 120));
      break;
    }
    await wait(1000);
  }
  await popup.screenshot({ path: `${SHOT_DIR}/01-popup.png` });

  // Read the popup-side coin store totals. We do this via the popup-rpc by
  // executing in-popup JS that imports the engine-client.
  const popupView = await popup.evaluate(async () => {
    // Send the same popup-rpc message getCoinSnapshot uses.
    const fp = (await chrome.storage.session.get("activeFingerprint")).activeFingerprint;
    const res = await chrome.runtime.sendMessage({
      from: "popup",
      kind: "get-coin-store",
      fingerprint: fp,
    });
    if (!res?.ok) return { fp, error: res?.error };
    const v = res.value;
    let total = 0n;
    for (const c of Object.values(v?.coins ?? {})) {
      if (!c.spent) total += BigInt(c.amount);
    }
    return {
      fp,
      total_unspent_mojos: total.toString(),
      coin_count: Object.values(v?.coins ?? {}).filter((c) => !c.spent).length,
      cat_assets: Object.keys(v?.cats ?? {}).length,
      nft_count: Object.keys(v?.nfts ?? {}).length,
      last_synced_height: v?.last_synced_height ?? 0,
    };
  });
  log("popup snapshot:", JSON.stringify(popupView, null, 2));

  // Now open a real page and call window.chia.getAssetBalance — same path
  // dexie would use.
  const dapp = await ctx.newPage();
  // Capture page console so accountChanged delivery is visible from inpage.
  dapp.on("console", (m) => {
    if (m.text().includes("[dApp]")) console.log("  DAPP:", m.text());
  });
  await dapp.goto("https://example.com/", { waitUntil: "domcontentloaded" });
  await wait(600);

  // Register listener for accountChanged so we see it land.
  await dapp.evaluate(() => {
    window.__lorocoEvents = [];
    window.chia.on("accountChanged", (payload) => {
      window.__lorocoEvents.push({ kind: "accountChanged", payload, at: Date.now() });
      console.log("[dApp] accountChanged received:", JSON.stringify(payload));
    });
    window.chia.on("chainChanged", (payload) => {
      window.__lorocoEvents.push({ kind: "chainChanged", payload, at: Date.now() });
      console.log("[dApp] chainChanged received:", JSON.stringify(payload));
    });
  });

  // First we need to connect, otherwise getAssetBalance throws 4001.
  log("kicking connect on the dapp…");
  const connectP = dapp.evaluate(async () => {
    try {
      const r = await window.chia.request({ method: "connect" });
      return { ok: true, value: r };
    } catch (e) {
      return { ok: false, code: e?.code, message: e?.message };
    }
  });
  // Auto-approve via popup
  await wait(800);
  for (let i = 0; i < 12; i += 1) {
    const approveBtn = popup.locator("button", { hasText: /^Approve$/ }).first();
    if (await approveBtn.isVisible().catch(() => false)) {
      await approveBtn.click({ timeout: 1500 }).catch(() => {});
      log("approved connect");
      break;
    }
    await wait(300);
  }
  log("connect result:", JSON.stringify(await connectP));

  // Now call getAssetBalance from the dapp side. Loop 3 times to see if it
  // converges (catches sync races).
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await wait(2000);
    const dappBal = await dapp.evaluate(async () => {
      try {
        const r = await window.chia.request({
          method: "getAssetBalance",
          params: { type: null, assetId: null },
        });
        return { ok: true, value: r };
      } catch (e) {
        return { ok: false, code: e?.code, message: e?.message };
      }
    });
    log(`dApp getAssetBalance attempt #${attempt}:`, JSON.stringify(dappBal));
  }

  // Final compare
  const popupTotal = BigInt(popupView.total_unspent_mojos ?? "0");
  const dappFinal = await dapp.evaluate(async () => {
    try {
      const r = await window.chia.request({
        method: "getAssetBalance",
        params: { type: null, assetId: null },
      });
      return BigInt(r.confirmed).toString();
    } catch (e) {
      return `ERR:${e?.code}:${e?.message}`;
    }
  });
  log(`\n=== PARITY CHECK ===`);
  log(`popup (readCoinStore) sees: ${popupTotal} mojos in ${popupView.coin_count} coins`);
  log(`dApp  (getAssetBalance) sees: ${dappFinal} mojos`);
  if (popupTotal.toString() === dappFinal) {
    log(`✓ MATCH — same value via both paths`);
  } else {
    log(`✗ MISMATCH — there's a wiring bug, this is what the user is hitting`);
    process.exit(2);
  }

  // Now simulate a wallet switch (via the popup) and verify the dApp
  // receives accountChanged within ~2s.
  log("\n=== EVENT DELIVERY CHECK ===");
  log("triggering debug-broadcast from popup-rpc to fire accountChanged");
  const broadcastResp = await popup.evaluate(async () => {
    return chrome.runtime.sendMessage({
      from: "popup",
      kind: "debug-broadcast",
      event: "accountChanged",
      payload: { reason: "smoke-test" },
    });
  });
  log("broadcast SW response:", JSON.stringify(broadcastResp));
  await wait(1500);

  // Read the persistent trace counter — bypasses any SW console capture loss.
  const traceLog = await popup.evaluate(async () => {
    const r = await chrome.storage.session.get("loroco_broadcast_log");
    return r.loroco_broadcast_log ?? [];
  });
  log(`broadcast trace log (${traceLog.length} entries):`, JSON.stringify(traceLog).slice(0, 600));
  const events = await dapp.evaluate(() => window.__lorocoEvents ?? []);
  log(`dApp received ${events.length} event(s):`, JSON.stringify(events).slice(0, 400));
  if (events.length === 0) {
    log(`⚠ No accountChanged delivered — dApps won't be notified on sync/switch`);
    process.exit(3);
  }
  log(`✓ accountChanged delivery wired correctly`);
} catch (err) {
  console.error("[bal] ERROR:", err);
  process.exit(1);
} finally {
  await wait(1500); // give SW console logs time to flush
  await ctx.close();
}
