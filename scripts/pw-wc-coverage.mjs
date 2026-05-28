// Coverage probe for the Sage WalletConnect2 fallback surface.
//
// We don't run a real WC2 pairing: dApps that already speak WC2 send the
// same JSON-RPC payloads to window.chia.request, and Loroco's router
// (`packages/extension/src/background/rpc-router.ts`) recognises every
// chia_*, chip0002_* and snake_case alias. This script exercises the
// methods + aliases that have non-trivial shape variants, so a regression
// in the canonical/originalMethod threading or in METHOD_ALIASES will
// surface immediately.
//
// Mirrors the layout of pw-goby-coverage.mjs — import the wallet via the
// popup, hop to an already-connected origin (dexie), then probe each
// method through window.chia.request. Auto-approves popup prompts.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

const __here = dirname(fileURLToPath(import.meta.url));
const EXT_PATH = resolve(__here, "..", "packages/extension/.output/chrome-mv3");
const USER_DATA = process.env.USER_DATA ?? "/tmp/Loroco-PW-Shared";
const SHOT_DIR = "/tmp/loroco-pw-wc";
const MNEMONIC =
  process.env.MNEMONIC ??
  "charge day cloth frame purpose lake method segment fat gadget regret open better rent visual picnic crater degree budget satoshi shop maple depart host";

mkdirSync(SHOT_DIR, { recursive: true });
const log = (...a) => console.log("[wc]", ...a);

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

// `assert(check)` runs the callback against the response and reports a
// pass/fail line. `expectError` is the code we expect when ok===false; if
// set we also accept that path as a pass.
const CASES = [
  // ── Read-only methods (no approval) ─────────────────────────────────────
  {
    name: "getAddress",
    params: undefined,
    mutating: false,
    assert: (r) =>
      r.ok &&
      typeof r.result?.address === "string" &&
      r.result.address.startsWith("xch1") &&
      "ok",
  },
  {
    name: "chia_getAddress",
    params: {},
    mutating: false,
    assert: (r) =>
      r.ok &&
      typeof r.result?.address === "string" &&
      r.result.address.startsWith("xch1") &&
      "ok",
  },
  {
    name: "get_address",
    params: {},
    mutating: false,
    assert: (r) =>
      r.ok &&
      typeof r.result?.address === "string" &&
      r.result.address.startsWith("xch1") &&
      "ok",
  },
  // chip0002_getPublicKeys(hardened:true) needs the wallet UNLOCKED. We do
  // that via the popup import — but in case the master_sk cache is empty
  // (SW restarted), we accept the 4900-style unauthorised error too.
  {
    name: "chip0002_getPublicKeys",
    params: { limit: 1, offset: 0, hardened: true },
    mutating: false,
    assert: (r) =>
      (r.ok && Array.isArray(r.result) && typeof r.result[0] === "string") ||
      r.code === 4001 ||
      r.code === 4100,
  },
  // chia_getNfts → WC2 shape: { nfts: [...] } camelCase.
  {
    name: "chia_getNfts",
    params: { limit: 2, offset: 0 },
    mutating: false,
    assert: (r) => r.ok && Array.isArray(r.result?.nfts),
  },
  // Same handler, Goby/Loroco name → flat NftInfo[] (snake_case).
  {
    name: "getNFTs",
    params: { limit: 2, offset: 0 },
    mutating: false,
    assert: (r) => r.ok && Array.isArray(r.result),
  },
  // DID branch: empty list + zero balance is the documented Fase 1 behaviour.
  {
    name: "getAssetCoins(did)",
    method: "getAssetCoins",
    params: { type: "did", assetId: null, limit: 10 },
    mutating: false,
    assert: (r) => r.ok && Array.isArray(r.result) && r.result.length === 0,
  },
  {
    name: "getAssetBalance(did)",
    method: "getAssetBalance",
    params: { type: "did", assetId: null },
    mutating: false,
    assert: (r) =>
      r.ok && r.result?.confirmed === "0" && r.result?.spendableCoinCount === 0,
  },
  // ── Mutating methods (require approval) ──────────────────────────────────
  // chia_send accepts { address } and returns {}. With amount 0 we expect
  // 4001 invalidParams from the handler ("transfer requires …") — the
  // important thing is that the address→to remap doesn't break.
  {
    name: "chia_send",
    params: {
      address: "xch10qx8jkn8sh9prltm0nemvt53vk75dn47g78d39y448cnpaaftchqkcnygl",
      amount: "1",
    },
    mutating: true,
    assert: (r) =>
      // Any non-4004 outcome means the handler accepted the WC2 shape.
      r.code !== 4004,
  },
  // chia_cancelOffer (secure path) — Fase 2 wires this to send_xch using
  // the offer's stored input_coins. With a synthetic id the handler reaches
  // "offer not found in local storage" → 4000, which proves the secure
  // branch no longer hard-fails with the legacy 4004 "not implemented" stub.
  {
    name: "chia_cancelOffer",
    params: { id: "0x" + "00".repeat(32) },
    mutating: true,
    assert: (r) =>
      r.code === 4000 &&
      /not found in local storage/i.test(r.message ?? ""),
  },
  // Local-cancel branch: same handler via the Goby name with secure:false.
  // Silent on unknown ids (idempotent) — returns { cancelled: false }.
  {
    name: "cancelOffer(local)",
    method: "cancelOffer",
    params: { id: "0x" + "00".repeat(32), secure: false },
    mutating: true,
    assert: (r) => r.ok && typeof r.result?.cancelled === "boolean",
  },
  // chia_bulkMintNfts — Fase 2 wires the WASM endpoint, but DID resolution
  // (launcher → current coin) still requires Fase 3. The handler now reaches
  // decode_address first; with a non-bech32m DID it fails with 4000
  // "invalid DID encoding", proving the route is past the old stub.
  {
    name: "chia_bulkMintNfts",
    params: {
      did: "0x" + "11".repeat(32),
      nfts: [{ address: "xch10qx8jkn8sh9prltm0nemvt53vk75dn47g78d39y448cnpaaftchqkcnygl" }],
    },
    mutating: true,
    assert: (r) =>
      r.code === 4000 &&
      /invalid DID encoding/i.test(r.message ?? ""),
  },
];

