// Coverage smoke for the Loroco WC-bypass surface — Oleada 1 reads (11
// methods) + Oleada 2 multi-output writes (4 methods). Walks the same dApp
// page as pw-goby-coverage.mjs and confirms every new method is WIRED, i.e.
// the rpc-router routes it to a real handler instead of replying 4004
// MethodNotFound.
//
// Side-effect policy: writes are intentionally invoked with INVALID params
// (empty `outputs`, missing `assetId`, etc.) so the handler short-circuits
// in its param-validation block before any SpendBundle is ever built or
// broadcast. The approval popup still pops — we auto-approve — and the
// handler's 4000 InvalidParams is what we report as "wired correctly".
// Set BROADCAST=1 to flip the writes into real-value mode (uses tiny mojos
// against a self-owned address — actually broadcasts).
//
// Run:
//   node scripts/pw-loroco-extensions.mjs
//   USER_DATA=/tmp/Loroco-PW-Shared node scripts/pw-loroco-extensions.mjs
//   BROADCAST=1 node scripts/pw-loroco-extensions.mjs

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

const __here = dirname(fileURLToPath(import.meta.url));
const EXT_PATH = resolve(__here, "..", "packages/extension/.output/chrome-mv3");
const USER_DATA = process.env.USER_DATA ?? "/tmp/Loroco-PW-Shared";
const SHOT_DIR = "/tmp/loroco-pw-extensions";
const MNEMONIC =
  process.env.MNEMONIC ??
  "charge day cloth frame purpose lake method segment fat gadget regret open better rent visual picnic crater degree budget satoshi shop maple depart host";
const PASSWORD = process.env.PASSWORD ?? "marvin";
const BROADCAST = process.env.BROADCAST === "1";

mkdirSync(SHOT_DIR, { recursive: true });
const log = (...a) => console.log("[loroco-ext]", ...a);

// Bech32 puzzle hash known to be in our test wallet's first derivation
// window (used as self-send recipient when BROADCAST=1). Deriving on the
// fly is overkill for a smoke; reusing a stable address keeps the script
// hermetic. The wallet `marvin` owns these addresses on derivation_index 0.
const SELF_ADDRESS = "xch10qx8jkn8sh9prltm0nemvt53vk75dn47g78d39y448cnpaaftchqkcnygl";

// Each entry:
//   - name: canonical CHIP-0002 method
//   - params: payload sent through window.loroco.request
//   - mutating: true → auto-approve the popup before reading the result
//   - expectInvalidParams: true → 4000 is the success signal (intended for
//     writes invoked in dry-validation mode; bypassed when BROADCAST=1)
const METHODS = [
  // ── Oleada 1 reads (no approval, expect OK or a real error code) ─────
  { name: "getCoins", params: { type: "xch", limit: 5 }, mutating: false },
  { name: "getCoinsByIds", params: { coinIds: ["0x" + "00".repeat(32)] }, mutating: false },
  { name: "isAssetOwned", params: { type: "cat", assetId: "0x" + "ab".repeat(32) }, mutating: false },
  { name: "getCats", params: { limit: 50 }, mutating: false },
  { name: "getAllCats", params: { limit: 50 }, mutating: false },
  { name: "getToken", params: { assetId: "0x" + "ab".repeat(32) }, mutating: false },
  { name: "getDerivations", params: { limit: 3, hardened: false }, mutating: false },
  { name: "getTransactions", params: { limit: 10 }, mutating: false },
  { name: "getPendingTransactions", params: undefined, mutating: false },
  { name: "getOffers", params: { limit: 10 }, mutating: false },
  { name: "getOffer", params: { id: "0x" + "00".repeat(32) }, mutating: false },

  // ── Dry-validating writes first (no on-chain side effects) ──────────
  // We run the writes whose param-validation kicks in BEFORE input
  // selection ahead of the auto-broadcasters (combine/split/createDid).
  // This keeps the smoke from frying the SW with mempool back-pressure
  // before we've checked every method.
  {
    name: "transferDid",
    params: {
      didDerivationIndex: 0,
      recipientAddress: SELF_ADDRESS,
    },
    mutating: true,
    expectInvalidParams: true,
  },
  // normalizeDids dry-fail: empty didCoinIds → 4000.
  {
    name: "normalizeDids",
    params: { didCoinIds: [], didDerivationIndices: [] },
    mutating: true,
    expectInvalidParams: true,
  },
  // multiSend dry-fail: no outputs at all → 4000.
  {
    name: "multiSend",
    params: {},
    mutating: true,
    expectInvalidParams: true,
  },
  // ── Oleada 2 writes (approval required, dry-validation by default) ───
  {
    name: "bulkSendXch",
    params: BROADCAST
      ? { outputs: [{ address: SELF_ADDRESS, amount: "1" }], fee: 0 }
      : { outputs: [], fee: 0 },
    mutating: true,
    expectInvalidParams: !BROADCAST,
  },
  {
    name: "bulkSendCat",
    params: BROADCAST
      ? {
          assetId: "0x" + "ab".repeat(32),
          outputs: [{ address: SELF_ADDRESS, amount: "1" }],
          fee: 0,
        }
      : { outputs: [] },
    mutating: true,
    expectInvalidParams: !BROADCAST,
  },
  {
    name: "combine",
    params: BROADCAST ? { maxInputs: 2, fee: 0 } : { maxInputs: 1 },
    mutating: true,
    expectInvalidParams: !BROADCAST,
  },
  {
    name: "split",
    params: BROADCAST ? { parts: 2, fee: 0 } : { parts: 1 },
    mutating: true,
    expectInvalidParams: !BROADCAST,
  },

  // ── Oleada 3 writes (approval required, dry-validation by default) ───
  // issueCat dry-fail: amount 0 → 4000. BROADCAST: tiny supply to self.
  {
    name: "issueCat",
    params: BROADCAST
      ? { recipientAddress: SELF_ADDRESS, amount: "1", fee: 0 }
      : { recipientAddress: SELF_ADDRESS, amount: "0" },
    mutating: true,
    expectInvalidParams: !BROADCAST,
  },
  // createDid dry-fail: no XCH coins yet on fresh wallet → 4029.
  // BROADCAST: tiny self-create, will consume 1 mojo.
  {
    name: "createDid",
    params: BROADCAST ? { fee: 0 } : { fee: 0 },
    mutating: true,
    // createDid has no validation that can be triggered by params — it
    // always fails at input selection (4029) on a thin wallet. Accept
    // either 4029 (no XCH) or 4000 if a future param check kicks in.
    expectInvalidParams: false,
  },
  // addNftUri: dry-fail with empty uri → 4000 (caught before NFT lookup).
  // BROADCAST: would require an actually-owned NFT — skip in this smoke,
  // the dry-validation path is enough to prove the method is wired.
  {
    name: "addNftUri",
    params: {
      launcherId: "0x" + "00".repeat(32),
      uriKind: "data",
      uri: "",
    },
    mutating: true,
    expectInvalidParams: true,
  },

  // ── Fase 3 stub reads (no approval, always return [] / null) ─────────
  { name: "getDids", params: undefined, mutating: false },
  { name: "getNftCollections", params: undefined, mutating: false },
  { name: "getNftCollection", params: { collectionId: "0x" + "00".repeat(32) }, mutating: false },
  { name: "getMinterDidIds", params: undefined, mutating: false },
];

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

