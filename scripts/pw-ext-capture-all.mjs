// Capture EVERY popup surface for a design audit: tabs, settings modals,
// NFT detail, status. Output to /tmp/loroco-ext-all/<NN>-<name>.png at the
// real 380x600. Uses the synced test profile.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = resolve(ROOT, "packages/extension/.output/chrome-mv3");
const USER_DATA = process.env.USER_DATA ?? "/tmp/Loroco-PW-Shared";
const PASSWORD = process.env.PASSWORD ?? "marvin";
const OUT = "/tmp/loroco-ext-all";
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log("[capture]", ...a);

const ctx = await chromium.launchPersistentContext(USER_DATA, {
  headless: false,
  channel: "chromium",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run", "--window-size=900,820"],
});

try {
  let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
  const id = sw.url().split("/")[2];
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 380, height: 600 });
  await p.goto(`chrome-extension://${id}/popup.html`);
  await wait(4000);
  const pwf = p.locator("input[type='password']").first();
  if (await pwf.isVisible().catch(() => false)) {
    await pwf.fill(PASSWORD);
    await pwf.press("Enter");
    await wait(3000);
  }
  await wait(2500);

  let n = 1;
  const snap = async (name) => {
    await wait(700);
    await p.screenshot({ path: `${OUT}/${String(n++).padStart(2, "0")}-${name}.png` });
    log(name);
  };
  const tab = async (label) => {
    await p.locator(`nav.tabs-bottom button[aria-label="${label}"]`).first().click().catch(() => {});
    await wait(1100);
  };
  const closeModal = async () => {
    await p.locator(".modal-close, button[aria-label='Close']").first().click().catch(() => {});
    await wait(500);
    await p.keyboard.press("Escape").catch(() => {});
    await wait(400);
  };

  // Tabs
  await tab("Home"); await snap("home");
  await tab("Send"); await snap("send");
  await tab("Receive"); await snap("receive");
  await tab("NFTs"); await snap("nfts");
  // NFT detail
  const card = p.locator(".nft-card").first();
  if (await card.isVisible().catch(() => false)) {
    await card.click();
    await snap("nft-detail");
    await p.locator("button.ghost", { hasText: /back|←/i }).first().click().catch(() => {});
    await wait(600);
  }
  await tab("Activity"); await snap("activity");

  // Settings + each modal
  const gear = p.locator("button[title*='Settings'], button[aria-label*='Settings']").first();
  await gear.click(); await wait(900); await snap("settings");
  for (const [title, name] of [
    ["Notifications", "modal-notifications"],
    ["Connected sites", "modal-connections"],
    ["Local peer sync", "modal-sidecar"],
    ["Site compatibility", "modal-compat"],
    ["Recovery phrase", "modal-recovery"],
  ]) {
    const row = p.getByText(title, { exact: true }).first();
    if (await row.isVisible().catch(() => false)) {
      await row.click();
      await snap(name);
      await closeModal();
    }
  }

  // Status
  const status = p.locator("button[title*='Status'], button[aria-label*='Status']").first();
  await status.click(); await wait(900); await snap("status");

  log(`done — ${n - 1} screenshots in ${OUT}`);
} catch (err) {
  console.error("[capture] ERROR:", err);
  process.exitCode = 1;
} finally {
  await wait(500);
  await ctx.close();
}
