// Dump every CAT asset_id the wallet currently tracks, and verify whether
// a SPECIFIC asset_id (the one from the user's screenshot, by default) is
// in the store.
//
// Use this to distinguish:
//   (A) the CAT is genuinely not in the store → sync miss (we never saw a
//       hint-matched receipt for it)
//   (B) the CAT IS in the store but the createOffer / getAssetCoins lookup
//       fails (key format mismatch, case mismatch, etc.)
//
// Run with the actual wallet whose state you want to inspect:
//   MNEMONIC="..." PASSWORD="marvin" \
//     ASSET_ID=0x34b14863f51635a20b0f4ef2b1d85280e11552498f79bd74facdca1865a58935 \
//     node scripts/dump-cats.mjs
//
// Default ASSET_ID is the one from the user's reported screenshot. Default
// MNEMONIC is the standard test seed.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

const __here = dirname(fileURLToPath(import.meta.url));
const EXT_PATH = resolve(__here, "..", "packages/extension/.output/chrome-mv3");
const USER_DATA = "/tmp/Loroco-PW-DumpCats";
mkdirSync("/tmp/loroco-pw-dump", { recursive: true });

const MNEMONIC =
  process.env.MNEMONIC ??
  "charge day cloth frame purpose lake method segment fat gadget regret open better rent visual picnic crater degree budget satoshi shop maple depart host";
const PASSWORD = process.env.PASSWORD ?? "marvin";
const TARGET_ASSET_RAW =
  process.env.ASSET_ID ??
  "0x34b14863f51635a20b0f4ef2b1d85280e11552498f79bd74facdca1865a58935";
const TARGET_ASSET = TARGET_ASSET_RAW.startsWith("0x")
  ? TARGET_ASSET_RAW.toLowerCase()
  : `0x${TARGET_ASSET_RAW.toLowerCase()}`;

const log = (...a) => console.log("[dump]", ...a);

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

  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForLoadState("domcontentloaded");
  await wait(700);

  const body0 = await popup.locator("body").innerText();
  if (/Import|Create/i.test(body0)) {
    log("importing wallet…");
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

  log("waiting up to 120s for CAT sync to complete a first pass…");
  let snapshot = null;
  for (let i = 0; i < 120; i += 1) {
    snapshot = await popup.evaluate(async () => {
      const fp = (await chrome.storage.session.get("activeFingerprint")).activeFingerprint;
      const res = await chrome.runtime.sendMessage({
        from: "popup",
        kind: "get-coin-store",
        fingerprint: fp,
      });
      if (!res?.ok) return null;
      const v = res.value;
      const cats = Object.entries(v?.cats ?? {}).map(([key, c]) => {
        const unspent = (c.coins ?? []).filter((x) => !x.spent);
        let totalMojos = 0n;
        for (const u of unspent) totalMojos += BigInt(u.amount);
        return {
          key, // exact storage key (case + 0x preserved)
          asset_id_field: c.asset_id ?? null, // what the engine actually set on the CatRecord
          unspent_coin_count: unspent.length,
          total_unspent_mojos: totalMojos.toString(),
        };
      });
      return {
        fp,
        cats_synced_at: v?.cats_synced_at ?? null,
        last_synced_height: v?.last_synced_height ?? 0,
        xch_unspent_count: Object.values(v?.coins ?? {}).filter((c) => !c.spent).length,
        cats,
      };
    });
    if (snapshot && (snapshot.cats.length > 0 || snapshot.cats_synced_at)) break;
    await wait(1000);
  }

  log(`fingerprint: ${snapshot?.fp}, last_height: ${snapshot?.last_synced_height}`);
  log(`cats_synced_at: ${snapshot?.cats_synced_at ? new Date(snapshot.cats_synced_at).toISOString() : "never"}`);
  log(`XCH unspent coins: ${snapshot?.xch_unspent_count}`);
  log(`---- ALL CAT ASSET IDS IN STORE (${snapshot?.cats?.length ?? 0}) ----`);
  for (const c of snapshot?.cats ?? []) {
    const match = c.key.toLowerCase() === TARGET_ASSET ? " ← TARGET MATCH" : "";
    log(
      `  ${c.key.padEnd(68)} mojos=${c.total_unspent_mojos.padStart(20)} coins=${c.unspent_coin_count}${match}`,
    );
    if (c.asset_id_field && c.asset_id_field.toLowerCase() !== c.key.toLowerCase()) {
      log(`    ⚠ asset_id_field "${c.asset_id_field}" differs from store key "${c.key}"`);
    }
  }

  // Explicit check for the user's target asset
  log(`---- TARGET ASSET CHECK ----`);
  log(`target: ${TARGET_ASSET}`);
  const matchInStore = (snapshot?.cats ?? []).some(
    (c) => c.key.toLowerCase() === TARGET_ASSET,
  );
  log(`in store (case-insensitive)?  ${matchInStore ? "YES — bug is in the lookup path" : "NO — sync never picked it up"}`);

  // ── Exercise the actual handler paths the dApp would hit.
  // popup-rpc can't spoof origins (sender.origin takes precedence by
  // design), so route through a real https:// page that calls
  // window.chia.request, same path dexie uses.
  log(`---- RPC HANDLER PROBES (via real https:// page) ----`);
  const dapp = await ctx.newPage();
  await dapp.goto("https://example.com/", { waitUntil: "domcontentloaded" });
  await wait(700);

  // Grant connection through the legit connect flow so the call isn't 4001.
  const connectP = dapp.evaluate(() =>
    window.chia.request({ method: "connect" }).catch((e) => ({ err: e?.message })),
  );
  await wait(700);
  for (let i = 0; i < 12; i += 1) {
    const approve = popup.locator("button", { hasText: /^Approve$/ }).first();
    if (await approve.isVisible().catch(() => false)) {
      await approve.click({ timeout: 1500 }).catch(() => {});
      break;
    }
    await wait(300);
  }
  await connectP;

  const balanceProbe = await dapp.evaluate(async (assetId) => {
    try {
      const r = await window.chia.request({
        method: "getAssetBalance",
        params: { type: "cat", assetId },
      });
      return { ok: true, result: r };
    } catch (e) {
      return { ok: false, code: e?.code, message: e?.message };
    }
  }, TARGET_ASSET);
  log(`getAssetBalance(cat, target) → ${JSON.stringify(balanceProbe).slice(0, 400)}`);

  const coinsProbe = await dapp.evaluate(async (assetId) => {
    try {
      const r = await window.chia.request({
        method: "getAssetCoins",
        params: { type: "cat", assetId, limit: 5 },
      });
      return { ok: true, result: r };
    } catch (e) {
      return { ok: false, code: e?.code, message: e?.message };
    }
  }, TARGET_ASSET);
  log(`getAssetCoins(cat, target)  → ${JSON.stringify(coinsProbe).slice(0, 400)}`);

  // Also show what we get for one of the asset_ids we KNOW is in the store
  // (control case — proves the handler works when the asset_id matches).
  const knownAssetId = snapshot?.cats?.[0]?.key;
  if (knownAssetId) {
    const controlBalance = await dapp.evaluate(async (assetId) => {
      return window.chia.request({
        method: "getAssetBalance",
        params: { type: "cat", assetId },
      });
    }, knownAssetId);
    log(`CONTROL getAssetBalance(${knownAssetId.slice(0, 14)}…) → ${JSON.stringify(controlBalance)}`);
  }
} catch (err) {
  console.error("[dump] ERROR:", err);
  process.exit(1);
} finally {
  await wait(500);
  await ctx.close();
}
