import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { defineConfig } from "wxt";
import pkg from "./package.json" with { type: "json" };

// Absolute path to the engine WASM emitted by `pnpm wasm:build`.
const ENGINE_WASM = fileURLToPath(
  new URL("../wallet-wasm/sage_wasm_bg.wasm", import.meta.url),
);

// Per-browser manifest fragments. Anything inside `firefoxOnly` ends up only
// in firefox builds; chrome-mv3 stays untouched. WXT calls the `manifest`
// function with the active build target so we can branch cleanly.
const firefoxOnly = {
  browser_specific_settings: {
    gecko: {
      id: "loroco@ozone.dev",
      // 128.0 is the floor we actually run on: needed for chrome.action.openPopup
      // (Firefox 127+) and modern chrome.storage.session quirks. AMO's
      // data_collection_permissions field only takes effect on 140+, but Firefox
      // <140 ignores unknown manifest keys silently.
      strict_min_version: "128.0",
      // Mandatory for new AMO submissions from Nov 2025. Loroco doesn't
      // collect telemetry — declare "none" to silence the lint and reflect
      // the truth.
      data_collection_permissions: { required: ["none"] },
    },
  },
} as const;

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  srcDir: ".",
  outDir: ".output",
  // Silence WXT's AMO-data-collection warning (we declare `none` above).
  suppressWarnings: { firefoxDataCollection: true },
  // Ship the engine WASM at the extension ROOT. The service worker loads it
  // via `new URL("sage_wasm_bg.wasm", self.location.href)`; WXT rewrites
  // wasm-pack's `import.meta.url` → `self.location.href`, which defeats Vite's
  // automatic asset emission — so without this the .wasm is never copied and
  // the SW's init() fetch 404s ("Failed to fetch" on every wallet action).
  // Registering it as a public file makes WXT copy it on build AND zip.
  hooks: {
    "build:publicAssets": (_wxt, files) => {
      if (!existsSync(ENGINE_WASM)) {
        throw new Error(
          `[loroco] engine WASM not found at ${ENGINE_WASM} — run \`pnpm wasm:build\` first.`,
        );
      }
      // Guard against double-registration if Vite ever starts emitting it.
      if (!files.some((f) => f.relativeDest === "sage_wasm_bg.wasm")) {
        files.push({ absoluteSrc: ENGINE_WASM, relativeDest: "sage_wasm_bg.wasm" });
      }
    },
  },
  manifest: ({ browser }) => ({
    name: "Loroco",
    description:
      "Chia wallet for your browser. Send XCH, hold tokens and NFTs, trade with offers, and connect to Chia sites safely.",
    // Single source of truth — `scripts/bump-version.mjs` bumps the patch
    // segment in package.json before each build:fast / build.
    version: pkg.version,
    manifest_version: 3,
    permissions: ["storage", "alarms", "tabs"],
    host_permissions: [
      "https://api.coinset.org/*",
      "https://kraken.fireacademy.io/*",
      "https://api.dexie.space/*",
      "https://icons.dexie.space/*",
      "https://api.coingecko.com/*",
      "https://*.mintgarden.io/*",
      "https://ipfs.io/*",
      "https://*.ipfs.dweb.link/*",
      // Optional local peer-sync sidecar (ozone-sidecar). Plain HTTP is
      // OK because localhost is a "secure context" per W3C; the browser
      // does not require TLS for 127.0.0.1.
      "http://127.0.0.1/*",
    ],
    action: {
      default_title: "Loroco",
      default_popup: "popup.html",
      default_icon: {
        16: "icon/16.png",
        32: "icon/32.png",
        48: "icon/48.png",
        128: "icon/128.png",
      },
    },
    icons: {
      16: "icon/16.png",
      32: "icon/32.png",
      48: "icon/48.png",
      96: "icon/96.png",
      128: "icon/128.png",
    },
    background: {
      service_worker: "background.js",
      type: "module",
    },
    web_accessible_resources: [
      {
        resources: ["inpage.js"],
        matches: ["<all_urls>"],
      },
    ],
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
    ...(browser === "firefox" ? firefoxOnly : {}),
  }),
});
