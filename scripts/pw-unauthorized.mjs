// Sanity check: an UNCONNECTED dApp can call exactly two things —
// `connect` and `requestAccounts` (both gated by the approval popup). Every
// other method MUST throw 4001 Unauthorized before we touch the engine.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";

const EXT_PATH =
  "/Users/marvin/Projects/Ozone/sage-web/ozone-web-extension/packages/extension/.output/chrome-mv3";
const USER_DATA = "/tmp/Loroco-PW-Unauth";
const MNEMONIC =
  process.env.MNEMONIC ??
  "charge day cloth frame purpose lake method segment fat gadget regret open better rent visual picnic crater degree budget satoshi shop maple depart host";

mkdirSync("/tmp/loroco-pw-unauth", { recursive: true });
const log = (...a) => console.log("[unauth]", ...a);

// Pick one method from every category — if these are blocked, the
// permission gate is comprehensive.
const PROBES = [
  { name: "chainId", params: undefined },
  { name: "accounts", params: undefined },
  { name: "getPublicKeys", params: undefined },
  { name: "getAssetBalance", params: { type: null, assetId: null } },
  { name: "getAssetCoins", params: { type: null, assetId: null } },
  { name: "filterUnlockedCoins", params: { coinNames: [] } },
  { name: "signMessage", params: { message: "0x00", publicKey: "0x" + "00".repeat(48) } },
  {
    name: "transfer",
    params: { to: "xch10qx8jkn8sh9prltm0nemvt53vk75dn47g78d39y448cnpaaftchqkcnygl", amount: "1", assetId: null },
  },
  { name: "takeOffer", params: { offer: "offer1xxx" } },
  { name: "walletSwitchChain", params: { chainId: "mainnet" } },
  {
    name: "walletWatchAsset",
    params: { type: "cat", options: { assetId: "0x" + "aa".repeat(32), symbol: "X" } },
  },
];

const ctx = await chromium.launchPersistentContext(USER_DATA, {
  headless: false,
  channel: "chromium",
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1200,900",
  ],
});

try {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
  const extId = sw.url().split("/")[2];
  log("ext id:", extId);

  // Import a wallet so the SW has something to gate (otherwise EVERY call
  // would fail with "no active wallet" instead of the permission error).
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
  log("wallet imported");
  await popup.close();

  // Visit a fresh origin we've NEVER connected. example.org is safe + has
  // no scripts that race us for window.chia.
  const page = await ctx.newPage();
  await page.goto("https://example.org", { waitUntil: "domcontentloaded" });
  await wait(1500);

  let failures = 0;
  for (const m of PROBES) {
    const out = await page.evaluate(
      async ({ name, params }) => {
        try {
          const r = await window.chia.request({ method: name, params });
          return { ok: true, result: r };
        } catch (e) {
          return { ok: false, code: e?.code, message: e?.message };
        }
      },
      m,
    );
    const denied = !out.ok && out.code === 4001;
    log(`${denied ? "BLOCKED " : "LEAKED  "} ${m.name.padEnd(20)} →`, JSON.stringify(out).slice(0, 140));
    if (!denied) failures += 1;
  }

  if (failures > 0) {
    log(`FAIL: ${failures} method(s) reachable WITHOUT a connection — security regression`);
    process.exit(1);
  }
  log(`✓ unconnected origin properly blocked on all ${PROBES.length} probes`);
} catch (err) {
  console.error("[unauth] ERROR:", err);
  process.exit(1);
} finally {
  await ctx.close();
}
