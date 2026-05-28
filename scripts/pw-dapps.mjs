// Smoke for real dApps:
//   • https://dexie.space   — offer marketplace, uses window.chia (Goby).
//   • https://v2.tibetswap.io — AMM, also uses window.chia.
//
// What we check on each:
//   1. window.ozone is present and === window.chia.
//   2. isGoby + isOzone flags survive after the page's own scripts run
//      (some dApps probe and overwrite the provider — they shouldn't).
//   3. Finding a "Connect" button / wallet picker triggers our content-bridge
//      and pops a connect prompt.
//
// We don't actually approve any connect (no popup automation here — that's
// what pw-send-tx covers). The smoke just verifies the page can SEE our
// provider and the dApp's connect path reaches the SW. Screenshots in
// /tmp/ozone-pw-dapps/.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";

const EXT_PATH =
  "/Users/marvin/Projects/Ozone/loroco/packages/extension/.output/chrome-mv3";
const USER_DATA = "/tmp/Ozone-PW-Dapps";
const SHOT_DIR = "/tmp/ozone-pw-dapps";

mkdirSync(SHOT_DIR, { recursive: true });

const log = (...args) => console.log("[dapps]", ...args);

const ctx = await chromium.launchPersistentContext(USER_DATA, {
  headless: false,
  channel: "chromium",
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-position=0,0",
    "--window-size=1200,800",
  ],
});

const sites = [
  { name: "dexie", url: "https://dexie.space" },
  { name: "tibet", url: "https://v2.tibetswap.io" },
];

const summary = [];