try {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
  const extId = sw.url().split("/")[2];
  log("ext id:", extId);

  // Forward SW console — handy when a handler throws unexpectedly.
  sw.on("console", (msg) => {
    const t = msg.text();
    if (t.includes("[loroco/")) console.log(`  SW: ${t}`);
  });

  // ── Import or unlock wallet ────────────────────────────────────────────
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForLoadState("domcontentloaded");
  await wait(900);

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
      await wait(1800);
    }
  }
  log("wallet unlocked");

  // ── Open dexie as the test origin ──────────────────────────────────────
  const dapp = await ctx.newPage();
  await dapp.goto("https://dexie.space", { waitUntil: "networkidle", timeout: 30_000 });
  await wait(2500);

  // Approval popup auto-clicker (MetaMask-style inline popup).
  async function autoApproveIfPending() {
    for (let i = 0; i < 12; i += 1) {
      const approveBtn = popup.locator("button", { hasText: /^Approve$/ }).first();
      if (await approveBtn.isVisible().catch(() => false)) {
        try {
          await approveBtn.click({ timeout: 1500 });
          log("   approved via popup");
          await wait(400);
          return true;
        } catch {}
      }
      await wait(300);
    }
    return false;
  }

  log("granting origin via requestAccounts…");
  const initial = dapp.evaluate(() =>
    window.loroco.request({ method: "requestAccounts" }).catch((e) => e?.message),
  );
  await wait(800);
  await autoApproveIfPending();
  await initial;
  await wait(600);

  // ── Walk through every new method ──────────────────────────────────────
  const results = [];
  for (const m of METHODS) {
    log(`→ ${m.name}${m.mutating ? " (auto-approve)" : ""}`);
    const callP = dapp.evaluate(
      async ({ name, params }) => {
        try {
          const r = await window.loroco.request({ method: name, params });
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
    results.push({ name: m.name, expectInvalidParams: m.expectInvalidParams, ...out });
    log(`   ←`, JSON.stringify(out).slice(0, 200));
    await wait(400);
  }

  // ── Summary ────────────────────────────────────────────────────────────
  log("=== SUMMARY ===");
  let regressions = 0;
  for (const r of results) {
    let tag;
    if (r.ok) {
      tag = "OK";
    } else if (r.code === 4004) {
      tag = "METHOD-NOT-FOUND";
      regressions += 1;
    } else if (r.code === 4000 && r.expectInvalidParams) {
      tag = "DRY-OK (4000)";
    } else {
      // Any other structured code is a legitimate wallet-side rejection —
      // the method IS implemented, the params/wallet state just doesn't
      // satisfy it (e.g. 4029 spendable-exceeded for combine on a thin wallet).
      tag = `err ${r.code ?? "?"}`;
    }
    log(`  ${tag.padEnd(18)} ${r.name}`);
  }
  if (regressions > 0) {
    log(`FAIL: ${regressions} method(s) returned unexpected 4004 (not wired)`);
    process.exit(1);
  }
  log(`✓ all ${results.length} Loroco-extension methods routed correctly`);
} catch (err) {
  console.error("[loroco-ext] ERROR:", err);
  process.exit(1);
} finally {
  await ctx.close();
}
