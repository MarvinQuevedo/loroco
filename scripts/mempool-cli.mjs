// Loroco mempool CLI — a terminal client to watch the live mempool and verify
// self-sends end to end.
//
// IMPORTANT FINDING that shaped this tool: coinset.org's public WebSocket
// (wss://api.coinset.org/ws) only emits `peak` events — it does NOT push
// per-transaction / mempool events (verified empirically; every subscribe
// shape we tried still yielded peak-only). So to actually SEE transactions in
// progress we POLL the full-node mempool RPC that coinset proxies:
//     POST /get_all_mempool_tx_ids        → current mempool tx id set
//     POST /get_mempool_item_by_tx_id     → that tx's additions/removals
// We diff the tx-id set each tick, fetch new items, and classify their
// additions/removals against the active wallet's puzzle hashes + tracked coins.
//
// The browser is launched only to (a) derive the wallet's puzzle hashes via the
// engine and (b) drive a harmless SELF-send through the popup UI; all mempool
// visibility is pure REST from Node.
//
// Usage:
//   node scripts/mempool-cli.mjs                      # live monitor
//   node scripts/mempool-cli.mjs send xch 0.0001      # self-send XCH, then watch
//   node scripts/mempool-cli.mjs send cat <assetId> 1 # self-send a CAT
//   node scripts/mempool-cli.mjs send nft <launcherId># self-send an NFT
//
// Env:
//   USER_DATA   profile dir (default /tmp/Loroco-PW-Shared)
//   PASSWORD    unlock password (default marvin)
//   MNEMONIC    used only if the profile has no wallet yet
//   DURATION_MS monitor length when no send is given (default 120000)
//   SHOW_ALL=1  print every mempool tx, not just ours
//   API         coinset base (default https://api.coinset.org)

import { chromium } from "playwright";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

const __here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__here, "..");
const EXT_PATH = resolve(ROOT, "packages/extension/.output/chrome-mv3");
const USER_DATA = process.env.USER_DATA ?? "/tmp/Loroco-PW-Shared";
const PASSWORD = process.env.PASSWORD ?? "marvin";
const MNEMONIC =
  process.env.MNEMONIC ??
  "charge day cloth frame purpose lake method segment fat gadget regret open better rent visual picnic crater degree budget satoshi shop maple depart host";
const DURATION_MS = Number(process.env.DURATION_MS ?? 120_000);
const SHOW_ALL = process.env.SHOW_ALL === "1";
const API = process.env.API ?? "https://api.coinset.org";

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
const now = () => new Date().toISOString().slice(11, 19);
const short = (h) => (h ? `${h.replace(/^0x/, "").slice(0, 8)}…${h.slice(-4)}` : "—");
const strip = (s) => (s?.startsWith("0x") ? s.slice(2) : s)?.toLowerCase();
const mojosToXch = (m) => {
  try {
    const v = BigInt(m);
    const s = 1_000_000_000_000n;
    const w = v / s;
    const f = (v % s).toString().padStart(12, "0").replace(/0+$/, "");
    return f ? `${w}.${f}` : `${w}`;
  } catch {
    return String(m);
  }
};
const log = (...a) => console.log(...a);