try {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
  log("extension up");

  // Log every new page in the context so we see if the approval window
  // appears under a different name.
  ctx.on("page", (p) => {
    log(`>>> new page in context: ${p.url()}`);
  });

  for (const site of sites) {
    log(`--- ${site.name} ${site.url} ---`);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => log(`${site.name} pageerror:`, e.message));
    page.on("console", (m) => {
      if (m.type() === "error") log(`${site.name} console.error:`, m.text());
    });

    try {
      await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch (err) {
      log(`${site.name} navigation failed:`, err.message);
      summary.push({ site: site.name, status: "navigation-failed", reason: err.message });
      await page.close();
      continue;
    }
    // Some dApps re-inject their own provider during boot. Give them a moment.
    await wait(3500);
    await page.screenshot({ path: `${SHOT_DIR}/${site.name}-01-loaded.png`, fullPage: false }).catch(() => {});

    const probe = await page.evaluate(() => {
      const w = window;
      const hasOzone = typeof w.ozone === "object" && w.ozone !== null;
      const hasChia = typeof w.chia === "object" && w.chia !== null;
      return {
        hasOzone,
        hasChia,
        sameRef: hasOzone && hasChia && w.ozone === w.chia,
        isOzone: hasOzone ? w.ozone.isOzone : null,
        isGoby: hasChia ? w.chia.isGoby : null,
        chiaName: hasChia ? w.chia.name : null,
        chiaVersion: hasChia ? w.chia.version : null,
      };
    });
    log(`${site.name} probe:`, probe);

    let approvalOpened = false;
    if (!probe.hasOzone || !probe.hasChia) {
      log(`${site.name}: provider missing — dApp's own scripts likely overwrote it`);
      summary.push({ site: site.name, status: "provider-missing", probe });
      await page.close();
      continue;
    }

    // Try to find a connect button. Each dApp uses different copy — match
    // common variants. We don't click yet, we just verify the surface.
    const connectCandidates = [
      "button:has-text('Connect Wallet')",
      "button:has-text('Connect')",
      "a:has-text('Connect Wallet')",
      "[role='button']:has-text('Connect')",
    ];
    let connectLoc = null;
    for (const sel of connectCandidates) {
      const c = page.locator(sel).first();
      if (await c.isVisible().catch(() => false)) {
        connectLoc = c;
        log(`${site.name}: found connect via "${sel}"`);
        break;
      }
    }
    if (!connectLoc) {
      log(`${site.name}: no connect button visible — page may use a non-standard label`);
    }

    // Fire a CHIP-0002 chainId request directly through our injected provider
    // to confirm the page → content bridge → SW round-trip works regardless
    // of dApp UX. (We expect an unauthorized error since we haven't approved
    // this origin yet — that's still a successful round-trip.)
    const callOut = await page.evaluate(async () => {
      try {
        const v = await window.ozone.request({ method: "chainId" });
        return { ok: true, value: v };
      } catch (err) {
        return {
          ok: false,
          error: {
            message: err && err.message,
            code: err && err.code,
          },
        };
      }
    });
    log(`${site.name} ozone.request(chainId) →`, JSON.stringify(callOut));

    // Also fire connect() directly so we can see whether the approval window
    // opens regardless of the dApp's own UI handshake. Don't await — the
    // promise hangs until the user approves (which we don't do here).
    const directConnectPopup = ctx.waitForEvent("page", { timeout: 6000 }).catch(() => null);
    await page.evaluate(() => {
      window.ozone
        .request({ method: "connect" })
        .then(() => console.log("[ozone] direct connect resolved"))
        .catch((e) => console.log("[ozone] direct connect rejected:", e?.message));
    });
    const directApproval = await directConnectPopup;
    if (directApproval) {
      log(`${site.name}: direct connect opened approval at ${directApproval.url()}`);
      approvalOpened = true;
      await directApproval.waitForLoadState("domcontentloaded").catch(() => {});
      // chrome.windows.create({width:400,height:600}) — match the real
      // popup viewport so the screenshot reflects what users actually see.
      await directApproval.setViewportSize({ width: 400, height: 600 }).catch(() => {});
      await wait(600);
      await directApproval
        .screenshot({ path: `${SHOT_DIR}/${site.name}-04-approval.png` })
        .catch(() => {});
      await directApproval.close().catch(() => {});
    } else {
      log(`${site.name}: direct connect did NOT open approval — bridge issue`);
    }

    await page.screenshot({ path: `${SHOT_DIR}/${site.name}-02-probed.png` }).catch(() => {});

    // Click Connect — this should spawn a wallet picker (each dApp has its
    // own). We then look for an entry that mentions "Goby" or "Ozone" and
    // click it. If a popup opens, it's our approval page.
    if (connectLoc && !approvalOpened) {
      try {
        await connectLoc.click();
        await wait(1500);
        await page.screenshot({ path: `${SHOT_DIR}/${site.name}-03-picker.png` }).catch(() => {});

        // Both dexie and tibet list our provider under "Goby Wallet"
        // (because isGoby:true). The picker row is "Goby Wallet … [Connect]"
        // — find the Connect BUTTON that lives inside the Goby Wallet row.
        const walletCandidates = [
          ':text-is("Goby Wallet") >> xpath=ancestor::*[.//button[normalize-space()="Connect"]][1] >> button:has-text("Connect")',
          ':text-matches("Goby", "i") >> xpath=ancestor::*[.//button[normalize-space()="Connect"]][1] >> button:has-text("Connect")',
          'button:has-text("Ozone")',
        ];
        for (const sel of walletCandidates) {
          const c = page.locator(sel).first();
          if (await c.isVisible().catch(() => false)) {
            log(`${site.name}: clicking wallet via "${sel.slice(0, 40)}…"`);
            const popupPromise = ctx.waitForEvent("page", { timeout: 5000 }).catch(() => null);
            await c.click();
            const approval = await popupPromise;
            if (approval) {
              approvalOpened = true;
              await approval.waitForLoadState("domcontentloaded").catch(() => {});
              await wait(800);
              await approval
                .screenshot({ path: `${SHOT_DIR}/${site.name}-04-approval.png` })
                .catch(() => {});
              await approval.close().catch(() => {});
            } else {
              log(`${site.name}: click fired but no approval window opened`);
            }
            break;
          }
        }
      } catch (err) {
        log(`${site.name} connect-click error:`, err.message);
      }
    }

    summary.push({
      site: site.name,
      status: probe.sameRef && probe.isOzone && probe.isGoby ? "ok" : "partial",
      probe,
      chainId: callOut,
      connectButtonFound: !!connectLoc,
      approvalOpened,
    });

    await page.close();
  }

  log("=== SUMMARY ===");
  for (const s of summary) {
    log(s.site, s.status, JSON.stringify({
      sameRef: s.probe?.sameRef,
      isOzone: s.probe?.isOzone,
      isGoby: s.probe?.isGoby,
      connect: s.connectButtonFound,
      chainIdOk: s.chainId?.ok ?? false,
      chainIdCode: s.chainId?.error?.code,
      approvalOpened: s.approvalOpened,
    }));
  }
  log("screenshots in:", SHOT_DIR);
} catch (err) {
  console.error("[dapps] ERROR:", err);
} finally {
  await ctx.close();
}
