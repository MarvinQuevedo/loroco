// Reverse-engineer dexie.space's "Connect Wallet → Goby Wallet" flow.
//
// Strategy: BEFORE the page's scripts run, wrap window.chia so every
// property access and method call is logged. Then click Connect → Goby and
// see exactly what dexie's code touches on our provider.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";

const EXT_PATH =
  "/Users/marvin/Projects/Ozone/sage-web/ozone-web-extension/packages/extension/.output/chrome-mv3";
const USER_DATA = "/tmp/Ozone-PW-DxDbg";
const SHOT_DIR = "/tmp/ozone-pw-dxdbg";

mkdirSync(SHOT_DIR, { recursive: true });
const log = (...a) => console.log("[dxdbg]", ...a);

const ctx = await chromium.launchPersistentContext(USER_DATA, {
  headless: false,
  channel: "chromium",
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-position=0,0",
    "--window-size=1200,900",
  ],
});

try {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
  log("ext up");

  const page = await ctx.newPage();

  // Install a Proxy around window.chia BEFORE dexie's scripts run.
  // initScript runs in MAIN world at document_start, but AFTER our inpage.ts
  // (which also runs at document_start via the content script injection).
  // We poll briefly and then wrap.
  await page.addInitScript(() => {
    const tag = "[OZONE-TRACE]";
    const log = (...a) => console.log(tag, ...a);

    // Trace window.postMessage. Filter out our own bridge messages
    // (target: "ozone-content" / "ozone-inpage") and the chrome devtools
    // hub noise.
    const origPM = window.postMessage.bind(window);
    window.postMessage = function (msg, ...rest) {
      try {
        const s = JSON.stringify(msg).slice(0, 200);
        if (!s.includes("ozone-content") && !s.includes("ozone-inpage")) {
          log("postMessage:", s);
        }
      } catch {
        log("postMessage: <unserializable>");
      }
      return origPM(msg, ...rest);
    };

    // Trace `addEventListener` registrations on window — Goby's SDK likely
    // hooks 'message' events with a custom signature.
    const origAEL = window.addEventListener.bind(window);
    window.addEventListener = function (type, fn, opts) {
      if (type === "message") {
        log(`addEventListener('message', ...)  fn.toString[0..120]=${(fn?.toString?.() ?? "<?>").slice(0, 120)}`);
      }
      return origAEL(type, fn, opts);
    };

    const argsRepr = (args) =>
      args
        .map((a) => {
          try {
            return JSON.stringify(a).slice(0, 200);
          } catch {
            return String(a);
          }
        })
        .join(", ");

    // window.chia is defined with configurable:false in our inpage.ts so we
    // can't swap the whole reference. But its OWN methods (request/on/off/...)
    // are default-writable, so we replace each one with a logging wrapper.
    const wrapMethod = (obj, name) => {
      const orig = obj[name];
      if (typeof orig !== "function") return;
      obj[name] = function (...args) {
        log(`CALL chia.${name}(${argsRepr(args)})`);
        try {
          const ret = orig.apply(this, args);
          if (ret && typeof ret.then === "function") {
            return ret.then(
              (v) => {
                log(`RES  chia.${name} → ${JSON.stringify(v).slice(0, 200)}`);
                return v;
              },
              (e) => {
                log(`REJ  chia.${name} → ${e?.message ?? e}`);
                throw e;
              },
            );
          }
          return ret;
        } catch (e) {
          log(`THROW chia.${name} → ${e?.message ?? e}`);
          throw e;
        }
      };
    };

    const dump = (label, obj) => {
      const own = Object.getOwnPropertyNames(obj);
      const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(obj) ?? {});
      log(`${label} own:`, own.join(","));
      if (proto.length) log(`${label} proto:`, proto.join(","));
    };

    let installed = false;
    const tryInstall = () => {
      if (installed || !window.chia) return false;
      installed = true;
      dump("window.chia", window.chia);
      const originals = {};
      for (const m of [
        "request",
        "on",
        "off",
        "removeListener",
        "isConnected",
        "enable",
        "connect",
        "getPublicKeys",
        "requestAccounts",
      ]) {
        originals[m] = window.chia[m];
      }
      for (const m of Object.keys(originals)) {
        wrapMethod(window.chia, m);
      }
      // Confirm replacement by checking each assigned method.
      for (const m of Object.keys(originals)) {
        const cur = window.chia[m];
        if (typeof originals[m] === "function") {
          log(`POST: window.chia.${m} replaced=${cur !== originals[m]} type=${typeof cur}`);
        }
      }
      // Self-test: call our newly installed `request` wrapper RIGHT NOW.
      // If we don't see a CALL trace, the wrapper is dead.
      try {
        window.chia.request({ method: "__selftest__" }).catch(() => {});
        log("SELF-TEST: dispatched window.chia.request({method:'__selftest__'})");
      } catch (e) {
        log("SELF-TEST: threw:", e?.message ?? e);
      }
      log("installed traces");
      return true;
    };
    let n = 0;
    const id = setInterval(() => {
      n += 1;
      if (tryInstall() || n > 120) clearInterval(id);
    }, 20);

    // Also catch any reads of well-known optional Goby fields by getter
    // probing. If dexie checks e.g. `window.chia.providers` we'd see nothing
    // — log the page's accesses to a small list of guessed extras.
    setTimeout(() => {
      if (!window.chia) return;
      const guesses = ["providers", "version", "apiVersion", "selectedAddress", "chainId", "isGoby", "isOzone", "name"];
      for (const g of guesses) {
        try {
          log(`PROBE chia.${g} =`, JSON.stringify(window.chia[g]));
        } catch {}
      }
    }, 500);
  });

  // Forward [OZONE-TRACE] lines + ALL errors + warnings.
  page.on("console", (m) => {
    const t = m.text();
    const type = m.type();
    if (t.includes("[OZONE-TRACE]")) log("page:", t);
    else if (type === "error" || type === "warning") log(`page-${type}:`, t.slice(0, 200));
  });
  page.on("pageerror", (e) => log("page-pageerror:", e.message));

  log("loading dexie.space");
  await page.goto("https://dexie.space", { waitUntil: "networkidle", timeout: 30_000 });
  await wait(2000); // let React hydrate fully
  await page.screenshot({ path: `${SHOT_DIR}/01-loaded.png` });

  // Add document click listener BEFORE any picker interaction so we see
  // both the picker open click and the inner Connect click.
  await page.evaluate(() => {
    window.__ozoneClicks = [];
    document.addEventListener(
      "click",
      (e) => {
        const tg = e.target;
        const txt =
          (tg && tg.innerText && tg.innerText.slice(0, 60)) || "<no text>";
        window.__ozoneClicks.push({ tag: tg?.tagName, text: txt });
        console.log("[OZONE-TRACE] document click → target=", tg?.tagName, "text=", txt);
      },
      true,
    );
    window.__ozoneListenerInstalled = true;
    console.log("[OZONE-TRACE] document click listener installed");
  });
  const installed = await page.evaluate(() => window.__ozoneListenerInstalled);
  log("listener installed flag:", installed);

  // Install an array-sink wrapper on chia.request BEFORE we click. The
  // addInitScript wrapper's console.log doesn't reach our console listener
  // when called from React's event handler, but writing to an array
  // bypasses console buffering entirely.
  await page.evaluate(() => {
    window.__chiaSink = [];
    const orig = window.chia.request;
    window.chia.request = function (args) {
      window.__chiaSink.push({ method: args?.method, params: args?.params, t: Date.now() });
      return orig.call(this, args);
    };
  });
  log("array-sink installed on chia.request");

  log("clicking Connect Wallet");
  await page.locator("button:has-text('Connect Wallet')").first().click();
  await wait(1500);
  await page.screenshot({ path: `${SHOT_DIR}/02-picker.png` });

  log("clicking Connect inside Goby Wallet row — watch for trace lines");
  // The picker rows render in order: [WalletConnect][Goby][Pawket].
  // The second "Connect" button in document order is Goby's.
  const connectBtns = page.locator(":visible >> button:has-text('Connect')").filter({
    hasText: /^Connect$/,
  });
  const total = await connectBtns.count();
  log("total visible Connect buttons in picker:", total);
  for (let i = 0; i < total; i += 1) {
    const t = await connectBtns.nth(i).innerText().catch(() => "");
    log(`  [${i}]`, JSON.stringify(t));
  }
  const gobyConnect = connectBtns.nth(1); // index 1 == Goby row
  log("goby connect button visible?", await gobyConnect.isVisible().catch(() => false));
  await gobyConnect.click();
  // Install an unhandledrejection capture before waiting.
  await page.evaluate(() => {
    window.__ozoneErrors = [];
    window.addEventListener("unhandledrejection", (e) => {
      window.__ozoneErrors.push("unhandled: " + (e.reason?.message ?? e.reason));
      console.log("[OZONE-TRACE] unhandledrejection:", e.reason?.message ?? e.reason);
    });
    window.addEventListener("error", (e) => {
      window.__ozoneErrors.push("error: " + e.message);
      console.log("[OZONE-TRACE] error:", e.message);
    });
  });

  log("waited 5s for any window.chia.* trace…");
  await wait(5000);
  const sink1 = await page.evaluate(() => window.__chiaSink || []);
  log("→ chia.request calls observed after Goby click:", JSON.stringify(sink1));

  const fnView = await page.evaluate(() => ({
    requestStr: window.chia.request.toString().slice(0, 200),
    hasInstalledFlag: !!window.__ozoneListenerInstalled,
  }));
  log("page.evaluate view of chia.request:", fnView.requestStr.slice(0, 100));
  log("listener flag visible from evaluate:", fnView.hasInstalledFlag);

  // Direct invocation — DOES this fire the wrapper's console.log? Capture
  // it via window.__ozoneCalls just in case console.log is being eaten.
  await page.evaluate(() => {
    window.__ozoneCalls = [];
    // Re-wrap one more time, this time pushing to an array we can read back.
    const orig = window.chia.request;
    window.chia.request = function (...args) {
      window.__ozoneCalls.push({ from: "re-wrapped", method: args[0]?.method, ts: Date.now() });
      console.log("[OZONE-TRACE-RW] CALL chia.request", JSON.stringify(args[0]));
      return orig.apply(this, args);
    };
  });
  log("re-wrapped chia.request with array sink");

  log("→ direct page call");
  await page.evaluate(async () => {
    try {
      const r = await window.chia.request({ method: "chainId" });
      console.log("[OZONE-TRACE-RW] result:", JSON.stringify(r));
    } catch (e) {
      console.log("[OZONE-TRACE-RW] err:", e?.message ?? e);
    }
  });
  await wait(1000);
  const calls = await page.evaluate(() => window.__ozoneCalls || []);
  log("re-wrap captured calls:", JSON.stringify(calls));
  await page.screenshot({ path: `${SHOT_DIR}/04-after-click.png` });
  // Pull state from the page rather than relying on console buffering.
  const dump = await page.evaluate(() => ({
    clicks: window.__ozoneClicks || [],
    errors: window.__ozoneErrors || [],
    // Probe what df() would see now.
    chia_isGoby: window.chia?.isGoby,
    chia_isOzone: window.chia?.isOzone,
    chia_name: window.chia?.name,
  }));
  log("captured state:", JSON.stringify(dump, null, 2));
  await page.screenshot({ path: `${SHOT_DIR}/03-after-click.png` });

  log("done. screenshots in:", SHOT_DIR);
} catch (err) {
  console.error("[dxdbg] ERROR:", err);
} finally {
  await ctx.close();
}
