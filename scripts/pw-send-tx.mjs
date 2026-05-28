// Send-transaction smoke. Imports the public dev mnemonic, waits for the XCH
// scan to populate, then opens the Send tab and submits 1 mojo back to our
// OWN first address (self-transfer is harmless and verifies the entire
// derive → pick-coins → build-spend → mempool round-trip).
//
// Run:
//   node scripts/pw-send-tx.mjs            # send 1 mojo, real broadcast
//   NO_BROADCAST=1 node scripts/pw-send-tx.mjs   # fill form, don't submit

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";

const EXT_PATH =
  "/Users/marvin/Projects/Ozone/loroco/packages/extension/.output/chrome-mv3";
const USER_DATA = "/tmp/Ozone-PW-Send";
const SHOT_DIR = "/tmp/ozone-pw-send";
// Default to the public dev mnemonic. Override via:
//   MNEMONIC="word1 word2 ..." node scripts/pw-send-tx.mjs
// Useful when you need a wallet that actually holds CATs / NFTs.
const MNEMONIC =
  process.env.MNEMONIC ??
  "charge day cloth frame purpose lake method segment fat gadget regret open better rent visual picnic crater degree budget satoshi shop maple depart host";

mkdirSync(SHOT_DIR, { recursive: true });

const log = (...args) => console.log("[send]", ...args);
const fail = (msg) => {
  console.error("[send] FAIL:", msg);
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
    "--window-position=0,0",
    "--window-size=520,800",
  ],
});

