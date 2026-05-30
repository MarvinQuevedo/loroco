// Capture every approval screen the popup renders, one method at a time.
//
// For each mutating/approval method exposed by the playground dApp, this:
//   1. triggers the call from the dApp page
//   2. opens the popup, waits for the approval screen
//   3. screenshots it (shots/approvals/<method>.png) + dumps innerText
//   4. REJECTS (never approves — nothing is spent/broadcast)
//
// Chrome-for-Testing with an MV3 extension crashes its whole context every
// few popups. This script is CRASH-RESILIENT: on any "context/browser closed"
// error it relaunches the session and RESUMES — already-captured methods are
// skipped (the .png on disk is the resume marker), so a crash costs one retry,
// not the whole run. Set FORCE=1 to recapture everything from scratch.
//
// Usage: pnpm build:fast && node scripts/pw-approval-shots.mjs
// Env:   PROFILE, MNEMONIC, PASSWORD, ONLY=transfer,createOffer  FORCE=1  ONSCREEN=1

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const EXT = resolve("packages/extension/.output/chrome-mv3");
const HTML = resolve("scripts/playground/index.html");
const SHOTS = resolve("shots/approvals");
const USER_DATA = process.env.PROFILE ?? "/tmp/Loroco-PW-Shared";
const MNEMONIC = process.env.MNEMONIC ??
  "charge day cloth frame purpose lake method segment fat gadget regret open better rent visual picnic crater degree budget satoshi shop maple depart host";
