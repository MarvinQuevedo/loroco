// Loroco security audit — adversarial dApp suite.
//
// Loads the extension into a fresh persistent profile, imports a wallet,
// and walks an attacker page at https://attacker.example/ through 12
// attack vectors. Each case verifies a concrete defense in the
// page → content → background pipeline.
//
// See ./README.md for the attack matrix and threat model.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

const __here = dirname(fileURLToPath(import.meta.url));
const EXT_PATH = resolve(__here, "..", "..", "packages/extension/.output/chrome-mv3");
const USER_DATA = process.env.USER_DATA ?? "/tmp/Loroco-PW-Security";
const SHOT_DIR = "/tmp/loroco-pw-security";
const MNEMONIC =
  process.env.MNEMONIC ??
  "charge day cloth frame purpose lake method segment fat gadget regret open better rent visual picnic crater degree budget satoshi shop maple depart host";

mkdirSync(SHOT_DIR, { recursive: true });
const log = (...a) => console.log("[sec]", ...a);

const ATTACKER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Attacker</title></head>
<body>
  <h1>Loroco attacker test page</h1>
  <p id="status">ready</p>
  <iframe id="evil-frame" src="about:blank" style="display:none"></iframe>
  <script>
    // Mark the page so the audit knows it loaded.
    window.__attackerReady = true;
    window.__seenWindowChia = typeof window.chia !== "undefined";
  </script>
</body></html>`;

const VICTIM_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Victim</title></head>
<body>
  <h1>Already-connected dApp</h1>
  <p id="status">ready</p>
  <script>window.__victimReady = true;</script>
</body></html>`;

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

// Serve our fake origins via Playwright route() so content scripts attach
// (matches: ["<all_urls>"] in content.ts) and window.chia gets injected.
await ctx.route("https://attacker.example/**", (route) => {
  route.fulfill({ status: 200, contentType: "text/html", body: ATTACKER_HTML });
});
await ctx.route("https://victim.example/**", (route) => {
  route.fulfill({ status: 200, contentType: "text/html", body: VICTIM_HTML });
});

let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
const extId = sw.url().split("/")[2];
log("ext id:", extId);

// Capture SW errors / analyze logs. The breakdown popup-rpc handler is
// notoriously async — when it crashes or throws, the popup just shows
// "Decoding…" forever. Surfacing SW console traffic here turns a silent
// hang into a visible line in the audit log.
sw.on("console", (m) => {
  const t = m.type();
  if (t === "error" || t === "warning") {
    log(`[sw-${t}] ${m.text().slice(0, 240)}`);
  } else if (/analyze|breakdown|sign_coin/i.test(m.text())) {
    log(`[sw] ${m.text().slice(0, 240)}`);
  }
});

// ── Bootstrap: import wallet + connect victim.example ───────────────────
// `popup` is mutable because Loroco closes it after each decision (typical
// wallet UX). `ensurePopup()` reopens it on demand so attacks downstream of
// an autoApprove/autoReject don't crash on a stale page reference.
let popup = await ctx.newPage();
await popup.setViewportSize({ width: 380, height: 600 });
await popup.goto(`chrome-extension://${extId}/popup.html`);
await popup.waitForLoadState("domcontentloaded");
await wait(1000);

async function ensurePopup() {
  if (popup && !popup.isClosed()) return popup;
  popup = await ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForLoadState("domcontentloaded");
  await wait(600);
  return popup;
}

const popupText = await popup.locator("body").innerText();
if (/Import|Create/i.test(popupText) && !/balance/i.test(popupText)) {
  const importBtn = popup.locator("button", { hasText: /Import mnemonic/i }).first();
  if (await importBtn.isVisible().catch(() => false)) await importBtn.click();
  await wait(400);
  await popup.locator("textarea").first().fill(MNEMONIC);
  await popup.locator("input[type='password']").first().fill("marvin");
  await popup.locator("button", { hasText: /^Continue$/ }).first().click();
  await wait(3500);
}
log("wallet ready");

// Force Goby-compat ON for the bulk of the suite. The extension build is
// production-mode (default legacyGoby=false), but every attack from 01–12
// drives the dApp through window.chia and chia_*/chip0002_* aliases — so
// without this the entire suite would hit MethodNotFound and report false
// "leaks". Attack 18 owns its own off/on flip to actually verify the gate.
await popup.evaluate(() =>
  chrome.storage.local.set({ "settings.compat": { legacyGoby: true } }),
);

async function autoApprove() {
  await ensurePopup();
  for (let i = 0; i < 10; i += 1) {
    const btn = popup.locator("button", { hasText: /^Approve$/ }).first();
    if (await btn.isVisible().catch(() => false)) {
      try {
        await btn.click({ timeout: 1500 });
        return true;
      } catch {}
    }
    await wait(300);
  }
  return false;
}

async function autoReject() {
  await ensurePopup();
  for (let i = 0; i < 10; i += 1) {
    const btn = popup.locator("button", { hasText: /^(Reject|Cancel)$/ }).first();
    if (await btn.isVisible().catch(() => false)) {
      try {
        await btn.click({ timeout: 1500 });
        return true;
      } catch {}
    }
    await wait(300);
  }
  return false;
}

// Surface console errors + page crashes from every tab. Without this a
// crashed renderer is reported as a cryptic "Target crashed" with zero
// context — the trace below shows the actual page error or SW log that
// led to the crash.
ctx.on("page", (p) => {
  p.on("pageerror", (e) => log(`[page-err ${p.url().slice(0, 40)}] ${e.message?.slice(0, 200)}`));
  p.on("crash", () => log(`[page-crash] ${p.url()}`));
  p.on("console", (m) => {
    const t = m.type();
    if (t === "error" || t === "warning") {
      log(`[page-${t} ${p.url().slice(0, 40)}] ${m.text().slice(0, 200)}`);
    }
  });
});

