// Serialized e2e runner for the Loroco extension.
//
// Every pw-* suite launches its own headed Chrome-for-Testing. Running two at
// once (or leaving a zombie from a previous crash) is the #1 cause of flaky
// "Target closed" failures. This runner fixes that: it kills stale test
// Chromes before each suite, runs ONE suite at a time, and prints a single
// pass/fail roll-up at the end.
//
//   node scripts/pw-run.mjs                 # default set (smoke, security)
//   node scripts/pw-run.mjs smoke           # just the dApp console smoke
//   node scripts/pw-run.mjs smoke security selfsend
//   node scripts/pw-run.mjs all             # every registered suite
//
// `selfsend` needs a funded wallet in .env (MNEMONIC/PASSWORD/USER_DATA) and
// the dApp served at $DAPP_URL (default http://localhost:5174). Suites that
// need the preview server are marked `needsDapp` and the runner checks it's up.

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__here, "..");
const DAPP_URL = process.env.DAPP_URL ?? "http://localhost:5174";

// Registry — id → { script, label, needsDapp }.
const SUITES = {
  smoke: {
    script: "scripts/pw-dapp-smoke.mjs",
    label: "dApp Console smoke (11 pages + signMessage round-trip)",
    needsDapp: true,
  },
  security: {
    script: "scripts/security/pw-security-audit.mjs",
    label: "Security audit (20 attacks)",
    needsDapp: false,
  },
  selfsend: {
    script: "scripts/pw-dapp-selfsend.mjs",
    label: "Real self-send, no fee (full feedback loop)",
    needsDapp: true,
  },
  wc: {
    script: "scripts/pw-wc-coverage.mjs",
    label: "WalletConnect method coverage",
    needsDapp: false,
  },
};

const DEFAULT_SET = ["smoke", "security"];

const args = process.argv.slice(2);
const requested =
  args.length === 0 ? DEFAULT_SET : args.includes("all") ? Object.keys(SUITES) : args;

const unknown = requested.filter((id) => !SUITES[id]);
if (unknown.length) {
  console.error(`Unknown suite(s): ${unknown.join(", ")}`);
  console.error(`Available: ${Object.keys(SUITES).join(", ")}, all`);
  process.exit(2);
}

const log = (...a) => console.log("[run]", ...a);

// Kill any leftover test Chrome + suite process so a crashed prior run can't
// poison this one. Matches the persistent profiles the suites use.
function killStaleChromes() {
  spawnSync("pkill", ["-9", "-f", "Loroco-PW"], { stdio: "ignore" });
  spawnSync("pkill", ["-9", "-f", "pw-security-audit"], { stdio: "ignore" });
  // Give the OS a beat to release the user-data-dir locks.
  spawnSync("sleep", ["2"]);
}

async function dappReachable() {
  try {
    const res = await fetch(DAPP_URL, { method: "HEAD" });
    return res.ok || res.status === 200;
  } catch {
    return false;
  }
}

function runSuite(id) {
  return new Promise((done) => {
    const { script, label } = SUITES[id];
    log(`▶ ${id} — ${label}`);
    const t0 = Date.now();
    const child = spawn("node", [resolve(ROOT, script)], {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => {
      const secs = Math.round((Date.now() - t0) / 1000);
      done({ id, code: code ?? 1, secs });
    });
  });
}

const results = [];
for (const id of requested) {
  if (SUITES[id].needsDapp && !(await dappReachable())) {
    log(`⚠ skip ${id} — dApp not reachable at ${DAPP_URL}`);
    log(`   start it first:  pnpm --filter @ozone/dapp build && (cd apps/dapp && npx vite preview --port 5174 --strictPort &)`);
    results.push({ id, code: 2, secs: 0, skipped: true });
    continue;
  }
  killStaleChromes();
  results.push(await runSuite(id));
}

console.log("\n=== RUN SUMMARY ===");
let anyFail = false;
for (const r of results) {
  const status = r.skipped ? "SKIP" : r.code === 0 ? "PASS" : "FAIL";
  if (status === "FAIL") anyFail = true;
  console.log(`  ${status}  ${r.id.padEnd(10)} ${r.secs}s`);
}
killStaleChromes();
process.exit(anyFail ? 1 : 0);
