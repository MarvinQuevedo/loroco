// Print computed heights of every box in the popup chain so we can see
// where the flex chain breaks.

import { chromium } from "playwright";
import { setTimeout as wait } from "node:timers/promises";

const EXT_PATH =
  "/Users/marvin/Projects/Ozone/sage-web/ozone-web-extension/packages/extension/.output/chrome-mv3";
const USER_DATA = "/tmp/Loroco-PW-Debug";
const MNEMONIC =
  "charge day cloth frame purpose lake method segment fat gadget regret open better rent visual picnic crater degree budget satoshi shop maple depart host";

const ctx = await chromium.launchPersistentContext(USER_DATA, {
  headless: false,
  channel: "chromium",
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--no-first-run", "--window-size=900,800"],
});

try {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
  const extId = sw.url().split("/")[2];

  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForLoadState("domcontentloaded");
  await wait(1000);

  if (/Import|Create/i.test(await popup.locator("body").innerText())) {
    await popup.locator("button", { hasText: /Import mnemonic/i }).first().click();
    await wait(400);
    await popup.locator("textarea").first().fill(MNEMONIC);
    await popup.locator("input[type='password']").first().fill("marvin");
    await popup.locator("button", { hasText: /^Continue$/ }).first().click();
    await wait(3500);
  }

  const info = await popup.evaluate(() => {
    const sel = (s) => document.querySelector(s);
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        tag: el.tagName + (el.className ? "." + el.className.split(" ").slice(0, 2).join(".") : ""),
        y: Math.round(r.top), h: Math.round(r.height),
        display: cs.display, flex: cs.flex, minH: cs.minHeight, height: cs.height, overflow: cs.overflow,
      };
    };
    return {
      window: { w: window.innerWidth, h: window.innerHeight },
      body: box(document.body),
      popup: box(sel(".ozone-popup")),
      header: box(sel(".ozone-header")),
      main: box(sel("main")),
      screen: box(sel(".screen")),
      walletBar: box(sel(".wallet-bar")),
      tabContent: box(sel(".tab-content-wrap")),
      tabsBottom: box(sel(".tabs-bottom")),
    };
  });

  console.log(JSON.stringify(info, null, 2));
} finally {
  await ctx.close();
}