try {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
  const extId = sw.url().split("/")[2];
  log("extension id:", extId);

  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  popup.on("console", (m) => {
    if (m.type() === "error") log("popup error:", m.text());
  });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForLoadState("domcontentloaded");
  await wait(1200);

  const bodyText = await popup.locator("body").innerText();
  if (/Import|Create/i.test(bodyText) && !/Unlock/i.test(bodyText)) {
    log("onboarding flow — importing dev mnemonic");
    const importBtn = popup.locator("button", { hasText: /Import mnemonic/i }).first();
    if (await importBtn.isVisible().catch(() => false)) {
      await importBtn.click();
      await wait(400);
    }
    await popup.locator("textarea").first().fill(MNEMONIC);
    await popup.locator("input[type='password']").first().fill("marvin");
    await popup.locator("button", { hasText: /^Continue$/ }).first().click();
    await wait(4000);
  } else if (/Unlock/i.test(bodyText)) {
    log("unlocking");
    await popup.locator("input[type='password']").first().fill("marvin");
    await popup.locator("button", { hasText: /^Unlock$/ }).first().click();
    await wait(2500);
  }

  await popup.screenshot({ path: `${SHOT_DIR}/01-home.png` });

  // Wait for XCH scan to find at least one unspent coin. The dev wallet has
  // ~2 coins / ~2.4k mojos so this should be fast.
  log("waiting for XCH balance to be detected…");
  let havingBalance = false;
  for (let i = 0; i < 30; i += 1) {
    const balText = await popup.locator(".balance").innerText().catch(() => "");
    if (/[1-9]/.test(balText)) {
      havingBalance = true;
      log("balance line:", balText);
      break;
    }
    await wait(2000);
  }
  if (!havingBalance) fail("XCH balance never appeared — scan_puzzle_hashes broken?");

  // Grab our own first receive address — we send to ourselves.
  log("clicking Receive to grab address #0");
  // Tab buttons contain an icon + label span — match on the label.
  await popup.locator(".tab .tab-label", { hasText: /^Receive$/i }).first().click();
  await wait(800);
  const ownAddr = await popup
    .locator(".receive-address")
    .first()
    .innerText()
    .catch(() => "");
  log("own xch addr:", ownAddr);
  if (!/^xch1/.test(ownAddr)) fail("could not read own address from Receive tab");

  // Switch to Send tab.
  log("opening Send tab");
  await popup.locator(".tab .tab-label", { hasText: /^Send$/i }).first().click();
  await wait(600);
  await popup.screenshot({ path: `${SHOT_DIR}/02-send-empty.png` });

  // Fill recipient + amount. 0.000000000001 XCH = 1 mojo.
  log("filling send form");
  await popup.locator("input[type='text']").first().fill(ownAddr);
  await wait(500); // address validation debounce
  await popup.locator("input[type='number']").first().fill("0.000000000001");
  await wait(300);
  await popup.screenshot({ path: `${SHOT_DIR}/03-send-filled.png` });

  // Confirm validation passed.
  const validOk = await popup.locator(".small.ok").filter({ hasText: /xch/i }).count();
  log("address-valid markers:", validOk);
  if (validOk < 1) fail("recipient address validation did not pass");

  const submit = popup.locator("button", { hasText: /^Send XCH$/ }).first();
  const enabled = await submit.isEnabled();
  log("Send XCH button enabled:", enabled);
  if (!enabled) fail("Send button not enabled with valid inputs");

  if (process.env.NO_BROADCAST === "1") {
    log("NO_BROADCAST set — skipping XCH submit");
    await popup.screenshot({ path: `${SHOT_DIR}/04-no-broadcast.png` });
  } else {
    log("submitting XCH tx (1 mojo self-transfer)");
    await submit.click();
    let confirmed = false;
    for (let i = 0; i < 25; i += 1) {
      await wait(1000);
      const errCount = await popup.locator(".error").count();
      const okCount = await popup
        .locator(".result code")
        .filter({ hasText: /^0x[0-9a-f]+/i })
        .count();
      if (okCount > 0 || errCount > 0) {
        confirmed = true;
        break;
      }
    }
    await popup.screenshot({ path: `${SHOT_DIR}/05-send-result.png` });
    if (!confirmed) fail("no XCH result after 25s — engine call hung?");
    const errText = await popup.locator(".error").allInnerTexts().catch(() => []);
    if (errText.length > 0) log("XCH submit errors:", errText.join(" | "));
    const txIds = await popup
      .locator(".result code")
      .filter({ hasText: /^0x[0-9a-f]+/i })
      .allInnerTexts();
    log("XCH tx ids:", txIds);
  }

  // ── CAT send flow ───────────────────────────────────────────────────────
  log("--- CAT send check ---");
  // Re-open Send tab in case we navigated away.
  await popup.locator(".tab .tab-label", { hasText: /^Send$/i }).first().click();
  await wait(400);

  // The asset <select> has XCH plus one <option> per CAT with balance. If
  // there's no CAT, count === 1 and we skip.
  const assetSelect = popup.locator("select").first();
  await assetSelect.waitFor({ timeout: 5_000 });
  const opts = await assetSelect.locator("option").allInnerTexts();
  log("asset options:", opts);
  if (opts.length < 2) {
    log("no CATs detected in wallet — skipping CAT send check (expected for dev mnemonic)");
  } else {
    const catOpt = await assetSelect.locator("option").nth(1).getAttribute("value");
    log("picking CAT asset_id:", catOpt);
    await assetSelect.selectOption(catOpt);
    await wait(400);
    // Reuse our own xch1 address (CAT goes back to us inside the CAT puzzle).
    await popup.locator("input[type='text']").first().fill(ownAddr);
    await wait(400);
    // CATs use 3 decimals by default — 0.001 = 1 mojo.
    await popup.locator("input[type='number']").first().fill("0.001");
    await wait(300);
    await popup.screenshot({ path: `${SHOT_DIR}/06-cat-filled.png` });

    if (process.env.NO_BROADCAST === "1") {
      log("NO_BROADCAST set — not submitting CAT send");
    } else {
      const catBtn = popup.locator("button", { hasText: /^Send (CAT|.+)$/ }).first();
      const catEnabled = await catBtn.isEnabled().catch(() => false);
      log("Send CAT button enabled:", catEnabled);
      if (catEnabled) {
        await catBtn.click();
        let catDone = false;
        for (let i = 0; i < 25; i += 1) {
          await wait(1000);
          const ok = await popup
            .locator(".result code")
            .filter({ hasText: /^0x[0-9a-f]+/i })
            .count();
          const err = await popup.locator(".error").count();
          if (ok > 0 || err > 0) {
            catDone = true;
            break;
          }
        }
        await popup.screenshot({ path: `${SHOT_DIR}/07-cat-result.png` });
        const catErr = await popup.locator(".error").allInnerTexts();
        const catTxs = await popup
          .locator(".result code")
          .filter({ hasText: /^0x[0-9a-f]+/i })
          .allInnerTexts();
        log("cat done:", catDone, "errs:", catErr.join(" | "), "tx ids:", catTxs);
      }
    }
  }

  // ── NFT transfer flow ───────────────────────────────────────────────────
  log("--- NFT transfer check ---");
  await popup.locator(".tab .tab-label", { hasText: /^NFTs$/i }).first().click();
  await wait(600);
  const nftCards = await popup.locator(".nft-card").count();
  log("NFT cards in tab:", nftCards);
  if (nftCards === 0) {
    log("no NFTs in wallet — skipping NFT transfer check (expected for dev mnemonic)");
  } else {
    await popup.locator(".nft-card").first().click();
    await wait(400);
    await popup.screenshot({ path: `${SHOT_DIR}/08-nft-detail.png` });
    const transferBtn = popup.locator("button", { hasText: /Transfer NFT/i }).first();
    if (await transferBtn.isVisible().catch(() => false)) {
      await transferBtn.click();
      await wait(400);
      // Form appears — fill recipient with own addr.
      await popup.locator("input[type='text']").first().fill(ownAddr);
      await wait(500);
      await popup.screenshot({ path: `${SHOT_DIR}/09-nft-filled.png` });
      if (process.env.NO_BROADCAST === "1") {
        log("NO_BROADCAST set — not submitting NFT transfer");
      } else {
        const confirmBtn = popup.locator("button", { hasText: /Confirm transfer/i }).first();
        const nftEnabled = await confirmBtn.isEnabled().catch(() => false);
        log("Confirm NFT transfer enabled:", nftEnabled);
        if (nftEnabled) {
          await confirmBtn.click();
          let nftDone = false;
          for (let i = 0; i < 25; i += 1) {
            await wait(1000);
            const ok = await popup.locator(".result code").count();
            const err = await popup.locator(".error").count();
            if (ok > 0 || err > 0) {
              nftDone = true;
              break;
            }
          }
          await popup.screenshot({ path: `${SHOT_DIR}/10-nft-result.png` });
          log("nft transfer done:", nftDone);
        }
      }
    } else {
      log("Transfer button not visible on NFT detail — UI bug?");
    }
  }

  log("DONE — screenshots in:", SHOT_DIR);
} catch (err) {
  console.error("[send] ERROR:", err);
  try {
    for (const [i, p] of ctx.pages().entries()) {
      await p.screenshot({ path: `${SHOT_DIR}/err-${i}.png` }).catch(() => {});
    }
  } catch {}
  process.exit(1);
} finally {
  await ctx.close();
}
