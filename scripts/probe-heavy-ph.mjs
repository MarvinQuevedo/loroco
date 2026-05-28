// Probe coinset directly for each PH in NFT chunk 7 (unhardened idx 35..39
// + hardened idx 35..39 = 10 PHs). For each, hit
//   POST https://api.coinset.org/get_coin_records_by_hint
// and report:
//   • HTTP status
//   • compressed + decompressed response size
//   • number of coin records returned
//   • approximate per-record byte cost
//
// The PH whose response blows past a few-MB threshold is what's OOM-ing the
// WASM module when it lands in the middle of 10 concurrent fetches.
//
// We piggyback on the bench profile to do the derivation (extension already
// has the wallet imported) — only the final fetch() calls go straight to
// coinset.

import { chromium } from "playwright";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";

const ENV_PATH = "/Users/marvin/Projects/Ozone/loroco/.env";
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

const EXT_PATH =
  "/Users/marvin/Projects/Ozone/loroco/packages/extension/.output/chrome-mv3";
const USER_DATA = "/tmp/Loroco-Probe";
const MNEMONIC = process.env.MNEMONIC;

mkdirSync(USER_DATA, { recursive: true });

const log = (...a) => console.log("[probe]", ...a);

const ctx = await chromium.launchPersistentContext(USER_DATA, {
  headless: true,
  channel: "chromium",
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

try {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
  const extId = sw.url().split("/")[2];

  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForLoadState("domcontentloaded");
  await wait(700);
  if (/Import|Create/i.test(await popup.locator("body").innerText())) {
    log("importing wallet");
    const importBtn = popup.locator("button", { hasText: /Import mnemonic/i }).first();
    if (await importBtn.isVisible().catch(() => false)) await importBtn.click();
    await wait(400);
    await popup.locator("textarea").first().fill(MNEMONIC);
    await popup.locator("input[type='password']").first().fill("probe-pw");
    await popup.locator("button", { hasText: /^Continue$/ }).first().click();
    await wait(3500);
  }

  // Get master_pk + fingerprint, then derive indices 35..39 unhardened + hardened.
  const ctxData = await popup.evaluate(async () => {
    const local = await chrome.storage.local.get("wallets");
    const w = Object.values(local.wallets || {})[0];
    return { fp: w?.fingerprint, masterPk: w?.masterPublicKey };
  });
  log("fingerprint:", ctxData.fp);

  const unhardened = await popup.evaluate(async (pk) => {
    const r = await chrome.runtime.sendMessage({
      from: "popup",
      kind: "engine",
      method: "derive_addresses",
      params: { master_public_key: pk, start: 35, count: 5, testnet: false },
    });
    return r?.value?.addresses ?? [];
  }, ctxData.masterPk);

  const hardened = await popup.evaluate(async (fp) => {
    const r = await chrome.runtime.sendMessage({
      from: "popup",
      kind: "engine",
      method: "derive_addresses_hardened",
      params: { fingerprint: fp, start: 35, count: 5, testnet: false },
    });
    return r?.value?.addresses ?? [];
  }, ctxData.fp);

  const allHints = [
    ...unhardened.map((a) => ({ kind: "unhardened", idx: a.index, ph: a.puzzle_hash })),
    ...hardened.map((a) => ({ kind: "hardened", idx: a.index, ph: a.puzzle_hash })),
  ];

  log(`probing ${allHints.length} hints against api.coinset.org`);
  log("");

  // Query coinset for each PH sequentially so we don't trigger the same
  // overload the WASM saw.
  const results = [];
  for (const h of allHints) {
    const phHex = h.ph.startsWith("0x") ? h.ph.slice(2) : h.ph;
    const body = JSON.stringify({
      hint: phHex,
      include_spent_coins: false,
    });
    const t0 = Date.now();
    let status = 0;
    let bodyLen = 0;
    let recordCount = "?";
    try {
      const res = await fetch("https://api.coinset.org/get_coin_records_by_hint", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      status = res.status;
      const buf = await res.arrayBuffer();
      bodyLen = buf.byteLength;
      const text = new TextDecoder().decode(buf);
      try {
        const j = JSON.parse(text);
        recordCount = j.coin_records?.length ?? 0;
      } catch {
        recordCount = "(parse-fail)";
      }
    } catch (e) {
      log(`  ✗ ${h.kind} idx ${h.idx}: ${String(e).slice(0, 80)}`);
      continue;
    }
    const dt = Date.now() - t0;
    results.push({ ...h, status, bodyLen, recordCount, dt });
    const flag = bodyLen > 1_000_000 ? " ⚠ HEAVY" : "";
    log(
      `  ${h.kind.padEnd(10)} idx ${String(h.idx).padEnd(3)} ` +
        `0x${phHex.slice(0, 12)}…  ` +
        `${dt}ms  ${(bodyLen / 1024).toFixed(1)}KB  ${recordCount} recs${flag}`,
    );
  }

  log("");
  log("=== SUMMARY ===");
  results.sort((a, b) => b.bodyLen - a.bodyLen);
  for (const r of results.slice(0, 5)) {
    log(
      `  top  ${r.kind} idx ${r.idx}  ${r.recordCount} recs  ${(r.bodyLen / 1024).toFixed(1)}KB  ${r.dt}ms`,
    );
  }
  const totalKB = results.reduce((acc, r) => acc + r.bodyLen, 0) / 1024;
  log(`  total bytes if all 10 fetched in parallel: ${totalKB.toFixed(1)}KB`);
} catch (e) {
  console.error(e);
  process.exit(1);
} finally {
  await ctx.close();
}
