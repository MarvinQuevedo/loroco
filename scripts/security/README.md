# Loroco security audit (adversarial dApp suite)

Playwright-driven suite that loads the Loroco extension and runs a **hostile
dApp** through 12 attack vectors. Each case verifies a concrete defense in
the page → content → background pipeline.

## How to run

```bash
# 1. Build the extension (Rust changes also need pnpm wasm:build).
pnpm --filter @ozone/extension build

# 2. Start fresh — the suite uses /tmp/Loroco-PW-Security so it doesn't
#    contaminate the regular /tmp/Loroco-PW-Shared profile.
rm -rf /tmp/Loroco-PW-Security

# 3. Run.
node scripts/security/pw-security-audit.mjs
```

The suite imports a wallet with the same fixed mnemonic the other `pw-*`
scripts use, then probes the attacker dApp from a fake origin
`https://attacker.example/` (served via Playwright `route()`).

Output is a pass/fail line per attack. The script exits **0 only if all
attacks were blocked** (i.e. the defense held). Any case where the attack
**succeeded** (data leaked, tx accepted without approval, etc.) is a real
finding — the script exits with code 1 and prints what got through.

## Attack matrix

| # | Vector | Defense expected | What it tests |
|---|--------|------------------|---------------|
| 01 | Unconnected origin → read method | `4001` unauthorized before any work | `requireConnected` / `ensurePermissions` |
| 02 | Unconnected origin → mutating method | `4001` BEFORE approval popup | No approval popup on unauthorised origin |
| 03 | Spoofed `origin` in page → content message | Background uses `sender.origin` (Chrome-supplied), spoof ignored | background.ts:100 — `sender.origin ?? msg.origin` |
| 04 | postMessage from `iframe` w/ `target: CONTENT_TARGET` | Content bridge ignores (ev.source !== window) | content-bridge.ts:25 |
| 05 | `chrome.runtime` from MAIN world | `chrome` undefined in page context | Content script isolation |
| 06 | Read sensitive state from `window.chia` | No mnemonic / master_sk / private fields exposed | inpage.ts API surface |
| 07 | Race: 5 parallel `signMessage` calls | All wait for popup; none bypass | Approval serialisation |
| 08 | Overwrite `window.chia` with a fake | `Object.defineProperty(...writable:false)` blocks | inpage.ts:227 |
| 09 | Pretend to be the approval popup (send `{from:"approval", kind:"decide"}`) | Background only accepts from extension contexts | chrome.runtime.sendMessage from a regular page can't fake an extension origin |
| 10 | Replay a stale request id | `pending.get(id)` returns undefined for unknown id | inpage.ts:54 |
| 11 | Massive payload (10MB string) in signMessage | Cap at 4 MiB in content-bridge + SW (`4029` LimitExceeded), no SW death | content-bridge.ts size cap + background.ts mirror |
| 12 | Read `chrome.storage.local` keys (permissions, wallets, mnemonic) from page | `chrome.storage` not available to MAIN world | Extension isolation |
| 13 | Lookalike subdomain (`victim.example.evil.com`) | Treated as evil.com's subdomain, separate permission record | Chrome origin model + `permissions` keyed by full origin |
| 14 | `chia_send` with `address` only (no `to`) | Approval popup shows recipient verbatim | popup ApprovalSummary normalizes `to ?? address` |
| 15 | Attacker origin tries to cancel victim's offer | Handler filters offers by `origin` stamp | rpc-router cancelOffer + offer.origin stamped at create |
| 16 | `walletWatchAsset` with spoofed symbol (claims "XCH" for arbitrary assetId) | Popup shows assetId verbatim so user can spot the lie | popup ApprovalSummary for walletWatchAsset |
| 17 | `signCoinSpends` blind-sign — bundle of N opaque coin spends | Popup renders `CoinSpendBreakdown` (decoded recipients + amounts, or graceful "could not decode") instead of just "N coin spends" | WASM `analyze_coin_spends` + popup `CoinSpendBreakdown` component |

## Reading the output

```
[sec] === ATTACK 01: unconnected read ===
[sec]    ✓ DEFENSE HELD — got code=4001 "https://attacker.example is not connected"
[sec] === ATTACK 09: spoof approval message ===
[sec]    ✗ DEFENSE FAILED — approval was accepted from page context
```

A `✓ DEFENSE HELD` line means the attack was blocked as expected.
A `✗ DEFENSE FAILED` is a real security finding that needs investigation.

## Adding new attacks

Each attack is a function in `pw-security-audit.mjs` registered in the
`ATTACKS` array. The shape:

```js
{
  id: "13",
  name: "describe the attack",
  run: async ({ attacker, popup, ctx, sw, victim }) => {
    // Drive the page / iframes / SW probe.
    const out = await attacker.evaluate(...);
    return {
      held: <bool>,                  // true = defense held, false = attack succeeded
      detail: "..."                  // human description for the log line
    };
  }
}
```

Keep attacks independent — the suite runs them sequentially against a
single persistent context, but no case should rely on state from a
previous case.
