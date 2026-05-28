import { defineConfig } from "wxt";
import pkg from "./package.json" with { type: "json" };

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