async function rpc(path, body) {
  const res = await fetch(`${API}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
}

// ── subcommand parse ─────────────────────────────────────────────────────────
const [cmd, kind, a1, a2] = process.argv.slice(2);
const SEND = cmd === "send" ? { kind, asset: kind === "cat" || kind === "nft" ? a1 : null, amount: kind === "cat" ? a2 : a1 } : null;

log(c.bold("Loroco mempool CLI"));
log(c.dim(`profile=${USER_DATA}  api=${API}`));

const ctx = await chromium.launchPersistentContext(USER_DATA, {
  headless: false,
  channel: "chromium",
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-position=-2400,0",
    "--window-size=420,720",
  ],
});

let stop = false;
process.on("SIGINT", () => {
  stop = true;
  log("\n" + c.dim("stopping…"));
});

try {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
  const extId = sw.url().split("/")[2];

  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 400, height: 700 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForLoadState("domcontentloaded");
  await wait(4000);

  // Import / unlock so the engine can derive + sign.
  const body = await popup.locator("body").innerText();
  if (/Import|Create|Get started/i.test(body) && !/balance|Receive/i.test(body)) {
    const ib = popup.locator("button", { hasText: /Import mnemonic/i }).first();
    if (await ib.isVisible().catch(() => false)) await ib.click();
    await wait(400);
    await popup.locator("textarea").first().fill(MNEMONIC);
    await popup.locator("input[type='password']").first().fill(PASSWORD);
    for (let i = 0; i < 5; i++) {
      await popup.locator("button", { hasText: /^Continue$/ }).first().click().catch(() => {});
      await wait(4000);
      if (!/Failed to fetch|error/i.test(await popup.locator("body").innerText())) break;
    }
  }
  const pw = popup.locator("input[type='password']").first();
  if (await pw.isVisible().catch(() => false)) {
    await pw.fill(PASSWORD);
    const u = popup.locator("button", { hasText: /Unlock|Continue|Enter/i }).first();
    if (await u.isVisible().catch(() => false)) await u.click();
    else await pw.press("Enter");
    await wait(2500);
  }

  // ── Derive our puzzle hashes + load tracked coins for classification ──────
  const ctxInfo = await sw.evaluate(async () => {
    const s = await chrome.storage.session.get("activeFingerprint");
    const fp = s.activeFingerprint;
    const w = (await chrome.storage.local.get("wallets")).wallets ?? {};
    const masterPk = w[fp]?.masterPublicKey ?? null;
    const store = fp != null ? (await chrome.storage.local.get(`coins.${fp}`))[`coins.${fp}`] : null;
    const hardened = Object.keys(store?.hardened_phs ?? {});
    // Outpoint key set for our coins: "parent|ph|amount" (XCH + CAT).
    const outpoints = [];
    for (const cn of Object.values(store?.coins ?? {})) {
      if (!cn.spent) outpoints.push(`${cn.parent_coin_info}|${cn.puzzle_hash}|${cn.amount}`);
    }
    for (const cat of Object.values(store?.cats ?? {})) {
      for (const cn of cat.coins ?? []) {
        if (!cn.spent) outpoints.push(`${cn.parent_coin_info}|${cn.puzzle_hash}|${cn.amount}`);
      }
    }
    for (const n of Object.values(store?.nfts ?? {})) {
      if (!n.spent) outpoints.push(`${n.parent_coin_info}|${n.puzzle_hash}|${n.amount}`);
    }
    return { fp, masterPk, hardened, outpoints };
  });

  const ourPhs = new Set();
  const ourPhList0x = [];
  const addPh = (ph) => {
    const s = strip(ph);
    if (!ourPhs.has(s)) {
      ourPhs.add(s);
      ourPhList0x.push(`0x${s}`);
    }
  };
  for (const ph of ctxInfo.hardened) addPh(ph);
  if (ctxInfo.masterPk) {
    const r = await popup.evaluate(
      (mpk) => chrome.runtime.sendMessage({ from: "popup", kind: "engine", method: "derive_addresses", params: { master_public_key: mpk, start: 0, count: 200, testnet: false } }),
      ctxInfo.masterPk,
    );
    for (const a of r?.value?.addresses ?? []) addPh(a.puzzle_hash);
  }
  const ourOutpoints = new Set(ctxInfo.outpoints.map((o) => o.split("|").map(strip).join("|")));
  log(c.green(`✓ wallet ready — ${ourPhs.size} owned PHs, ${ourOutpoints.size} unspent coins tracked`));

  // ── diag: compare on-chain XCH (coinset) vs Loroco's local store ─────────
  if (cmd === "diag") {
    log(c.bold("\nXCH balance diagnostic — on-chain vs Loroco store\n"));
    const readLocalXch = async () =>
      await sw.evaluate(async (fp) => {
        const store = (await chrome.storage.local.get(`coins.${fp}`))[`coins.${fp}`];
        let t = 0n;
        for (const cn of Object.values(store?.coins ?? {})) if (!cn.spent) t += BigInt(cn.amount);
        const tele = (await chrome.storage.session.get("coinSyncTelemetry")).coinSyncTelemetry;
        return { mojos: t.toString(), stage: tele?.stage, xchProg: tele?.stage_progress?.xch };
      }, ctxInfo.fp);
    // Force a full sync and wait for the XCH stage to actually run before judging.
    log(c.dim("forcing coin sync, waiting up to 180s for the XCH scan to land…"));
    await popup.evaluate(() => chrome.runtime.sendMessage({ from: "popup", kind: "force-coin-sync" })).catch(() => {});
    const t0 = Date.now();
    let local = await readLocalXch();
    while (Date.now() - t0 < 180_000) {
      local = await readLocalXch();
      if (BigInt(local.mojos) > 0n) break;
      process.stdout.write(c.dim(`. (${local.stage}/${local.xchProg?.done ?? 0}-${local.xchProg?.total ?? 0})`));
      await wait(6000);
    }
    log("");
    const localMojos = local.mojos;
    // 2. On-chain via coinset, querying all our PHs in batches.
    let chainMojos = 0n, chainCoins = 0, withCoins = [];
    for (let i = 0; i < ourPhList0x.length; i += 200) {
      const batch = ourPhList0x.slice(i, i + 200);
      try {
        const r = await rpc("get_coin_records_by_puzzle_hashes", { puzzle_hashes: batch, include_spent_coins: false });
        for (const rec of r?.coin_records ?? []) {
          if (rec.spent) continue;
          chainMojos += BigInt(rec.coin.amount);
          chainCoins += 1;
          if (withCoins.length < 8) withCoins.push(`${short(rec.coin.puzzle_hash)} = ${mojosToXch(rec.coin.amount)} XCH`);
        }
      } catch (e) {
        log(c.red(`  batch ${i} failed: ${e?.message || e}`));
      }
      await wait(400);
    }
    log(`  Loroco store XCH : ${c.cyan(mojosToXch(localMojos) + " XCH")}`);
    log(`  On-chain XCH     : ${c.cyan(mojosToXch(chainMojos) + " XCH")} across ${chainCoins} coin(s)`);
    if (withCoins.length) log(c.dim("    " + withCoins.join("\n    ")));
    if (BigInt(localMojos) === 0n && chainMojos > 0n) {
      log(c.red(`\n  ⚠ Loroco's store has 0 XCH but the chain has ${mojosToXch(chainMojos)} XCH at our PHs`));
      log(c.red("    → real sync gap: the XCH scan missed these coins (or hasn't run yet)."));
    } else if (chainMojos === 0n) {
      log(c.yellow("\n  This wallet has NO unspent XCH on-chain at its derived PHs — likely a different wallet than the one in Sage."));
    } else {
      log(c.green("\n  ✓ Loroco's XCH matches the chain."));
    }
    await ctx.close();
    process.exit(0);
  }

  log(c.dim("mempool source: coinset REST poll (the WS only emits `peak`)\n"));

  // ── classify one mempool item against the wallet ─────────────────────────
  function classify(item) {
    const adds = item.additions ?? [];
    const rems = item.removals ?? [];
    let incoming = 0n, addedToUs = false;
    for (const a of adds) {
      if (ourPhs.has(strip(a.puzzle_hash))) {
        addedToUs = true;
        incoming += BigInt(a.amount);
      }
    }
    let spentFromUs = false, spentMojos = 0n;
    for (const r of rems) {
      const key = [r.parent_coin_info, r.puzzle_hash, String(r.amount)].map(strip).join("|");
      if (ourOutpoints.has(key)) {
        spentFromUs = true;
        spentMojos += BigInt(r.amount);
      }
    }
    const mine = addedToUs && spentFromUs ? "both" : addedToUs ? "incoming" : spentFromUs ? "outgoing" : "none";
    return { mine, incoming, spentMojos, addCount: adds.length, remCount: rems.length };
  }

  // ── optional self-send (drives the popup UI) ─────────────────────────────
  let trackTxId = null;
  if (SEND) {
    // A freshly-imported profile needs the XCH/CAT scan to land before the
    // Send tab will let us spend. Force a sync and wait for the asset to show.
    await waitForSync(popup, sw, ctxInfo.fp, SEND.kind);
    trackTxId = await doSelfSend(popup, SEND);
    if (trackTxId) log(c.bold(c.cyan(`\n▶ tracking self-send tx ${short(trackTxId)} …\n`)));
  }

  // ── REST-poll monitor loop ───────────────────────────────────────────────
  const seenTx = new Set();
  let lastStatus = 0, mempoolSeen = false;
  const deadline = Date.now() + (SEND ? 360_000 : DURATION_MS);

  while (!stop && Date.now() < deadline) {
    let ids = [];
    try {
      const r = await rpc("get_all_mempool_tx_ids", {});
      ids = r?.tx_ids ?? [];
    } catch (e) {
      log(c.red("  mempool poll failed: " + (e?.message || e)));
      await wait(3000);
      continue;
    }

    // Track our own send: in-mempool → then gone (likely included).
    if (trackTxId) {
      const present = ids.includes(trackTxId) || ids.includes(`0x${strip(trackTxId)}`);
      if (present && !mempoolSeen) {
        mempoolSeen = true;
        log(c.yellow(`  ● ${short(trackTxId)} is now IN THE MEMPOOL`));
      } else if (!present && mempoolSeen) {
        // Left the mempool — confirm by checking an input coin's spent height.
        const confirmedAt = await confirmViaInputs(trackTxId);
        if (confirmedAt) {
          log(c.green(c.bold(`  ✓ ${short(trackTxId)} CONFIRMED in block #${confirmedAt.toLocaleString()}`)));
        } else {
          log(c.green(`  ✓ ${short(trackTxId)} left the mempool (included)`));
        }
        break;
      }
    }

    // New mempool items → fetch + classify (rate-limited: a few per tick).
    const fresh = ids.filter((id) => !seenTx.has(id)).slice(0, 6);
    for (const id of fresh) {
      seenTx.add(id);
      let item;
      try {
        item = (await rpc("get_mempool_item_by_tx_id", { tx_id: id }))?.mempool_item;
      } catch {
        continue;
      }
      if (!item) continue;
      const cl = classify(item);
      const isOurs = cl.mine !== "none";
      if (!isOurs && !SHOW_ALL) continue;
      const tag =
        cl.mine === "incoming" ? c.green("⬇ INCOMING")
        : cl.mine === "outgoing" ? c.red("⬆ OUTGOING")
        : cl.mine === "both" ? c.yellow("⬆⬇ SELF")
        : c.dim("·  other  ");
      const amt =
        cl.mine === "incoming" ? c.green(`+${mojosToXch(cl.incoming)} XCH`)
        : cl.mine === "outgoing" || cl.mine === "both" ? c.red(`~${mojosToXch(cl.spentMojos)} XCH`)
        : c.dim(`${cl.addCount}+/${cl.remCount}-`);
      const oursMark = isOurs ? c.bold(c.cyan("  ← OURS")) : "";
      const feeNote = item.fee ? c.dim(` fee ${mojosToXch(item.fee)}`) : "";
      log(`${c.dim(now())}  ${tag}  ${amt.padEnd(26)} ${c.dim("tx " + short(id))}${feeNote}${oursMark}`);
    }

    if (Date.now() - lastStatus > 12_000) {
      log(c.dim(`── ${now()}  mempool: ${ids.length} tx in flight  ·  tracked-seen=${seenTx.size}`));
      lastStatus = Date.now();
    }
    await wait(3000);
  }

  if (trackTxId && !mempoolSeen) {
    log(c.yellow(`\n(${short(trackTxId)} never appeared in the mempool poll — it may have confirmed between polls or failed to broadcast)`));
  }
  log(c.dim("\ndone."));

  // Confirm a tracked tx by checking whether one of its input coins is now spent.
  async function confirmViaInputs(txId) {
    try {
      const item = (await rpc("get_mempool_item_by_tx_id", { tx_id: txId }))?.mempool_item;
      const rem = (item?.removals ?? [])[0];
      if (!rem) return null;
      // Need the coin NAME (id); recompute is non-trivial, so look it up by ph.
      const recs = (await rpc("get_coin_records_by_puzzle_hash", { puzzle_hash: rem.puzzle_hash, include_spent_coins: true }))?.coin_records ?? [];
      const hit = recs.find((r) => strip(r.coin.parent_coin_info) === strip(rem.parent_coin_info) && String(r.coin.amount) === String(rem.amount));
      return hit?.spent && hit.spent_block_index > 0 ? hit.spent_block_index : null;
    } catch {
      return null;
    }
  }
} catch (err) {
  console.error(c.red("[mempool-cli] ERROR:"), err);
  process.exitCode = 1;
} finally {
  await wait(500);
  await ctx.close();
}

