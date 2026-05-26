// Walk every Goby method documented at docs.goby.app and confirm our
// provider routes each to SOMETHING — either a real engine response or a
// structured error (4001 Unauthorized, 4002 UserRejected, 4003 invalid
// params, etc.). What we MUST NOT see is 4004 "method not found": that
// would mean we forgot to wire a handler.
//
// The wallet is imported via the popup first, then dexie.space is used as
// a convenient already-connected origin (we approve once, then probe every
// method through window.chia.request inside the dexie page).

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";

const EXT_PATH =
  "/Users/marvin/Projects/Ozone/sage-web/ozone-web-extension/packages/extension/.output/chrome-mv3";
const USER_DATA = "/tmp/Loroco-PW-Cov";
const SHOT_DIR = "/tmp/loroco-pw-cov";
const MNEMONIC =
  process.env.MNEMONIC ??
  "charge day cloth frame purpose lake method segment fat gadget regret open better rent visual picnic crater degree budget satoshi shop maple depart host";

mkdirSync(SHOT_DIR, { recursive: true });
const log = (...a) => console.log("[cov]", ...a);

const ctx = await chromium.launchPersistentContext(USER_DATA, {
  headless: false,
  channel: "chromium",
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-position=0,0",
    "--window-size=1200,900",
  ],
});

// One entry per Goby docs method. `mutating: true` means we expect an
// approval popup; we auto-approve those so the call completes.
// `expectNotImplemented: true` means the method is intentionally surfaced
// as MethodNotFound (4004) — the engine doesn't expose the underlying
// primitive yet, so reporting it loudly is correct behavior.
const METHODS = [
  { name: "chainId", params: undefined, mutating: false },
  { name: "accounts", params: undefined, mutating: false },
  { name: "getPublicKeys", params: { limit: 1, offset: 0, hardened: false }, mutating: false },
  { name: "filterUnlockedCoins", params: { coinNames: [] }, mutating: false },
  { name: "getAssetCoins", params: { type: null, assetId: null, limit: 1 }, mutating: false },
  { name: "getAssetBalance", params: { type: null, assetId: null }, mutating: false },
  { name: "walletSwitchChain", params: { chainId: "mainnet" }, mutating: true },
  {
    name: "walletWatchAsset",
    params: {
      type: "cat",
      options: { assetId: "0x" + "ab".repeat(32), symbol: "TEST", logo: "" },
    },
    mutating: true,
  },
  {
    name: "signMessage",
    params: { message: "0xdeadbeef", publicKey: "0x" + "00".repeat(48) },
    mutating: true,
  },
  // Engine doesn't expose raw signing yet — expect 4004.
  {
    name: "signCoinSpends",
    params: { coinSpends: [], partialSign: true },
    mutating: false,
    expectNotImplemented: true,
  },
  {
    name: "transfer",
    params: {
      to: "xch10qx8jkn8sh9prltm0nemvt53vk75dn47g78d39y448cnpaaftchqkcnygl",
      amount: "1",
      assetId: null,
    },
    mutating: true,
  },
  // No raw-bundle submit endpoint in the engine — expect 4004.
  {
    name: "sendTransaction",
    params: { spendBundle: { coin_spends: [], aggregated_signature: "0x" + "c0".repeat(96) } },
    mutating: false,
    expectNotImplemented: true,
  },
  // make_offer is explicitly out-of-scope in the WASM engine today —
  // expect 4004 until that lands.
  {
    name: "createOffer",
    params: {
      offerAssets: [{ assetId: "", amount: "1" }],
      requestAssets: [{ assetId: "", amount: "1" }],
      fee: 0,
    },
    mutating: false,
    expectNotImplemented: true,
  },
  { name: "takeOffer", params: { offer: "offer1xxx" }, mutating: true },
];

try {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
  const extId = sw.url().split("/")[2];
  log("ext id:", extId);

  // Import wallet
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForLoadState("domcontentloaded");
  await wait(1000);
  if (/Import|Create/i.test(await popup.locator("body").innerText())) {
    const importBtn = popup.locator("button", { hasText: /Import mnemonic/i }).first();
    if (await importBtn.isVisible().catch(() => false)) await importBtn.click();
    await wait(400);
    await popup.locator("textarea").first().fill(MNEMONIC);
    await popup.locator("input[type='password']").first().fill("marvin");
    await popup.locator("button", { hasText: /^Continue$/ }).first().click();
    await wait(3500);
  }
  log("wallet imported");

  // dexie page — connect once so the origin has permission.
  const dexie = await ctx.newPage();
  await dexie.goto("https://dexie.space", { waitUntil: "networkidle", timeout: 30_000 });
  await wait(2500);

  // Approval lives INSIDE the popup now (MetaMask-style). We poll the popup
  // for the inline ApprovalScreen and click Approve when it shows.
  async function autoApproveIfPending() {
    for (let i = 0; i < 10; i += 1) {
      const approveBtn = popup.locator("button", { hasText: /^Approve$/ }).first();
      if (await approveBtn.isVisible().catch(() => false)) {
        try {
          await approveBtn.click({ timeout: 1500 });
          log("   approved via popup");
          await wait(500);
          return true;
        } catch {}
      }
      await wait(300);
    }
    return false;
  }

  log("kicking initial requestAccounts to grant the origin");
  const initial = dexie.evaluate(() =>
    window.chia.request({ method: "requestAccounts" }).catch((e) => e?.message),
  );
  await wait(800);
  await autoApproveIfPending();
  await initial;
  await wait(1000);

  // Now walk through every method.
  const results = [];
  for (const m of METHODS) {
    log(`→ ${m.name}${m.mutating ? " (auto-approve)" : ""}`);
    const callP = dexie.evaluate(
      async ({ name, params }) => {
        try {
          const r = await window.chia.request({ method: name, params });
          return { ok: true, result: r };
        } catch (e) {
          return { ok: false, code: e?.code, message: e?.message };
        }
      },
      m,
    );
    if (m.mutating) {
      await wait(600);
      await autoApproveIfPending();
    }
    const out = await callP;
    results.push({ name: m.name, expectNotImplemented: m.expectNotImplemented, ...out });
    log(`   ←`, JSON.stringify(out).slice(0, 200));
    await wait(400);
  }

  log("=== SUMMARY ===");
  let regressions = 0;
  for (const r of results) {
    let tag;
    if (r.ok) {
      tag = "OK";
    } else if (r.code === 4004 && r.expectNotImplemented) {
      tag = "EXPECTED-404";
    } else if (r.code === 4004) {
      tag = "METHOD-NOT-FOUND";
      regressions += 1;
    } else {
      // Any other structured error code (4001-4029) is a legitimate
      // wallet-side rejection (bad params, insufficient balance, user
      // rejected, …) — i.e. the method IS implemented.
      tag = `err ${r.code ?? "?"}`;
    }
    log(`  ${tag.padEnd(18)} ${r.name}`);
  }
  if (regressions > 0) {
    log(`FAIL: ${regressions} method(s) returned unexpected 4004 (not found)`);
    process.exit(1);
  }
  log(`✓ all ${results.length} Goby methods routed correctly`);
} catch (err) {
  console.error("[cov] ERROR:", err);
  process.exit(1);
} finally {
  await ctx.close();
}
