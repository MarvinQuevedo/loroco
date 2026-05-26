// MAIN-world inpage script. WXT bundles this and exposes it as inpage.js
// (declared in web_accessible_resources in wxt.config.ts). The content script
// injects it into the page so window.chia becomes available to dApps.

import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";

export default defineUnlistedScript(() => {
  // Side-effect import: registers window.chia / window.ozone on load.
  void import("@ozone/goby-provider/inpage");
});