// ── wait for a fresh import to sync the asset we're about to send ────────────
async function waitForSync(popup, sw, fp, kind, timeoutMs = 180_000) {
  const need = kind === "xch" ? "XCH" : kind === "cat" ? "a CAT" : "an NFT";
  process.stdout.write(`\x1b[2mforcing sync, waiting for ${need} to populate`);
  await popup.evaluate(() => chrome.runtime.sendMessage({ from: "popup", kind: "force-coin-sync" })).catch(() => {});
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const have = await sw.evaluate(async ({ fp, kind }) => {
      const store = (await chrome.storage.local.get(`coins.${fp}`))[`coins.${fp}`];
      if (kind === "xch") {
        let t = 0n;
        for (const c of Object.values(store?.coins ?? {})) if (!c.spent) t += BigInt(c.amount);
        return t > 0n;
      }
      if (kind === "cat") return Object.keys(store?.cats ?? {}).length > 0;
      return Object.values(store?.nfts ?? {}).some((n) => !n.spent);
    }, { fp, kind });
    if (have) {
      process.stdout.write(" ✓\x1b[0m\n");
      return true;
    }
    process.stdout.write("\x1b[2m.\x1b[0m");
    await new Promise((r) => setTimeout(r, 6000));
  }
  process.stdout.write("\x1b[33m (timed out)\x1b[0m\n");
  return false;
}

