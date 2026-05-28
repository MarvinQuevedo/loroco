// Drive a createOffer through a real dApp using the wallet from .env.
// Default: 1 AIR → 1000 mojos XCH. The dApp is just an authorized origin —
// we call window.chia.request directly so the test isn't coupled to each
// site's UI markup.
//
// Run:
//   node --env-file=.env scripts/pw-offer-air.mjs          # dexie
//   DAPP=tibet node --env-file=.env scripts/pw-offer-air.mjs
//   DAPP=both  node --env-file=.env scripts/pw-offer-air.mjs
//
// Why call .request directly: dexie's "Create Offer" UI needs us to fill
// inputs and click around — its DOM changes often, brittle to script. The
// wallet path is what we actually want to validate. Once the wallet builds
// the bundle, the dApp's own UI tests can ride on top.

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

const __here = dirname(fileURLToPath(import.meta.url));
const EXT_PATH = resolve(__here, "..", "packages/extension/.output/chrome-mv3");
const USER_DATA = process.env.USER_DATA ?? "/tmp/Loroco-PW-Real";
const OUT_DIR = "/tmp/loroco-pw-offer";
const MNEMONIC = process.env.MNEMONIC;
const PASSWORD = process.env.PASSWORD ?? "marvin";

// AIR — verified via dexie /v1/cats (code "AIR", denom 1000).
const AIR_ASSET_ID =
  process.env.AIR_ASSET_ID ??
  "0x824c71e37ac660006e03f7884561e7a124d930460ae1506a9c234c06ebc6aa1d";
const AIR_OFFER_MOJOS = process.env.AIR_OFFER_MOJOS ?? "1000"; // 1 AIR
const XCH_REQUEST_MOJOS = process.env.XCH_REQUEST_MOJOS ?? "1000"; // tiny

const DAPP = (process.env.DAPP ?? "dexie").toLowerCase();
const SITES = DAPP === "both" ? ["dexie", "tibet"] : [DAPP];

if (!MNEMONIC) {
  console.error("MNEMONIC env var required (use --env-file=.env)");
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const log = (...a) => console.log("[offer]", ...a);

const ORIGINS = {
  dexie: "https://dexie.space",
  tibet: "https://v2.tibetswap.io",
};

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

async function ensureWalletReady(extId) {
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForLoadState("domcontentloaded");
  await wait(700);
  const body = await popup.locator("body").innerText();
  if (/Import|Create/i.test(body)) {
    log("importing mnemonic…");
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
  return popup;
}

async function autoApprove(popup, label) {
  for (let i = 0; i < 25; i += 1) {
    const approve = popup.locator("button", { hasText: /^Approve$/ }).first();
    if (await approve.isVisible().catch(() => false)) {
      await approve.click({ timeout: 1500 }).catch(() => {});
      log(`approved (${label})`);
      return true;
    }
    await wait(300);
  }
  log(`⚠ no Approve button surfaced for ${label}`);
  return false;
}

async function runSite(siteName, popup, sw) {
  const origin = ORIGINS[siteName];
  if (!origin) throw new Error(`unknown site ${siteName}`);
  log(`──── ${siteName} (${origin}) ────`);

  const page = await ctx.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await wait(2500);

  // 1. requestAccounts (needs approval the first time per origin)
  log("requestAccounts…");
  const reqAccountsPromise = page.evaluate(() =>
    window.chia.request({ method: "requestAccounts" }).then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, code: e?.code, message: e?.message })),
  );
  await wait(600);
  await autoApprove(popup, "requestAccounts");
  const accRes = await reqAccountsPromise;
  log("  →", JSON.stringify(accRes).slice(0, 200));

  // 2. createOffer 1 AIR → small XCH
  log(`createOffer offer=${AIR_OFFER_MOJOS} AIR-mojos → request=${XCH_REQUEST_MOJOS} XCH-mojos`);
  const offerPromise = page.evaluate(
    async ({ airId, offerAmt, xchAmt }) => {
      try {
        const r = await window.chia.request({
          method: "createOffer",
          params: {
            offerAssets: [{ assetId: airId, amount: offerAmt }],
            requestAssets: [{ assetId: "", amount: xchAmt }],
            fee: 0,
          },
        });
        return { ok: true, result: r };
      } catch (e) {
        return { ok: false, code: e?.code, message: e?.message };
      }
    },
    { airId: AIR_ASSET_ID, offerAmt: AIR_OFFER_MOJOS, xchAmt: XCH_REQUEST_MOJOS },
  );
  await wait(800);
  await autoApprove(popup, "createOffer");
  const offer = await offerPromise;

  if (offer.ok) {
    const offerStr =
      typeof offer.result === "string"
        ? offer.result
        : offer.result?.offer ?? JSON.stringify(offer.result);
    log(`✓ offer built — length=${offerStr.length} chars`);
    log(`  preview: ${String(offerStr).slice(0, 80)}…`);
    writeFileSync(`${OUT_DIR}/${siteName}-offer.txt`, String(offerStr));
  } else {
    log(`✗ createOffer failed code=${offer.code} msg=${offer.message?.slice(0, 200)}`);
  }

  await page.screenshot({ path: `${OUT_DIR}/${siteName}-final.png` });
  return offer;
}

