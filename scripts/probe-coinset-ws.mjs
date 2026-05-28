// Probe coinset.org's WS subscribe protocol. Tries several candidate
// shapes, listens for any reaction (new event types, error responses,
// transaction events). Run with: node scripts/probe-coinset-ws.mjs

const URL = "wss://api.coinset.org/ws";

// Each probe is sent in sequence — wait 8s between to give the server
// time to emit reactions. Stop on first that produces a transaction
// event or an obvious error/ack response.
const PROBES = [
  null, // baseline: just listen, no subscribe
  { type: "subscribe", data: { events: ["transaction"] } },
  { action: "subscribe", events: ["transaction"] },
  { op: "subscribe", channel: "transactions" },
  { subscribe: ["transaction", "mempool"] },
  { method: "subscribe", params: { events: ["transaction"] } },
  { type: "subscribe", data: { puzzle_hashes: [] } }, // empty wildcard?
  { type: "subscribe", data: { coin_ids: [] } },
  { command: "register_for_transactions" },
  // Chia daemon style:
  {
    command: "register",
    ack: false,
    origin: "loroco-probe",
    destination: "metrics",
    request_id: "1",
    data: { service: "transactions" },
  },
];

const ws = new WebSocket(URL);
const seenEventTypes = new Map();
const messages = [];
let lastSeq = 0;

ws.addEventListener("open", () => {
  console.log("▸ open");
  runProbes();
});

ws.addEventListener("message", (ev) => {
  const raw = typeof ev.data === "string" ? ev.data : "";
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return; }
  const type = parsed?.message?.type ?? parsed?.type ?? "<no-type>";
  seenEventTypes.set(type, (seenEventTypes.get(type) ?? 0) + 1);
  const seq = parsed?.seq ?? null;
  if (seq != null) lastSeq = seq;
  messages.push({ ts: Date.now(), type, seq, raw: raw.slice(0, 200) });
  if (type !== "peak") {
    console.log(`  [msg ${seq ?? "?"}] type=${type} raw=${raw.slice(0, 250)}`);
  }
});

ws.addEventListener("error", (e) => {
  console.error("✗ error:", e.message ?? String(e));
});

ws.addEventListener("close", (e) => {
  console.log(`▸ close ${e.code} ${e.reason || ""}`);
  printSummary();
  process.exit(0);
});

async function runProbes() {
  console.log("▸ baseline: 8s passive listen");
  await sleep(8000);
  for (const probe of PROBES.slice(1)) {
    const json = JSON.stringify(probe);
    console.log(`▸ sending: ${json}`);
    try {
      ws.send(json);
    } catch (e) {
      console.error("  send failed:", e.message);
    }
    await sleep(7000);
    if (seenEventTypes.get("transaction") > 0) {
      console.log("✓ transaction events detected — this probe worked!");
      break;
    }
  }
  printSummary();
  ws.close();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function printSummary() {
  console.log("\n=== Summary ===");
  console.log("eventTypes:", Object.fromEntries(seenEventTypes));
  console.log("totalMessages:", messages.length);
  console.log("lastSeq:", lastSeq);
}

// Cap total runtime as a safety net.
setTimeout(() => {
  console.log("⏱ time cap, closing");
  ws.close();
}, 120000);
