import { chromium } from "playwright";
import { setTimeout as wait } from "node:timers/promises";
const EXT_PATH = "/Users/marvin/Projects/Ozone/sage-web/ozone-web-extension/packages/extension/.output/chrome-mv3";
const MNEMONIC = "charge day cloth frame purpose lake method segment fat gadget regret open better rent visual picnic crater degree budget satoshi shop maple depart host";
const ctx = await chromium.launchPersistentContext("/tmp/Loroco-PW-Pre", {
  headless: false, channel: "chromium",
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--no-first-run", "--window-size=900,800"],
});
await wait(2000);
let sw = ctx.serviceWorkers()[0]; if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 30_000 });
const extId = sw.url().split("/")[2];
const p = await ctx.newPage();
await p.setViewportSize({ width: 380, height: 600 });
await p.goto(`chrome-extension://${extId}/popup.html`);
await wait(1500);
if (/Import/i.test(await p.locator("body").innerText())) {
  await p.locator("button", { hasText: /Import mnemonic/i }).first().click(); await wait(400);
  await p.locator("textarea").first().fill(MNEMONIC);
  await p.locator("input[type='password']").first().fill("marvin");
  await p.locator("button", { hasText: /^Continue$/ }).first().click(); await wait(4000);
}
await p.evaluate(() => {
  const el = document.querySelector(".balance");
  if (el) el.innerHTML = '0.000070070544 XCH<span class="balance-usd"> ≈ $0.000190</span>';
});
await wait(500);
await p.screenshot({ path: "/tmp/loroco-pw-layout/home-simulated.png" });
console.log("shot saved");
await ctx.close();
