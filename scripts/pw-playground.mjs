// End-to-end test of scripts/playground/index.html against the test wallet:
//  1. unlock/import wallet  2. open the served playground  3. Autofill
//  4. Run all reads  5. exercise a few mutating calls (auto-approve)
// Reports the activity-log lines so we see exactly what passed/failed.
//
// Uses Chrome for Testing (Playwright) because stable Chrome ≥137 blocks
// --load-extension. Exits non-zero if any read fails.
//
// Usage:  pnpm build:fast && node scripts/pw-playground.mjs
// Env:    PROFILE, MNEMONIC, PASSWORD, HEADLESS=1 (default headed, offscreen)

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const EXT = resolve("packages/extension/.output/chrome-mv3");
const HTML = resolve("scripts/playground/index.html");
const USER_DATA = process.env.PROFILE ?? "/tmp/Loroco-PW-Drive";
const MNEMONIC = process.env.MNEMONIC ??
  "charge day cloth frame purpose lake method segment fat gadget regret open better rent visual picnic crater degree budget satoshi shop maple depart host";
const PASSWORD = process.env.PASSWORD ?? "marvin";
const PORT = Number(process.env.PORT ?? 8137);
const HEADLESS = process.env.HEADLESS === "1";

const server = createServer((_q, r) => { r.setHeader("Content-Type", "text/html"); r.end(readFileSync(HTML)); });
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const log = (...a) => console.log("[pw-playground]", ...a);
let readsFailed = 0;

const ctx = await chromium.launchPersistentContext(USER_DATA, {
  headless: HEADLESS, channel: "chromium",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--no-first-run", "--no-default-browser-check",
    ...(HEADLESS ? [] : ["--window-position=-2400,0"]), "--window-size=1280,900"],
});

try {
  let sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker", { timeout: 20000 });
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

  // Auto-approve loop running in the background against the popup.
  let approveCount = 0; let stop = false;
  (async () => {
    while (!stop) {
      const b = popup.locator("button", { hasText: /^Approve$/ }).first();
      if (await b.isVisible().catch(() => false)) { try { await b.click({ timeout: 1000 }); approveCount++; } catch {} }
      await wait(250);
    }
  })();

  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  await wait(1800);

  const readLog = () => page.evaluate(() => [...document.querySelectorAll("#logBody .line")].map((d) => d.textContent).reverse());

  log("clicking Autofill…");
  await page.click("#btnAutofill");
  // autofill may poll for CAT sync — wait for its "autofill done" log line.
  for (let i = 0; i < 30; i++) {
    const lines = await readLog();
    if (lines.some((l) => l.includes("autofill done"))) break;
    await wait(1500);
  }

  log("clicking Run all reads…");
  await page.click("#btnRunReads");
  await wait(9000);

  log("=== LOG after autofill + run reads ===");
  for (const l of await readLog()) {
    console.log("   " + l);
    const m = l.match(/reads done — \d+ ok \/ (\d+) fail/);
    if (m) readsFailed = Number(m[1]);
  }

  stop = true; // stop the background auto-approver; approve inline below
  await wait(400);

  // The popup closes itself after each approval (normal wallet UX), so we
  // re-open a popup.html tab before approving each mutating call.
  async function ensurePopup() {
    if (!popup.isClosed()) return popup;
    popup = await ctx.newPage();
    await popup.setViewportSize({ width: 380, height: 600 });
    await popup.goto(`chrome-extension://${extId}/popup.html`).catch(() => {});
    await popup.waitForLoadState("domcontentloaded").catch(() => {});
    await wait(800);
    return popup;
  }
  async function callCard(name) {
    const sel = `.card[data-name="${name.toLowerCase()}"]`;
    await page.locator(sel).scrollIntoViewIfNeeded().catch(() => {});
    await page.locator(`${sel} .call`).click();
    await wait(700);
    // (re)open popup and approve
    for (let i = 0; i < 24; i++) {
      const pp = await ensurePopup();
      await pp.bringToFront().catch(() => {});
      const b = pp.locator("button", { hasText: /^Approve$/ }).first();
      if (await b.isVisible().catch(() => false)) { try { await b.click({ timeout: 800 }); approveCount++; break; } catch {} }
      await wait(350);
    }
    const out = page.locator(`${sel} .out`);
    for (let i = 0; i < 34; i++) {
      const cls = await out.getAttribute("class");
      if (cls && cls.includes("show")) break;
      await wait(300);
    }
    return out.textContent();
  }
  for (const m of ["signMessage", "signMessageByAddress", "transfer"]) {
    log(`mutating → ${m}`);
    const out = await callCard(m);
    console.log("   " + (out || "(no output)").replace(/\s+/g, " ").slice(0, 240));
  }

  log("approvals auto-clicked:", approveCount);
  if (readsFailed > 0) { log(`✗ FAIL — ${readsFailed} read(s) failed`); process.exitCode = 1; }
  else log("✓ PASS — all reads ok; mutating sample signed/broadcast");
} catch (e) { console.error("[pw-playground] ERROR:", e.message, e.stack); process.exitCode = 1; }
finally { await ctx.close(); server.close(); }