try {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
  const extId = sw.url().split("/")[2];
  log("ext id:", extId);

  // Import wallet (only if the persistent profile hasn't been bootstrapped).
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForLoadState("domcontentloaded");
  await wait(1000);
  const popupText = await popup.locator("body").innerText();
  if (/Import|Create/i.test(popupText) && !/balance/i.test(popupText)) {
    const importBtn = popup.locator("button", { hasText: /Import mnemonic/i }).first();
    if (await importBtn.isVisible().catch(() => false)) await importBtn.click();
    await wait(400);
    await popup.locator("textarea").first().fill(MNEMONIC);
    await popup.locator("input[type='password']").first().fill("marvin");
    await popup.locator("button", { hasText: /^Continue$/ }).first().click();
    await wait(3500);
  }
  log("wallet ready");

  const dexie = await ctx.newPage();
  await dexie.goto("https://dexie.space", { waitUntil: "networkidle", timeout: 30_000 });
  await wait(2500);

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

  // Bootstrap: connect this origin (skipped silently if already connected).
  const initial = dexie.evaluate(() =>
    window.chia.request({ method: "requestAccounts" }).catch((e) => e?.message),
  );
  await wait(800);
  await autoApproveIfPending();
  await initial;
  await wait(800);

  let passed = 0;
  let failed = 0;
  const fails = [];
  for (const c of CASES) {
    const method = c.method ?? c.name;
    log(`→ ${c.name}${c.mutating ? " (auto-approve)" : ""}`);
    const callP = dexie.evaluate(
      async ({ method, params }) => {
        try {
          const r = await window.chia.request({ method, params });
          return { ok: true, result: r };
        } catch (e) {
          return { ok: false, code: e?.code, message: e?.message };
        }
      },
      { method, params: c.params },
    );
    if (c.mutating) {
      await wait(500);
      await autoApproveIfPending();
    }
    const out = await callP;
    const ok = Boolean(c.assert(out));
    if (ok) {
      passed += 1;
      log(`   ✓ ${JSON.stringify(out).slice(0, 160)}`);
    } else {
      failed += 1;
      fails.push({ name: c.name, response: out });
      log(`   ✗ ${JSON.stringify(out).slice(0, 200)}`);
    }
    await wait(300);
  }

  log("");
  log(`=== SUMMARY ===`);
  log(`passed: ${passed}/${CASES.length}`);
  if (failed > 0) {
    log("FAIL:");
    for (const f of fails) {
      log(`  - ${f.name}: ${JSON.stringify(f.response).slice(0, 200)}`);
    }
    process.exit(1);
  }
  log("✓ all Sage WC2 shape & alias checks passed");
} catch (err) {
  console.error("[wc] ERROR:", err);
  process.exit(1);
} finally {
  await ctx.close();
}