// Pre-connect the "victim" origin so iframe-confused-deputy attacks have a
// real connected origin to abuse. `victim` is `let` so individual attacks
// can recreate it if Chrome kills the tab mid-suite (see attack 17).
let victim = await ctx.newPage();
await victim.goto("https://victim.example/", { waitUntil: "domcontentloaded" });
await wait(800);
const victimConnectP = victim.evaluate(() =>
  window.chia.request({ method: "requestAccounts" }).catch((e) => e?.message),
);
await wait(800);
await autoApprove();
await victimConnectP;
log("victim.example connected");

let attacker = await ctx.newPage();
await attacker.goto("https://attacker.example/", { waitUntil: "domcontentloaded" });
await wait(800);

// ── Attack definitions ──────────────────────────────────────────────────

const ATTACKS = [
  // 01 — Unconnected read.
  {
    id: "01",
    name: "unconnected origin → read method (getPublicKeys)",
    run: async () => {
      const r = await attacker.evaluate(() =>
        window.chia
          .request({ method: "getPublicKeys" })
          .then((res) => ({ ok: true, res }))
          .catch((e) => ({ ok: false, code: e?.code, msg: e?.message })),
      );
      const held = !r.ok && r.code === 4001;
      return {
        held,
        detail: held
          ? `code=${r.code} "${r.msg}"`
          : `LEAKED: ${JSON.stringify(r).slice(0, 200)}`,
      };
    },
  },

  // 02 — Unconnected mutating call. Should be rejected by ensurePermissions
  // BEFORE the approval popup is created. We verify by asserting (a) the
  // call rejects with 4001 and (b) no Approve button appears within 2s.
  {
    id: "02",
    name: "unconnected origin → mutating (transfer) — no popup should appear",
    run: async () => {
      let popupAppeared = false;
      const watch = (async () => {
        for (let i = 0; i < 6; i += 1) {
          await wait(300);
          const visible = await popup
            .locator("button", { hasText: /^Approve$/ })
            .first()
            .isVisible()
            .catch(() => false);
          if (visible) {
            popupAppeared = true;
            await autoReject(); // clean up if the defense actually failed
            return;
          }
        }
      })();
      const r = await attacker.evaluate(() =>
        window.chia
          .request({
            method: "transfer",
            params: {
              to: "xch10qx8jkn8sh9prltm0nemvt53vk75dn47g78d39y448cnpaaftchqkcnygl",
              amount: "1",
            },
          })
          .then((res) => ({ ok: true, res }))
          .catch((e) => ({ ok: false, code: e?.code, msg: e?.message })),
      );
      await watch;
      const held = !r.ok && r.code === 4001 && !popupAppeared;
      return {
        held,
        detail: held
          ? `code=${r.code}, no popup spawned (correct)`
          : `popup=${popupAppeared} response=${JSON.stringify(r).slice(0, 160)}`,
      };
    },
  },

  // 03 — Origin spoofing. The page posts a CONTENT_TARGET message with a
  // forged `origin` field claiming to be victim.example. The content
  // bridge forwards it to the SW; the SW uses `sender.origin ?? msg.origin`.
  // Since sender.origin is the REAL page origin (Chrome-supplied), the spoof
  // should be ignored.
  {
    id: "03",
    name: "spoofed `origin` in CONTENT_TARGET message",
    run: async () => {
      const r = await attacker.evaluate(async () => {
        return new Promise((resolve) => {
          const id = 0xC0DE;
          const onReply = (ev) => {
            if (ev.source !== window) return;
            if (ev.data?.target !== "loroco-inpage") return;
            if (ev.data?.id !== id) return;
            window.removeEventListener("message", onReply);
            resolve({
              ok: !ev.data.error,
              code: ev.data.error?.code,
              msg: ev.data.error?.message,
              result: ev.data.result,
            });
          };
          window.addEventListener("message", onReply);
          window.postMessage(
            {
              target: "loroco-content",
              id,
              origin: "https://victim.example",  // forged
              method: "getPublicKeys",
              params: {},
            },
            window.location.origin,
          );
          setTimeout(() => {
            window.removeEventListener("message", onReply);
            resolve({ timedOut: true });
          }, 3000);
        });
      });
      // If the spoof worked, the call would succeed (since victim is
      // connected). If sender.origin is honoured, attacker is unconnected
      // and we get 4001.
      const held = !r.ok && r.code === 4001;
      return {
        held,
        detail: held
          ? `spoof ignored (4001), sender.origin honoured`
          : `LEAKED with spoof: ${JSON.stringify(r).slice(0, 200)}`,
      };
    },
  },

  // 04 — iframe attempts to send CONTENT_TARGET into the parent.
  //
  // The content bridge in the parent only listens on its own window; an
  // iframe's window is a different object. We mount a same-origin iframe
  // (so the inner postMessage doesn't get blocked by SOP) and have IT post
  // to the parent. The parent bridge does `if (ev.source !== window) return`
  // which should drop it.
  {
    id: "04",
    name: "iframe posts CONTENT_TARGET to parent",
    run: async () => {
      const r = await attacker.evaluate(async () => {
        const frame = document.getElementById("evil-frame");
        // Same-origin so the inner script can call parent.postMessage.
        // We write the doc directly via srcdoc to keep it inside this origin.
        frame.srcdoc = `<script>
          window.onload = () => parent.postMessage({
            target: "loroco-content",
            id: 0xBEEF,
            origin: "https://victim.example",
            method: "getPublicKeys",
            params: {},
          }, "*");
        </script>`;
        return new Promise((resolve) => {
          const onReply = (ev) => {
            // Filter by reply target so we don't catch the iframe's own
            // outgoing request bouncing through the parent window listeners.
            if (ev.data?.target !== "loroco-inpage") return;
            if (ev.data?.id !== 0xBEEF) return;
            window.removeEventListener("message", onReply);
            resolve({
              ok: !ev.data.error,
              code: ev.data.error?.code,
              msg: ev.data.error?.message,
            });
          };
          window.addEventListener("message", onReply);
          setTimeout(() => {
            window.removeEventListener("message", onReply);
            resolve({ timedOut: true, blocked: true });
          }, 2500);
        });
      });
      // We expect timeout because the parent bridge drops the iframe message
      // (ev.source !== window). If the bridge accepted it, we'd get a reply
      // (either success or a non-timeout error).
      const held = Boolean(r.timedOut);
      return {
        held,
        detail: held
          ? `no reply (parent bridge ignored iframe message)`
          : `LEAKED: bridge processed iframe message ${JSON.stringify(r).slice(0, 200)}`,
      };
    },
  },

  // 05 — `chrome` global in MAIN world.
  {
    id: "05",
    name: "chrome.runtime visible from MAIN world",
    run: async () => {
      const r = await attacker.evaluate(() => ({
        chromeType: typeof globalThis.chrome,
        runtimeType: typeof globalThis.chrome?.runtime,
        canSendMessage: typeof globalThis.chrome?.runtime?.sendMessage,
      }));
      // `chrome.runtime` on a regular https page is a limited "stub" exposed
      // only when the page is in `externally_connectable` allowlist. For our
      // extension that allowlist is unset, so sendMessage should be missing.
      const held = r.canSendMessage !== "function";
      return {
        held,
        detail: `chrome=${r.chromeType} runtime=${r.runtimeType} sendMessage=${r.canSendMessage}`,
      };
    },
  },

  // 06 — window.chia surface inspection for sensitive fields.
  {
    id: "06",
    name: "window.chia exposes only documented surface",
    run: async () => {
      const r = await attacker.evaluate(() => {
        const keys = [];
        for (const k in window.chia) keys.push(k);
        for (const k of Object.getOwnPropertyNames(window.chia)) {
          if (!keys.includes(k)) keys.push(k);
        }
        const banned = [
          "mnemonic",
          "masterKey",
          "masterPublicKey",
          "secretKey",
          "privateKey",
          "engine",
          "wasm",
          "storage",
          "__internal",
          "_pending",
        ];
        const found = banned.filter((b) => keys.includes(b));
        return { keys, found };
      });
      const held = r.found.length === 0;
      return {
        held,
        detail: held
          ? `surface=[${r.keys.join(", ")}] — no banned fields`
          : `LEAKED banned fields: ${r.found.join(", ")}`,
      };
    },
  },

  // 07 — Race: 5 parallel signMessage. None should succeed without approval;
  // approving once should resolve exactly one and leave the rest pending.
  // We reject everything in the popup as soon as it appears.
  //
  // Run on the CONNECTED victim page so we actually reach the approval
  // gate (an unconnected origin would fail at 4001 first).
  {
    id: "07",
    name: "race: 5 parallel signMessage from connected origin",
    run: async () => {
      const inFlight = victim.evaluate(() => {
        const calls = [];
        for (let i = 0; i < 5; i += 1) {
          calls.push(
            window.chia
              .request({
                method: "signMessage",
                params: {
                  message: "0xdeadbeef",
                  publicKey:
                    "0x9151a26fa259bb6af0bfc1976e76c20222e243fbb699da0f66a93d98e2fd662b498eae60cb4987d2be3c45937593d1ce",
                },
              })
              .then((r) => ({ ok: true, r }))
              .catch((e) => ({ ok: false, code: e?.code, msg: (e?.message ?? "").slice(0, 80) })),
          );
        }
        return Promise.all(calls);
      });
      // Reject every pending approval one by one.
      let rejected = 0;
      for (let i = 0; i < 8; i += 1) {
        const ok = await autoReject();
        if (ok) rejected += 1;
        await wait(200);
      }
      const results = await inFlight;
      // All five must have ended in user-rejected (4002) OR unauthorized.
      // None should have a `r.ok === true` because we never approved.
      const leaked = results.filter((r) => r.ok);
      const held = leaked.length === 0;
      return {
        held,
        detail: held
          ? `all 5 calls blocked, ${rejected} popups rejected`
          : `LEAKED: ${leaked.length} signMessage call(s) succeeded without approval`,
      };
    },
  },

  // 08 — Try to overwrite window.chia with a fake provider.
  {
    id: "08",
    name: "overwrite window.chia",
    run: async () => {
      const r = await attacker.evaluate(() => {
        const before = window.chia;
        try {
          // Strict-mode write to a non-writable property throws TypeError.
          window.chia = { request: () => "GOTCHA" };
        } catch (e) {
          return { threw: true, msg: e.message, sameRef: window.chia === before };
        }
        return { threw: false, sameRef: window.chia === before, after: window.chia };
      });
      // Either it throws OR the reference stays the same (Object.defineProperty
      // with writable:false silently fails outside strict mode in some envs).
      const held = r.sameRef;
      return {
        held,
        detail: held
          ? `protected (threw=${r.threw})`
          : `LEAKED: window.chia replaced by fake provider`,
      };
    },
  },

  // 09 — Forge an approval message from the page.
  // chrome.runtime.sendMessage is unavailable to MAIN world; the only path
  // to the SW is through window.postMessage → content bridge → runtime.
  // The bridge wraps page messages as `{from: "content", ...}`. Approval
  // messages have `from: "approval"`. We try to smuggle an approval-shaped
  // message through postMessage and verify it can't decide a pending request.
  {
    id: "09",
    name: "smuggle approval-shaped message via content bridge",
    run: async () => {
      // First, queue a real pending approval on the connected victim so
      // there IS something to decide.
      const pending = victim.evaluate(() =>
        window.chia
          .request({
            method: "signMessage",
            params: {
              message: "0xdeadbeef",
              publicKey:
                "0x9151a26fa259bb6af0bfc1976e76c20222e243fbb699da0f66a93d98e2fd662b498eae60cb4987d2be3c45937593d1ce",
            },
          })
          .then((r) => ({ ok: true, r }))
          .catch((e) => ({ ok: false, code: e?.code, msg: (e?.message ?? "").slice(0, 80) })),
      );
      await wait(800);
      // Try to forge from attacker. The content bridge wraps messages with
      // `from: "content"`, so the SW never sees `from: "approval"` from us.
      // We attempt anyway and assert we cannot drive the decision.
      await attacker.evaluate(() => {
        const sessionId = "fake-" + Math.random().toString(36).slice(2);
        window.postMessage(
          {
            target: "loroco-content",
            id: 0xFADE,
            origin: window.location.origin,
            method: "connect", // any method — we're testing the envelope, not the call
            params: { from: "approval", kind: "decide", id: sessionId, approved: true },
          },
          window.location.origin,
        );
      });
      await wait(600);
      // The victim's signMessage should still be pending (or already rejected
      // by our cleanup). Reject it manually and inspect the outcome.
      await autoReject();
      const result = await pending;
      // If forgery worked, victim's signMessage would have resolved without
      // a popup → result.ok === true. Otherwise it was rejected → 4002.
      const held = !result.ok;
      return {
        held,
        detail: held
          ? `forged approval ignored (result code=${result.code})`
          : `LEAKED: forged approval decided pending request`,
      };
    },
  },

  // 10 — Replay an old request id by posting a fabricated PAGE_TARGET reply.
  // This is a self-inflicted XSS-style replay: we try to resolve a request
  // id from outside the inpage script. Inpage's pending map only knows IDs
  // it generated, so an unknown id should be dropped silently.
  {
    id: "10",
    name: "replay fabricated PAGE_TARGET reply with unknown id",
    run: async () => {
      const r = await attacker.evaluate(async () => {
        // Fire the fabricated reply, then issue a real request and verify
        // the real one still gets its proper response (i.e. the fake didn't
        // poison the pending map).
        window.postMessage(
          {
            target: "loroco-inpage",
            id: 99999, // an id we never issued
            result: "EVIL",
          },
          window.location.origin,
        );
        await new Promise((r) => setTimeout(r, 200));
        try {
          // Unconnected, so this throws 4001 — but the IMPORTANT thing is
          // that the fabricated message didn't break the channel.
          await window.chia.request({ method: "getPublicKeys" });
          return { ok: true, surprise: true };
        } catch (e) {
          return { ok: false, code: e?.code, msg: e?.message };
        }
      });
      const held = !r.ok && r.code === 4001;
      return {
        held,
        detail: held
          ? `fake reply ignored, real channel still works (code=${r.code})`
          : `LEAKED: ${JSON.stringify(r).slice(0, 160)}`,
      };
    },
  },

  // 11 — Massive payload. Use the victim (connected) page so we reach the
  // handler. Two assertions:
  //   (a) the content bridge rejects with 4029 (LimitExceeded) — proves
  //       the cap caught it BEFORE chrome.runtime.sendMessage; and
  //   (b) the SW is still alive afterwards (chainId works).
  // Before the fix this used to invalidate the entire extension context.
  {
    id: "11",
    name: "10MB payload rejected by size cap (no SW crash)",
    run: async () => {
      const huge = victim.evaluate(async () => {
        // 10MB = 10*1024*1024 hex chars (5MB of bytes).
        const hex = "ab".repeat(5 * 1024 * 1024);
        try {
          await window.chia.request({
            method: "signMessage",
            params: { message: "0x" + hex, publicKey: "0x" + "00".repeat(48) },
          });
          return { ok: true };
        } catch (e) {
          return { ok: false, code: e?.code, msg: (e?.message ?? "").slice(0, 120) };
        }
      });
      await wait(800);
      // No approval popup should appear — the cap fires in the content
      // bridge before reaching the SW. autoReject is a safety net in case
      // the cap was bypassed and the popup did spawn.
      await autoReject();
      const r = await huge;
      // Probe SW liveness with a short retry budget for transient MV3
      // restarts (a successful cap shouldn't restart the SW, but if it
      // did, one retry is enough).
      let alive = { ok: false };
      for (let attempt = 0; attempt < 4; attempt += 1) {
        alive = await victim.evaluate(() =>
          window.chia
            .request({ method: "chainId" })
            .then((r) => ({ ok: true, r }))
            .catch((e) => ({ ok: false, code: e?.code, msg: (e?.message ?? "").slice(0, 80) })),
        );
        if (alive.ok === true && alive.r === "mainnet") break;
        await wait(1500);
      }
      const capFired = !r.ok && r.code === 4029;
      const swAlive = alive.ok === true && alive.r === "mainnet";
      const held = capFired && swAlive;
      return {
        held,
        detail: held
          ? `cap rejected with 4029 + SW alive (chainId=${alive.r})`
          : `cap=${capFired} (code=${r.code}) swAlive=${swAlive} (${JSON.stringify(alive).slice(0, 120)})`,
      };
    },
  },

  // 13 — Lookalike subdomain. Chrome treats `victim.example.evil.com` as
  // a subdomain of evil.com, NOT a subdomain of victim.example. The
  // permission store must key by full origin, so connecting from the
  // lookalike must require its own explicit approval.
  {
    id: "13",
    name: "lookalike subdomain doesn't inherit victim's permission",
    run: async () => {
      // Register a route for the lookalike. Its origin is
      // https://victim.example.evil.com — totally different from victim.
      await ctx.route("https://victim.example.evil.com/**", (route) => {
        route.fulfill({ status: 200, contentType: "text/html", body: ATTACKER_HTML });
      });
      const lookalike = await ctx.newPage();
      await lookalike.goto("https://victim.example.evil.com/", { waitUntil: "domcontentloaded" });
      await wait(500);
      // Try a read call WITHOUT calling connect first. Must fail 4001.
      const r = await lookalike.evaluate(() =>
        window.chia
          .request({ method: "getPublicKeys" })
          .then((res) => ({ ok: true, res }))
          .catch((e) => ({ ok: false, code: e?.code, msg: e?.message })),
      );
      await lookalike.close();
      const held = !r.ok && r.code === 4001;
      return {
        held,
        detail: held
          ? `lookalike rejected with 4001 — needs its own explicit connect`
          : `LEAKED: lookalike inherited victim's permission: ${JSON.stringify(r).slice(0, 200)}`,
      };
    },
  },

  // 14 — Transfer popup display fidelity. `chia_send` (Sage WC2) uses
  // `address` instead of `to`. The handler accepts `p.to ?? p.address`,
  // so a dApp sending only `{address: "evil"}` will spend to `evil` —
  // but the approval popup must SHOW that recipient. If it shows an
  // empty "to" field, the user has no way to detect the destination
  // and could approve blindly.
  {
    id: "14",
    name: "chia_send approval popup shows the recipient (anti-display-spoof)",
    run: async () => {
      const evil = "xch10qx8jkn8sh9prltm0nemvt53vk75dn47g78d39y448cnpaaftchqkcnygl";
      const callP = victim.evaluate(
        async (addr) => {
          try {
            await window.chia.request({
              method: "chia_send",
              params: { address: addr, amount: "1" },
            });
            return { ok: true };
          } catch (e) {
            return { ok: false, code: e?.code, msg: (e?.message ?? "").slice(0, 100) };
          }
        },
        evil,
      );
      // Wait for the Approve button to render before snapshotting the body
      // — the popup needs a moment to navigate into ApprovalScreen.
      let popupText = "";
      for (let i = 0; i < 15; i += 1) {
        const visible = await popup
          .locator("button", { hasText: /^Approve$/ })
          .first()
          .isVisible()
          .catch(() => false);
        if (visible) {
          popupText = await popup.locator("body").innerText().catch(() => "");
          if (popupText.length > 0) break;
        }
        await wait(300);
      }
      await autoReject();
      await callP;
      const held = popupText.includes(evil);
      return {
        held,
        detail: held
          ? `popup shows the recipient address`
          : `LEAKED: popup did NOT show "${evil}". Body excerpt: ${popupText.replace(/\s+/g, " ").slice(0, 240)}`,
      };
    },
  },

  // 15 — Cross-origin offer cancellation.
  //
  // Seed a fake offer tagged with victim.example into the wallet's offer
  // store, then connect attacker (different origin) and have it cancel
  // that offer. Even if the user is tricked into approving the popup
  // (we auto-approve in this test), the handler must refuse because the
  // stored offer's `origin` doesn't match attacker's `sender.origin`.
  //
  // The defense is verified by checking the offer is NOT marked
  // `cancelled` in storage afterwards — independent of whatever the
  // attacker sees from the handler's response.
  {
    id: "15",
    name: "cross-origin offer cancellation (attacker can't cancel victim's offer)",
    run: async () => {
      // Earlier attacks can leave the attacker tab in a detached state
      // (popup navigations / autoApprove churn). Recreate on demand.
      await ensureAttacker();
      // Connect attacker so the call reaches the handler.
      const attackerConnectP = attacker.evaluate(() =>
        window.chia.request({ method: "connect" }).catch((e) => e?.message),
      );
      await wait(700);
      await autoApprove();
      await attackerConnectP;
      await wait(300);

      const fakeOfferIdNo0x = "ab".repeat(32);
      const fakeOfferIdWith0x = "0x" + fakeOfferIdNo0x;

      // Seed the offer via the popup. autoApprove just closed the popup —
      // reopen it before reaching into chrome.storage. (chrome.storage
      // isn't reachable from page contexts; the popup runs in the
      // extension origin.)
      await ensurePopup();
      await popup.evaluate(async (idHex) => {
        const sess = await chrome.storage.session.get("activeFingerprint");
        const fp = sess.activeFingerprint;
        if (typeof fp !== "number") throw new Error("no active fingerprint");
        const key = `offers.${fp}`;
        const data = await chrome.storage.local.get(key);
        const list = data[key] ?? [];
        list.push({
          id: idHex,
          offer: "offer1fakeoffer",
          created_at: Date.now(),
          origin: "https://victim.example",
          input_xch_coins: [],
        });
        await chrome.storage.local.set({ [key]: list });
      }, fakeOfferIdNo0x);

      // Attacker fires the cancel. We auto-APPROVE to simulate the worst
      // case (a phished user clicks Approve). The defense must catch the
      // attack downstream in the handler.
      const callP = attacker.evaluate(async (oid) => {
        try {
          const res = await window.chia.request({
            method: "cancelOffer",
            params: { id: oid, secure: false },
          });
          return { ok: true, res };
        } catch (e) {
          return { ok: false, code: e?.code, msg: (e?.message ?? "").slice(0, 120) };
        }
      }, fakeOfferIdWith0x);
      await wait(900);
      await autoApprove();
      const r = await callP;

      // Authoritative check: peek into storage and verify the offer's
      // `cancelled` flag is still falsy. autoApprove may have closed
      // the popup again — reopen so we can reach chrome.storage.
      await ensurePopup();
      const cancelledInStorage = await popup.evaluate(async (idHex) => {
        const sess = await chrome.storage.session.get("activeFingerprint");
        const fp = sess.activeFingerprint;
        const key = `offers.${fp}`;
        const data = await chrome.storage.local.get(key);
        const list = (data[key] ?? []);
        const stored = list.find((o) => o.id === idHex);
        return Boolean(stored?.cancelled);
      }, fakeOfferIdNo0x);

      const held = !cancelledInStorage;
      return {
        held,
        detail: held
          ? `victim's offer NOT cancelled by attacker (handler response: ${JSON.stringify(r).slice(0, 120)})`
          : `LEAKED: attacker cancelled victim's offer (storage now shows cancelled:true)`,
      };
    },
  },

  // 16 — walletWatchAsset symbol confusion. A malicious dApp asks the
  // wallet to track an arbitrary asset_id under the symbol "XCH" (the
  // native token's ticker). If the approval popup obscures the assetId
  // or shows only the symbol, the user might think they're enabling
  // tracking of XCH itself and approve.
  //
  // We don't approve; we just read the popup and verify the assetId is
  // shown verbatim alongside the symbol so the user can spot the spoof.
  {
    id: "16",
    name: "walletWatchAsset popup shows assetId verbatim (anti-symbol-spoof)",
    run: async () => {
      const spoofedAssetId =
        "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
      const callP = victim.evaluate(
        async (aid) => {
          try {
            await window.chia.request({
              method: "walletWatchAsset",
              params: { type: "CAT", options: { assetId: aid, symbol: "XCH" } },
            });
            return { ok: true };
          } catch (e) {
            return { ok: false, code: e?.code, msg: (e?.message ?? "").slice(0, 100) };
          }
        },
        spoofedAssetId,
      );
      // Wait for the popup to render the approval screen, then read
      // every <code> element on the page. Reading specific locators is
      // resilient against innerText quirks (display:none + React
      // suspense + popup tab not in focus) that empty out body().
      let popupText = "";
      for (let i = 0; i < 25; i += 1) {
        try {
          const codes = await popup.locator("code").allInnerTexts();
          if (codes.length > 0) popupText = codes.join(" | ");
          if (popupText.includes(spoofedAssetId.slice(2))) break;
        } catch {}
        await wait(400);
      }
      await autoReject();
      await callP;
      // Must contain BOTH the assetId (so user sees the actual identity)
      // AND the claimed symbol (so user can spot the lie).
      const showsAssetId = popupText.includes(spoofedAssetId) ||
        popupText.includes(spoofedAssetId.slice(2));
      const showsSymbol = popupText.includes("XCH");
      const held = showsAssetId && showsSymbol;
      return {
        held,
        detail: held
          ? `popup shows assetId + symbol; user can detect mismatch`
          : `assetId=${showsAssetId} symbol=${showsSymbol} body="${popupText.replace(/\s+/g, " ").slice(0, 200)}"`,
      };
    },
  },

  // 17 — Blind-signing defense for signCoinSpends.
  //
  // Before Fase 3, the popup showed `signCoinSpends` only as "N coin
  // spends" — no recipients, no amounts. A malicious bundle could move
  // arbitrary value past an inattentive user. The popup must now decode
  // the bundle via `analyze_coin_spends` and show either:
  //   • a `CoinSpendBreakdown` listing recipients + amounts, OR
  //   • a clear "could not decode" warning when the bundle is malformed.
  //
  // We send a bundle with a minimal placeholder puzzle so the popup is
  // forced through the breakdown render path. Defense holds if the body
  // contains decode-related text (decoded breakdown or graceful error),
  // and fails if it only shows the old blind count.
  {
    id: "17",
    name: "signCoinSpends popup shows decoded breakdown (anti-blind-sign)",
    run: async () => {
      // Resilience: earlier tests can leave the victim tab in a
      // detached state. Recreate it on demand.
      if (victim.isClosed?.()) {
        victim = await ctx.newPage();
        await victim.goto("https://victim.example/", { waitUntil: "domcontentloaded" });
        await wait(500);
      }

      // ── Build a REAL coin_spend via the sage WASM engine ────────────
      //
      // We call send_xch(broadcast:false) against an unspent coin in the
      // wallet, targeting an address derived FAR outside the popup's
      // 200-address analysis window (derivation 9999). That address is
      // technically still ours on chain but lives outside the owner_set
      // the analyzer builds, so the CREATE_COIN to it is classified as
      // "external" — exactly the spoof a malicious dApp would attempt
      // to hide a real value leak.
      //
      // If the wallet has no synced coins yet, fall back to a hand-
      // crafted CLVM hex that exercises the "unknown layer" path. The
      // defense holds either way; the real-bundle path is the gold
      // standard validation.
      const prep = await popup.evaluate(async () => {
        const sess = await chrome.storage.session.get("activeFingerprint");
        const fp = sess.activeFingerprint;
        if (typeof fp !== "number") return { error: "no active fingerprint" };
        const local = await chrome.storage.local.get("wallets");
        const masterPk = local.wallets?.[fp.toString()]?.masterPublicKey;
        if (!masterPk) return { error: "no master_public_key" };

        // 1. Pick the first unspent XCH coin.
        const csResp = await chrome.runtime.sendMessage({
          from: "popup",
          kind: "get-coin-store",
          fingerprint: fp,
        });
        if (!csResp.ok) return { error: "coin-store: " + csResp.error.message };
        const coins = Object.values(csResp.value.coins ?? {});
        const unspent = coins.find((c) => !c.spent);
        if (!unspent) return { error: "no unspent coins (wallet needs sync)" };

        // 2. Derive 200 addresses to find this coin's derivation index.
        const derResp = await chrome.runtime.sendMessage({
          from: "popup",
          kind: "engine",
          method: "derive_addresses",
          params: { master_public_key: masterPk, start: 0, count: 200, testnet: false },
        });
        if (!derResp.ok) return { error: "derive: " + derResp.error.message };
        const addrs = derResp.value.addresses;
        const coinIdx = addrs.findIndex((a) => a.puzzle_hash === unspent.puzzle_hash);
        if (coinIdx < 0) {
          return { error: `coin ph ${unspent.puzzle_hash} not in first 200 derivations` };
        }

        // 3. Derive an address WELL outside the analysis window (9999)
        //    so it's flagged "external" by analyze_coin_spends.
        const extResp = await chrome.runtime.sendMessage({
          from: "popup",
          kind: "engine",
          method: "derive_addresses",
          params: { master_public_key: masterPk, start: 9999, count: 1, testnet: false },
        });
        if (!extResp.ok) return { error: "derive ext: " + extResp.error.message };
        const target = extResp.value.addresses[0];

        // 4. Build a real signed bundle. broadcast:false → no on-chain
        //    side-effect; we only want the coin_spends to feed signCoinSpends.
        const sendResp = await chrome.runtime.sendMessage({
          from: "popup",
          kind: "engine",
          method: "send_xch",
          params: {
            fingerprint: fp,
            recipient_address: target.address,
            amount_mojos: "1",
            fee_mojos: "0",
            input_coins: [
              {
                parent_coin_info: unspent.parent_coin_info,
                puzzle_hash: unspent.puzzle_hash,
                amount: unspent.amount,
                derivation_index: coinIdx,
              },
            ],
            change_index: coinIdx,
            broadcast: false,
          },
        });
        if (!sendResp.ok) return { error: "send_xch: " + sendResp.error.message };

        return {
          coinSpends: sendResp.value.spend_bundle.coin_spends,
          targetPuzzleHash: target.puzzle_hash,
          targetAddress: target.address,
          inputAmount: unspent.amount,
        };
      });

      let coinSpends;
      let expectedRecipient;
      let mode;
      if (prep.error) {
        mode = "fallback-hand-crafted";
        // Hand-crafted (q . ((51 0xaa..aa 1000 ())))
        coinSpends = [
          {
            coin: {
              parent_coin_info: "0x" + "11".repeat(32),
              puzzle_hash: "0x" + "22".repeat(32),
              amount: 1000,
            },
            puzzle_reveal: "0xff01ffff33ffa0" + "aa".repeat(32) + "ff8203e8ff8080",
            solution: "0x80",
          },
        ];
        expectedRecipient = "0x" + "aa".repeat(32);
        log(`   note: using hand-crafted fallback (${prep.error})`);
      } else {
        mode = "real-bundle";
        coinSpends = prep.coinSpends;
        expectedRecipient = prep.targetPuzzleHash;
        log(`   built real bundle: ${coinSpends.length} spend(s), recipient=${expectedRecipient.slice(0, 18)}…`);
      }

      const callP = victim.evaluate(
        async (cs) => {
          try {
            await window.chia.request({
              method: "signCoinSpends",
              params: { coinSpends: cs, partialSign: false },
            });
            return { ok: true };
          } catch (e) {
            return { ok: false, code: e?.code, msg: (e?.message ?? "").slice(0, 120) };
          }
        },
        coinSpends,
      );

      // Verify (a) the Approve button is DISABLED while the breakdown
      // loads (the user must not be able to sign without seeing the
      // decoded summary) and (b) once loaded, the breakdown shows the
      // expected recipient. The popup renders the puzzle_hash as a
      // truncated `0xPREFIX…SUFFIX` so we match on the first 10 chars
      // (the "0x" + 8 hex chars before the ellipsis).
      let popupText = "";
      let approveDisabledWhileLoading = false;
      const recipientHex = expectedRecipient.startsWith("0x")
        ? expectedRecipient.slice(2)
        : expectedRecipient;
      const recipientPrefix = ("0x" + recipientHex.slice(0, 8)).toLowerCase();
      const recipientSuffix = recipientHex.slice(-6).toLowerCase();
      // Case-insensitive match because css text-transform on parent
      // elements can uppercase the popup body's innerText readback even
      // when the underlying DOM is lowercase. The popup is the source
      // of truth — what the user sees on screen is correctly cased — but
      // for substring matching we normalise both sides.
      const bodyMatches = (txt) => {
        const lower = txt.toLowerCase();
        return lower.includes(recipientPrefix) && lower.includes(recipientSuffix);
      };
      for (let i = 0; i < 50; i += 1) {
        try {
          const body = await popup.locator("body").innerText().catch(() => "");
          if (body.length > 0) popupText = body;
          if (/Decoding \d+ spend/i.test(popupText) && !approveDisabledWhileLoading) {
            const approveDisabled = await popup
              .locator("button", { hasText: /^(Approve|Decoding…)$/ })
              .first()
              .isDisabled()
              .catch(() => false);
            if (approveDisabled) approveDisabledWhileLoading = true;
          }
          // Breakdown is ready once the truncated puzzle_hash (or the
          // "going out" header in fallback mode) shows up.
          if (bodyMatches(popupText)) {
            break;
          }
          if (mode === "fallback-hand-crafted" && /Could not decode|unknown layer/i.test(popupText)) {
            break;
          }
        } catch {}
        await wait(400);
      }
      await autoReject();
      await callP;

      let held;
      let detail;
      if (mode === "real-bundle") {
        // Two assertions must hold:
        //   • Approve was disabled while the breakdown was loading
        //     (prevents blind-signing during decode).
        //   • The decoded body shows the actual external recipient
        //     (matched via the popup's truncation: 0xXXXXXXXX…YYYYYY).
        const recipientShown = bodyMatches(popupText);
        held = recipientShown && approveDisabledWhileLoading;
        detail = held
          ? `Approve gated during decode + popup shows recipient ${recipientPrefix}…${recipientSuffix}`
          : `LEAKED: recipientShown=${recipientShown} approveGated=${approveDisabledWhileLoading} body=${popupText.replace(/\s+/g, " ").slice(0, 240)}`;
      } else {
        const showsBreakdown =
          /Going OUT|Returning to your wallet|unknown layer|Could not decode/i.test(
            popupText,
          );
        const onlyShowsCount =
          /asks the wallet to sign \d+ coin spend/i.test(popupText) &&
          !showsBreakdown;
        held = showsBreakdown && !onlyShowsCount;
        detail = held
          ? `popup renders CoinSpendBreakdown (fallback path)`
          : `LEAKED: popup body lacks decoded breakdown. Body: ${popupText.replace(/\s+/g, " ").slice(0, 260)}`;
      }
      return { held, detail };
    },
  },

  // 12 — Attempt to read chrome.storage / extension state from page.
  {
    id: "12",
    name: "page reads chrome.storage / chrome.* APIs",
    run: async () => {
      const r = await attacker.evaluate(async () => {
        const probes = {};
        probes.chromeStorage = typeof globalThis.chrome?.storage;
        probes.chromeTabs = typeof globalThis.chrome?.tabs;
        probes.chromeMgmt = typeof globalThis.chrome?.management;
        // Try to actually read. Optional chaining swallows missing APIs into
        // `undefined`, so we MUST distinguish "got a value back" from "API
        // was absent so the chain short-circuited" — only the former is a
        // real data leak.
        try {
          const v = await globalThis.chrome?.storage?.local?.get?.("wallets");
          probes.walletsRead = { ok: v !== undefined, v };
        } catch (e) {
          probes.walletsRead = { ok: false, msg: e?.message };
        }
        return probes;
      });
      // chrome.storage must NOT be readable from a regular page. Any value
      // other than "undefined" for these APIs means the page got more reach
      // than it should.
      const held =
        r.chromeStorage === "undefined" &&
        r.chromeTabs === "undefined" &&
        r.chromeMgmt === "undefined" &&
        r.walletsRead.ok !== true;
      return {
        held,
        detail: held
          ? `chrome.storage / tabs / management all undefined from page`
          : `LEAKED: ${JSON.stringify(r).slice(0, 240)}`,
      };
    },
  },

  // 18 — Goby-compat OFF: the Advanced toggle must hide window.chia (so real
  // Goby is free to claim it) WITHOUT blocking chia_* / chip0002_* method
  // names through window.loroco — those aliases are baseline Loroco surface
  // and remain reachable regardless of the setting. The defense being asserted
  // is "the setting only governs the window slot, not the method map". We
  // probe from the *victim* page (already connected) so the alias actually
  // dispatches into the handler instead of being rejected by the connection
  // gate. Last attack in the suite so we can leave legacyGoby=true on exit
  // without affecting any later case.
  {
    id: "18",
    name: "legacyGoby=false hides window.chia but keeps chia_*/chip0002_* via window.loroco",
    run: async () => {
      // Flip via chrome.storage from the popup's extension context. Popup
      // pages have direct chrome.storage.local access — no popup-rpc needed.
      await popup.evaluate(() =>
        chrome.storage.local.set({ "settings.compat": { legacyGoby: false } }),
      );
      await victim.reload({ waitUntil: "domcontentloaded" });
      await wait(600);

      const probe = await victim.evaluate(async () => {
        const hasChia = typeof window.chia !== "undefined";
        const hasLoroco = typeof window.loroco !== "undefined";
        const lorocoIsObj = typeof window.loroco?.request === "function";
        // Probe chainId via legacy namespaces — should succeed (returns
        // "mainnet") because the alias table is universal AND victim is
        // a pre-connected origin so ensurePermissions lets the call through.
        const chiaChainId = await window.loroco
          ?.request({ method: "chia_chainId" })
          .then((r) => ({ ok: true, result: r }))
          .catch((e) => ({ ok: false, code: e?.code, msg: e?.message }));
        const chip0002ChainId = await window.loroco
          ?.request({ method: "chip0002_chainId" })
          .then((r) => ({ ok: true, result: r }))
          .catch((e) => ({ ok: false, code: e?.code, msg: e?.message }));
        return { hasChia, hasLoroco, lorocoIsObj, chiaChainId, chip0002ChainId };
      });

      // Restore so later runs (or a re-used test profile) aren't poisoned.
      await popup.evaluate(() =>
        chrome.storage.local.set({ "settings.compat": { legacyGoby: true } }),
      );

      const held =
        probe.hasChia === false &&
        probe.hasLoroco === true &&
        probe.lorocoIsObj === true &&
        probe.chiaChainId?.ok === true &&
        probe.chiaChainId?.result === "mainnet" &&
        probe.chip0002ChainId?.ok === true &&
        probe.chip0002ChainId?.result === "mainnet";
      return {
        held,
        detail: held
          ? `window.chia hidden; chia_chainId & chip0002_chainId both → "mainnet" via window.loroco`
          : `LEAKED: ${JSON.stringify(probe).slice(0, 320)}`,
      };
    },
  },
];

// ── Runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const findings = [];

async function ensureAttacker() {
  if (attacker && !attacker.isClosed()) return attacker;
  attacker = await ctx.newPage();
  await attacker.goto("https://attacker.example/", { waitUntil: "domcontentloaded" });
  await wait(400);
  return attacker;
}

async function ensureVictim() {
  if (victim && !victim.isClosed()) return victim;
  victim = await ctx.newPage();
  await victim.goto("https://victim.example/", { waitUntil: "domcontentloaded" });
  await wait(400);
  return victim;
}

for (const atk of ATTACKS) {
  log(`=== ATTACK ${atk.id}: ${atk.name} ===`);
  try {
    // Many attacks close the popup via autoApprove/autoReject, and some
    // earlier attack can leave attacker/victim tabs detached. Reopen
    // anything that's closed before running the next so attacks don't
    // crash with "Target page closed".
    await ensurePopup();
    await ensureAttacker();
    await ensureVictim();
    const { held, detail } = await atk.run();
    if (held) {
      log(`   ✓ DEFENSE HELD — ${detail}`);
      passed += 1;
    } else {
      log(`   ✗ DEFENSE FAILED — ${detail}`);
      failed += 1;
      findings.push({ id: atk.id, name: atk.name, detail });
    }
  } catch (e) {
    log(`   ! ERROR running attack: ${e?.message ?? e}`);
    failed += 1;
    findings.push({ id: atk.id, name: atk.name, detail: `runner error: ${e?.message}` });
  }
  await wait(400);
}

log("");
log(`=== SECURITY AUDIT SUMMARY ===`);
log(`passed (defense held): ${passed}/${ATTACKS.length}`);
if (failed > 0) {
  log(`FAILED (real findings):`);
  for (const f of findings) {
    log(`  - [${f.id}] ${f.name}`);
    log(`        ${f.detail}`);
  }
  await ctx.close();
  process.exit(1);
}
log(`✓ all attacks blocked — defense surface is intact`);
await ctx.close();
process.exit(0);