const PASSWORD = process.env.PASSWORD ?? "marvin";
const PORT = Number(process.env.PORT ?? 8141);
const ONLY = (process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const FORCE = process.env.FORCE === "1";
const OFFSCREEN = process.env.ONSCREEN === "1" ? [] : ["--window-position=-2400,0"];

const SAMPLE_OFFER = process.env.SAMPLE_OFFER ?? "offer1...";

// Methods that open an approval popup, with params that produce a meaningful
// summary. Self-sends ($ADDRESS) keep them harmless even if approved.
const CASES = [
  ["walletSwitchChain", { chainId: "testnet11" }],
  ["walletWatchAsset", { type: "CAT", options: { assetId: "0xa628c1c2c6fcb74d53746157e438e108eab5c0bb3e5c80ff9b1910b3e4832913", symbol: "SBX", logo: "https://icons.dexie.space/sbx.png" } }],
  ["signMessage", { message: "0x48656c6c6f20776f726c64", publicKey: "$PUBKEY" }],
  ["signMessageByAddress", { message: "0x48656c6c6f20776f726c64", address: "$ADDRESS" }],
  ["transfer", { to: "$ADDRESS", amount: "1500000000000", assetId: null, fee: "1000000000" }],
  ["bulkSendXch", { outputs: [{ address: "$ADDRESS", amount: "1500000000000" }, { address: "$ADDRESS", amount: "250000000000" }], fee: "1000000000" }],
  ["bulkSendCat", { assetId: "0xa628c1c2c6fcb74d53746157e438e108eab5c0bb3e5c80ff9b1910b3e4832913", outputs: [{ address: "$ADDRESS", amount: "1000" }], fee: "1000000000" }],
  ["multiSend", { xchOutputs: [{ address: "$ADDRESS", amount: "1500000000000" }], catOutputs: { assetId: "0xa628c1c2c6fcb74d53746157e438e108eab5c0bb3e5c80ff9b1910b3e4832913", outputs: [{ address: "$ADDRESS", amount: "1000" }] }, fee: "1000000000" }],
  ["createOffer", { offerAssets: [{ assetId: "", amount: "1500000000000" }], requestAssets: [{ assetId: "0xa628c1c2c6fcb74d53746157e438e108eab5c0bb3e5c80ff9b1910b3e4832913", amount: "1000" }], fee: "1000000000" }],
  ["takeOffer", { offer: SAMPLE_OFFER, fee: "1000000000" }],
  ["cancelOffer", { id: "0x" + "ab".repeat(32), secure: true, fee: "1000000000" }],
  ["issueCat", { recipientAddress: "$ADDRESS", amount: "1000000", fee: "1000000000" }],
  ["createDid", { fee: "1000000000" }],
  ["addNftUri", { launcherId: "0x" + "cd".repeat(32), uriKind: "data", uri: "https://example.com/some/really/long/path/to/an/asset/file-name-here.png", fee: "1000000000" }],
  ["transferDid", { didCoinId: "0x" + "ef".repeat(32), didDerivationIndex: 0, recipientAddress: "$ADDRESS", fee: "1000000000" }],
  ["bulkMintNfts", { did: "did:chia1abcdefghijklmnop", didCoinId: "0x" + "ef".repeat(32), didDerivationIndex: 0, nfts: [{ dataUris: ["https://example.com/x.png"], dataHash: "0x" + "00".repeat(32), editionNumber: 1, editionTotal: 100 }, { dataUris: ["https://example.com/y.png"], editionNumber: 2, editionTotal: 100 }] }],
];

mkdirSync(SHOTS, { recursive: true });
const server = createServer((_q, r) => { r.setHeader("Content-Type", "text/html"); r.end(readFileSync(HTML)); });
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const log = (...a) => console.log("[shots]", ...a);
const isCrash = (e) => /closed|crash|Target page|Navigation|detached|disconnected/i.test(String(e?.message ?? e));

function subst(v, ctxVals) {
  if (typeof v === "string") return Object.prototype.hasOwnProperty.call(ctxVals, v) ? ctxVals[v] : v;
  if (Array.isArray(v)) return v.map((x) => subst(x, ctxVals));
  if (v && typeof v === "object") { const o = {}; for (const k in v) o[k] = subst(v[k], ctxVals); return o; }
  return v;
}

// Build a fresh session: launch context, unlock/import, connect, resolve ctx.
// Returns an object with everything the capture loop needs. Throws on real
// (non-crash) setup failure so the caller can give up.
async function launchSession() {
  const ctx = await chromium.launchPersistentContext(USER_DATA, {
    headless: false, channel: "chromium",
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      "--no-first-run", "--no-default-browser-check",
      ...OFFSCREEN, "--window-size=1280,900"],
  });
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];

  let popup = await ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForLoadState("domcontentloaded");
  await wait(1200);
  const t = await popup.locator("body").innerText();
  if (/Import mnemonic|Create/i.test(t) && !/Unlock|Enter your password/i.test(t)) {
    log("importing wallet…");
    const b = popup.locator("button", { hasText: /Import mnemonic/i }).first();
    if (await b.isVisible().catch(() => false)) await b.click();
    await wait(400);
    await popup.locator("textarea").first().fill(MNEMONIC);
    await popup.locator("input[type='password']").first().fill(PASSWORD);
    await popup.locator("button", { hasText: /^Continue$/ }).first().click();
    await wait(4000);
  } else if (/Unlock|Enter your password/i.test(t)) {
    log("unlocking…");
    await popup.locator("input[type='password']").first().fill(PASSWORD);
    await popup.locator("button", { hasText: /Unlock|Continue/i }).first().click();
    await wait(3000);
  }

  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  await wait(1500);
  await page.click("#btnAutofill").catch(() => {});
  await wait(3500);

  const session = { ctx, extId, popup, page };

  session.ensurePopup = async () => {
    if (!session.popup || session.popup.isClosed()) {
      session.popup = await ctx.newPage();
      await session.popup.setViewportSize({ width: 380, height: 600 });
    }
    await session.popup.goto(`chrome-extension://${extId}/popup.html`).catch(() => {});
    await session.popup.waitForLoadState("domcontentloaded").catch(() => {});
    await wait(700);
    return session.popup;
  };
  session.callRaw = (method, params) =>
    session.page.evaluate(async ({ method, params }) => {
      const p = window.loroco || window.chia || window.ozone;
      try {
        const r = await p.request(params === undefined ? { method } : { method, params });
        return { ok: true, r };
      } catch (e) { return { ok: false, e: String(e?.message ?? e) }; }
    }, { method, params });

  // connect (idempotent — persistent profile usually keeps the grant, so this
  // returns without a popup on reruns; we only auto-approve if one shows).
  const connectProm = session.callRaw("connect", { eager: false });
  for (let i = 0; i < 14; i++) {
    const pp = await session.ensurePopup();
    const b = pp.locator("button", { hasText: /^Approve$/ }).first();
    if (await b.isVisible().catch(() => false)) { try { await b.click({ timeout: 600 }); break; } catch {} }
    await wait(300);
  }
  await connectProm.catch(() => {});
  await wait(600);

  const addrRes = await session.callRaw("getAddress", {});
  const pkRes = await session.callRaw("getPublicKeys", { limit: 1, offset: 0, hardened: false });
  const realAddr = (addrRes.ok && (addrRes.r?.address || addrRes.r)) || null;
  const realPk = (pkRes.ok && (pkRes.r?.[0]?.publicKey || pkRes.r?.[0] || pkRes.r?.publicKeys?.[0])) || null;
  session.fallback = {
    $ADDRESS: (typeof realAddr === "string" ? realAddr : null) ?? "xch1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsl7r6w",
    $PUBKEY: (typeof realPk === "string" ? realPk : null) ?? "0x" + "00".repeat(48),
  };
  log("session ready · ctx:", JSON.stringify(session.fallback));
  return session;
}