// ── self-send via the popup UI ───────────────────────────────────────────────
async function doSelfSend(popup, send) {
  await popup.locator('nav.tabs-bottom button[aria-label="Receive"]').first().click().catch(() => {});
  await wait(1200);
  const addr = (await popup.locator("body").innerText()).match(/\b(x|t)ch1[a-z0-9]{20,}\b/i)?.[0];
  if (!addr) {
    log(c.red("could not read our receive address — aborting send"));
    return null;
  }
  log(c.dim(`self address: ${addr}`));

  if (send.kind === "xch" || send.kind === "cat") {
    await popup.locator('nav.tabs-bottom button[aria-label="Send"]').first().click();
    await wait(1000);
    if (send.kind === "cat") {
      const ok = await popup.locator(".field select").first().selectOption(send.asset).then(() => true).catch(() => false);
      if (!ok) {
        const opts = await popup.locator(".field select option").allTextContents();
        const idx = opts.findIndex((o) => !/XCH/i.test(o));
        if (idx >= 0) await popup.locator(".field select").first().selectOption({ index: idx });
        else { log(c.red("no CAT in this wallet to send")); return null; }
      }
      await wait(600);
    }
    await popup.locator('input[placeholder="xch1..."]').first().fill(addr);
    await popup.locator('input[type="number"]').first().fill(send.amount || "0.0001");
    await wait(800);
    const btn = popup.locator("button", { hasText: /^Send / }).first();
    if (!(await btn.isEnabled().catch(() => false))) {
      log(c.red("Send button disabled — insufficient balance or invalid input."));
      return null;
    }
    await btn.click();
    const txEl = popup.locator('button[title^="Copy 0x"]').last();
    const ok = await txEl.waitFor({ timeout: 90_000 }).then(() => true).catch(() => false);
    if (!ok) {
      const err = await popup.locator(".error").first().innerText().catch(() => "");
      log(c.red(`send failed: ${err || "no success screen"}`));
      return null;
    }
    const title = await txEl.getAttribute("title");
    log(c.green(`✓ broadcast ${send.kind.toUpperCase()} self-send`));
    return title?.replace(/^Copy\s+/, "").trim() ?? null;
  }

  if (send.kind === "nft") {
    await popup.locator('nav.tabs-bottom button[aria-label="NFTs"]').first().click();
    await wait(1800);
    const card = popup.locator(".nft-card").first();
    if (!(await card.isVisible().catch(() => false))) {
      log(c.red("no NFT card found to send."));
      return null;
    }
    await card.click();
    await wait(1200);
    // The detail screen hides the recipient field behind a "Transfer NFT" button.
    const openBtn = popup.locator("button", { hasText: /^Transfer NFT$/ }).first();
    if (!(await openBtn.isVisible().catch(() => false))) {
      log(c.red("could not open the NFT transfer form."));
      return null;
    }
    await openBtn.click();
    await wait(800);
    await popup.locator('input[placeholder="xch1..."]').first().fill(addr);
    // Wait for bech32m validation to enable the confirm button.
    await popup.locator("text=valid xch address").first().waitFor({ timeout: 8000 }).catch(() => {});
    const confirm = popup.locator("button", { hasText: /Confirm transfer|Transferring/i }).first();
    if (!(await confirm.isEnabled().catch(() => false))) {
      log(c.red("NFT confirm button stayed disabled (address not validated)."));
      return null;
    }
    await confirm.click();
    // Success shows the tx id as a <code> under the "tx id" label.
    const txCode = popup.locator(".result code").filter({ hasText: /^0x[0-9a-f]{8,}/i }).first();
    const ok = await txCode.waitFor({ timeout: 120_000 }).then(() => true).catch(() => false);
    if (!ok) {
      const err = await popup.locator(".error").first().innerText().catch(() => "");
      log(c.red(`NFT transfer failed: ${err || "no confirmation surfaced"}`));
      return null;
    }
    const txId = (await txCode.innerText().catch(() => ""))?.trim() || null;
    log(c.green("✓ broadcast NFT self-send"));
    return txId;
  }

  log(c.red(`unknown send kind: ${send.kind}`));
  return null;
}