try {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
  const extId = sw.url().split("/")[2];
  log("ext id:", extId);
  log("userData:", USER_DATA);

  sw.on("console", (msg) => {
    const t = msg.text();
    if (t.includes("[loroco/")) console.log(`  SW: ${t}`);
  });

  const popup = await ensureWalletReady(extId);

  // Quick sync check — short-circuit if AIR already in store.
  async function airBalance() {
    return popup.evaluate(async (airId) => {
      const fp = (await chrome.storage.session.get("activeFingerprint")).activeFingerprint;
      const res = await chrome.runtime.sendMessage({
        from: "popup",
        kind: "get-coin-store",
        fingerprint: fp,
      });
      if (!res?.ok) return null;
      const v = res.value;
      const key = airId.startsWith("0x") ? airId : `0x${airId}`;
      const cat = (v?.cats ?? {})[key] ?? (v?.cats ?? {})[airId.replace(/^0x/, "")];
      if (!cat) return { found: false, all: Object.keys(v?.cats ?? {}).length };
      let total = 0n;
      let n = 0;
      for (const c of cat.coins ?? []) {
        if (!c.spent) { total += BigInt(c.amount); n += 1; }
      }
      return { found: true, total: total.toString(), coins: n };
    }, AIR_ASSET_ID);
  }

  const SYNC_TIMEOUT_S = Number.parseInt(process.env.SYNC_TIMEOUT_S ?? "180", 10);
  log(`waiting up to ${SYNC_TIMEOUT_S}s for AIR to surface…`);
  for (let i = 0; i < SYNC_TIMEOUT_S; i += 1) {
    const b = await airBalance();
    if (b?.found) {
      log(`✓ AIR in store: total=${b.total} mojos, coins=${b.coins}`);
      break;
    }
    if (i % 15 === 0) log(`  t+${i}s waiting… (cats so far: ${b?.all ?? "?"})`);
    await wait(1000);
  }

  const results = {};
  for (const site of SITES) {
    results[site] = await runSite(site, popup, sw);
    await wait(1000);
  }

  log("=== SUMMARY ===");
  for (const [site, res] of Object.entries(results)) {
    log(`  ${site}: ${res.ok ? "✓ offer built" : `✗ ${res.code} ${res.message?.slice(0, 120)}`}`);
  }
  writeFileSync(`${OUT_DIR}/summary.json`, JSON.stringify(results, null, 2));
} catch (err) {
  console.error("[offer] ERROR:", err);
  process.exit(1);
} finally {
  await wait(1000);
  await ctx.close();
}