// Capture ONE method against a live session. Returns innerText, or throws a
// crash error (so the caller relaunches) — non-crash issues resolve to null.
async function captureOne(session, method, rawParams) {
  const params = subst(rawParams, session.fallback);
  // Fire-and-forget: provider.request only resolves once we approve/reject.
  // If the popup never surfaces we must NOT await it (it would hang forever) —
  // we always reject below to settle whatever is queued.
  const prom = session.callRaw(method, params).catch(() => {});
  await wait(600);
  let captured = null;
  let rejected = false;
  for (let i = 0; i < 12; i++) {
    const pp = await session.ensurePopup();
    const approve = pp.locator("button", { hasText: /^Approve$/ }).first();
    if (await approve.isVisible().catch(() => false)) {
      await wait(1600); // let decode_offer / analyze_coin_spends land
      captured = await pp.locator("body").innerText().catch(() => "");
      await pp.screenshot({ path: `${SHOTS}/${method}.png`, fullPage: true });
      const reject = pp.locator("button", { hasText: /^(Reject|Cancel|Deny|Decline)$/ }).first();
      if (await reject.isVisible().catch(() => false)) { await reject.click({ timeout: 800 }).catch(() => {}); rejected = true; }
      break;
    }
    await wait(400);
  }
  // Settle the pending request so it can't bleed into the next method's popup.
  // Reject anything still showing; never block on the request promise.
  if (!rejected) {
    const pp = await session.ensurePopup().catch(() => null);
    const reject = pp?.locator("button", { hasText: /^(Reject|Cancel|Deny|Decline)$/ }).first();
    if (reject && await reject.isVisible().catch(() => false)) await reject.click({ timeout: 800 }).catch(() => {});
  }
  await Promise.race([prom, wait(2500)]);
  await wait(300);
  return captured;
}

const todo = CASES.filter(([m]) => (!ONLY.length || ONLY.includes(m)));
const report = [];
let session = null;
const MAX_RELAUNCH = 6;
let relaunches = 0;

try {
  for (let idx = 0; idx < todo.length; idx++) {
    const [method, rawParams] = todo[idx];
    if (!FORCE && existsSync(`${SHOTS}/${method}.png`)) {
      log(`⏭  ${method} (already captured — skip)`);
      report.push({ method, captured: null, skipped: true });
      continue;
    }
    let attempt = 0;
    while (true) {
      attempt++;
      try {
        if (!session) {
          if (relaunches > MAX_RELAUNCH) throw new Error(`exceeded ${MAX_RELAUNCH} relaunches`);
          log(relaunches === 0 ? "launching session…" : `relaunching session (#${relaunches})…`);
          relaunches++;
          session = await launchSession();
        }
        log(`→ ${method}${attempt > 1 ? ` (retry ${attempt - 1})` : ""}`);
        const captured = await captureOne(session, method, rawParams);
        report.push({ method, captured });
        break;
      } catch (e) {
        if (isCrash(e)) {
          log(`✗ ${method} crashed (${e.message.split("\n")[0]}) — relaunching & resuming`);
          try { await session?.ctx.close(); } catch {}
          session = null;
          if (attempt <= 3) { await wait(800); continue; } // retry this method
          log(`✗ ${method} gave up after ${attempt} crashes`);
          report.push({ method, captured: null, failed: true });
          break;
        }
        log(`✗ ${method} (non-crash): ${e.message}`);
        report.push({ method, captured: null, failed: true });
        break;
      }
    }
  }

  console.log("\n\n========== APPROVAL SCREEN DUMPS ==========\n");
  for (const { method, captured, skipped } of report) {
    console.log(`\n───────── ${method} ─────────`);
    if (skipped) { console.log("  (skipped — png already on disk)"); continue; }
    if (!captured) { console.log("  ⚠ NO APPROVAL SCREEN CAPTURED"); continue; }
    console.log(captured.split("\n").map((l) => "  " + l).join("\n"));
  }
  const ok = report.filter((r) => r.captured || r.skipped || existsSync(`${SHOTS}/${r.method}.png`)).length;
  log(`done · ${ok}/${todo.length} methods have a screenshot · ${relaunches - 1} relaunch(es)`);
} catch (e) {
  console.error("[shots] FATAL:", e.message, e.stack); process.exitCode = 1;
} finally {
  try { await session?.ctx.close(); } catch {}
  server.close();
}
