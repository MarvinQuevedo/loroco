import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  srcDir: ".",
  outDir: ".output",
  manifest: {
    name: "Loroco",
    description: "Chia wallet — Goby-compatible, coinset.org-synced.",
    version: "0.0.1",
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
  },
});
