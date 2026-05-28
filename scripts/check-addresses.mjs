// Derive the first N addresses for the wallet and print them so we can
// compare against what Sage displays (xch1xxq4...wq6c7x2m). If our index 0
// matches one of these, we're using the right derivation path.

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
const USER_DATA = "/tmp/Loroco-Check";
const MNEMONIC = process.env.MNEMONIC;
const TARGET = "xch1xxq"; // Sage's active address starts with this

mkdirSync(USER_DATA, { recursive: true });

const ctx = await chromium.launchPersistentContext(USER_DATA, {
  headless: true,
  channel: "chromium",
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--headless=new",
  ],
});

try {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
  const extId = sw.url().split("/")[2];

  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForLoadState("domcontentloaded");
  await wait(500);
  if (/Import|Create/i.test(await popup.locator("body").innerText())) {
    const importBtn = popup.locator("button", { hasText: /Import mnemonic/i }).first();
    if (await importBtn.isVisible().catch(() => false)) await importBtn.click();
    await wait(400);
    await popup.locator("textarea").first().fill(MNEMONIC);
    await popup.locator("input[type='password']").first().fill("check-pw");
    await popup.locator("button", { hasText: /^Continue$/ }).first().click();
    await wait(2500);
  }

  // Try unhardened + synthetic (current path)
  console.log("=== UNHARDENED + SYNTHETIC (our current path) ===");
  const unhardened = await popup.evaluate(async () => {
    const res = await chrome.runtime.sendMessage({
      from: "popup",
      kind: "engine",
      method: "derive_addresses",
      params: { fingerprint: undefined, master_public_key: undefined, start: 0, count: 200, testnet: false },
    });
    // Need to get master_pk first since we don't have fingerprint context
    return res;
  }).catch((e) => ({ err: String(e) }));
  console.log(JSON.stringify(unhardened, null, 2).slice(0, 500));

  // Try with masterPublicKey from storage
  const masterPk = await popup.evaluate(async () => {
    const local = await chrome.storage.local.get("wallets");
    const wallets = local.wallets || {};
    return Object.values(wallets)[0]?.masterPublicKey;
  });
  console.log("\nmaster_pk:", masterPk?.slice(0, 30) + "...");

  if (masterPk) {
    const derivedUnhardened = await popup.evaluate(async (pk) => {
      const res = await chrome.runtime.sendMessage({
        from: "popup",
        kind: "engine",
        method: "derive_addresses",
        params: { master_public_key: pk, start: 0, count: 200, testnet: false },
      });
      return res?.value?.addresses ?? res;
    }, masterPk);

    console.log("\nFirst 10 UNHARDENED addresses:");
    for (const a of derivedUnhardened.slice(0, 10)) {
      const marker = a.address.startsWith(TARGET) ? "  ← MATCH Sage" : "";
      console.log(`  [${a.index}] ${a.address}${marker}`);
    }
    const matchU = derivedUnhardened.find((a) => a.address.startsWith(TARGET));
    console.log(`Sage's "${TARGET}..." in unhardened 0..499: ${matchU ? `idx ${matchU.index}` : "NO"}`);

    // Get fingerprint then derive HARDENED
    const wallets = await popup.evaluate(async () => {
      const local = await chrome.storage.local.get("wallets");
      return Object.values(local.wallets || {});
    });
    const fp = wallets[0]?.fingerprint;

    if (fp) {
      const derivedHardened = await popup.evaluate(async (fingerprint) => {
        const res = await chrome.runtime.sendMessage({
          from: "popup",
          kind: "engine",
          method: "derive_addresses_hardened",
          params: { fingerprint, start: 0, count: 200, testnet: false },
        });
        return res?.value?.addresses ?? res;
      }, fp);

      console.log("\nFirst 10 HARDENED addresses:");
      if (Array.isArray(derivedHardened)) {
        for (const a of derivedHardened.slice(0, 10)) {
          const marker = a.address.startsWith(TARGET) ? "  ← MATCH Sage" : "";
          console.log(`  [${a.index}] ${a.address}${marker}`);
        }
        const matchH = derivedHardened.find((a) => a.address.startsWith(TARGET));
        console.log(`Sage's "${TARGET}..." in hardened 0..499: ${matchH ? `idx ${matchH.index}` : "NO"}`);
      } else {
        console.log("hardened derive error:", JSON.stringify(derivedHardened));
      }
    }
  }
} catch (e) {
  console.error("ERROR:", e);
} finally {
  await ctx.close();
}
