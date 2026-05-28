# CLAUDE.md — Loroco

Repo-level guidance for Claude Code sessions. Read top-to-bottom before
touching any handler, popup, content bridge, or storage code.

## What this codebase is

Loroco is a **Chia browser-extension wallet** (MV3) that exposes a
Goby-compatible `window.chia` provider and the Sage WalletConnect2 method
surface. The wallet's signing key is held in WASM (sage-wasm engine); the
extension's JS shell is the only thing dApps talk to.

The components a hostile dApp can reach, in order of trust:

1. **MAIN-world page script** (the dApp itself + `inpage.js`)
2. **ISOLATED-world content script** (`content.ts` + `content-bridge.ts`)
3. **Service worker / background** (`background.ts` + `src/background/*`)
4. **WASM engine** (`vendor/sage/crates/sage-wasm`)

Each step strips capabilities. **A dApp page can only reach layer 4 via a
correctly-shaped path through every prior layer's gate.** Most security
bugs come from a layer doing something a higher layer assumed it didn't.

## Security model — what's guaranteed

These invariants must hold; if a change breaks one of them, it is a
security regression even if the test suite passes.

- **Origin authenticity**: the origin a handler receives is the page's
  real origin, never something the page chose. Use `sender.origin` (set
  by Chrome) — fall back to `msg.origin` ONLY as a last resort for
  same-extension senders.
- **No path from page → SW without bridge**: `chrome.runtime.sendMessage`
  is not exposed to MAIN world. Pages can only reach the SW via
  `window.postMessage → content-bridge → runtime.sendMessage`. Don't
  add `externally_connectable` to manifest without a strong reason.
- **Connect is the only entry**: every non-`connect` method requires a
  prior connection grant (`requireConnected` + `ensurePermissions`).
  A new method goes into `NO_APPROVAL_METHODS` (read-only) or
  `ALWAYS_APPROVAL_METHODS` (mutating); never bypass that gate.
- **Approval is per-call, not per-session**: the user re-approves every
  mutating call. Don't add a "remember this site" shortcut without a
  scoped-method allowlist (today `methods: ["*"]` is the only mode and
  granting at connect time covers reads only).
- **Popup is authoritative on display**: whatever the popup renders is
  what the user is consenting to. If the handler normalises params
  (`to ?? address`, `secure ?? true`), the popup MUST normalise the
  same way. Otherwise the dApp can spoof what the user sees.
- **Per-origin isolation in shared storage**: any per-fingerprint store
  shared across dApps (`offers.<fp>`, `watched_assets.<fp>`) must stamp
  the creating `origin` and filter by it in any mutating handler.
  Without that, dApp A can drive state for dApp B.
- **WASM holds the SK; JS sees public material only**: never persist
  the master secret key or mnemonic in `chrome.storage.*` plaintext.
  The engine's `unlocked` Map is in WASM memory; `chrome.storage.session`
  holds the encrypted keychain blob plus the unlock password is supplied
  by the user each browser session.

## Anti-patterns — concrete bugs we've already hit

When you write a new handler, popup screen, or message-passing layer,
audit it against this list. These are real findings from the audit
suite, not hypotheticals.

### 1. Handler accepts an alias the popup doesn't show

**Example**: `transfer` handler does `p?.to ?? p?.address`. The popup
showed `params.to` only. dApp sending `{address: "evil"}` made the popup
display `to:` blank while the handler still spent to `evil`.

**Rule**: if a handler does `x ?? y`, the popup does the same. Or, pull
the normalisation up into the handler so by the time the request reaches
`requestApproval` the canonical field is already set.

### 2. Per-fingerprint storage shared across origins

**Example**: `offers.<fp>` listed every offer the wallet created. Any
connected origin could call `cancelOffer(id)` on another origin's offer
— and with `secure: true`, drain the maker coin back to the wallet.

**Rule**: anything you write to `chrome.storage.local["<scope>.<fp>"]`
that records a dApp action must include `origin`. Every read/mutate
handler filters by `sender.origin` (the value the SW received, not what
the page claimed).

### 3. Unbounded payload reaches `chrome.runtime.sendMessage`

**Example**: a 10 MiB string in `signMessage` caused Chrome to invalidate
the whole extension context — silent DoS, any unconnected page can do it.

**Rule**: enforce a size cap in `content-bridge.ts` BEFORE forwarding,
and mirror it in `background.ts` as defense-in-depth. Cap is currently
4 MiB; surfaces as `4029` (LimitExceeded).

### 4. Trusting `msg.origin` over `sender.origin`

**Example**: a forged `origin: "https://victim.example"` in a page
postMessage could authenticate as victim if the SW trusts it.

**Rule**: `const origin = sender.origin ?? msg.origin;` — `sender.origin`
comes from Chrome's process boundary and can't be forged by a page.
The fallback exists only for extension-internal senders that legitimately
omit it. Never invert that order.

### 5. Iframe postMessage to parent processed by parent's bridge

**Example**: an iframe doing `parent.postMessage({target:"loroco-content",...})`
could trick the parent's content bridge into forwarding as if it came
from the parent itself.

**Rule**: `content-bridge.ts` checks `if (ev.source !== window) return`
on the parent listener. Don't remove that check. Never add a content
script `all_frames: true` without re-auditing this defense.

### 6. Approval popup blind-signs opaque blobs

**Current weak spot, not yet fixed**: `signCoinSpends` and `sendTransaction`
show the user "N coin spends" but no detail. A dApp can pass a bundle
that does anything; the user has no way to inspect it before approving.

**Rule for new handlers**: if you take a structured payload (CoinSpends,
SpendBundle), the popup MUST decode and summarise what the bundle does —
recipients, amounts, fees, asset ids. Bare counts are not consent.

### 7. Method aliases bypassing gating

**Example shape**: someone adds `chia_unsafeDoThing → doThing` to
`METHOD_ALIASES` and forgets to wire `doThing` into `ALWAYS_APPROVAL_METHODS`.
Now the alias bypasses the popup that the canonical name would have triggered.

**Rule**: aliases in `METHOD_ALIASES` map to a canonical that MUST be
present in `NO_APPROVAL_METHODS` or `ALWAYS_APPROVAL_METHODS`. The
canonicalisation runs before gating in `background.ts:114`, so adding
an alias for an existing canonical inherits its approval requirements;
adding a new canonical without registering its approval class makes it
silently mutating-without-approval.

### 8. `window.chia` properties writable

**Example**: a dApp can do `window.chia = fakeProvider` and a later
script on the same page sees the fake. Inpage uses
`Object.defineProperty(..., writable:false, configurable:false)` to
prevent this. Don't relax those flags.

## Conventions when extending the wallet

### Adding a new RPC method

1. Add to `ChiaMethodMap` in `packages/goby-provider/src/types.ts` with
   exact params/result types.
2. Add the canonical name to either `NO_APPROVAL_METHODS` (read-only) or
   `ALWAYS_APPROVAL_METHODS` (mutating/signing) in `permissions.ts`.
3. Add aliases to `METHOD_ALIASES` in `rpc-router.ts` for every
   chia_*/chip0002_*/snake_case form dApps in the wild send.
4. Implement the handler. If params have aliased fields (e.g. WC2's
   `address` vs Goby's `to`), normalise IMMEDIATELY at handler entry —
   don't sprinkle `x ?? y` through the handler.
5. If mutating: add a case to `ApprovalSummary` in `popup/App.tsx`
   showing every field the handler will act on. Test by reading the
   popup's body text in a script and asserting the recipient, amount,
   fee, asset id are all visible verbatim.
6. Update `scripts/pw-wc-coverage.mjs` with a happy-path assertion and
   `scripts/security/pw-security-audit.mjs` with at least one attack
   case if the method writes state.

### Persisting state cross-origin

If the data is per-wallet AND surfaced to multiple dApps:

- Always include `origin` on each record.
- Every mutating read/write handler accepts `(origin, params)` (not
  `_origin`) and filters by it.
- Legacy records without `origin` may stay accessible for compat, but
  document it inline.

### Touching the popup approval screen

The popup is the LAST chance to show the user what they're consenting to.
When you edit `ApprovalSummary`:

- Display every param the handler will act on. Not a count, not a
  summary noun — the actual value.
- If the handler will normalise (`x ?? y`), display the normalised value.
- Don't truncate addresses, asset ids, or recipients in a way that loses
  enough characters to hide a swap. `0x1234…abcd` is fine; `0x12…cd`
  isn't.
- Never embed dApp-controlled HTML. Always `String(...)` and render as
  `<code>` text.

### Adding a content-bridge or message-passing layer

- Verify `ev.source === window` for any window.message listener.
- Verify `data.target === <expected literal>` (don't accept a wildcard).
- Use Chrome-supplied identity (`sender.origin`, `sender.tab`), never
  page-supplied.
- Enforce a payload size cap before forwarding.

## Security audit workflow

The suite lives in `scripts/security/`. Run it whenever you change:

- `entrypoints/background.ts` or `entrypoints/content.ts` or `inpage.ts`
- `packages/goby-provider/src/` (content-bridge, inpage, types)
- `packages/extension/src/background/rpc-router.ts`
- `packages/extension/src/background/permissions.ts`
- `packages/extension/src/background/approval.ts`
- Any `ApprovalSummary` case in `popup/App.tsx`

```bash
pnpm --filter @ozone/extension build       # JS-only changes
# (or `pnpm wasm:build && pnpm --filter @ozone/extension build` for Rust)
rm -rf /tmp/Loroco-PW-Security
node scripts/security/pw-security-audit.mjs
```

Exit 0 = all defenses hold. Exit 1 + per-finding detail otherwise.

**When adding a new attack**: copy the shape of an existing case in
`ATTACKS[]`, give it an id that doesn't clash, write the `run` returning
`{held, detail}`. Each case must be independent (no order dependency).
Document it in `scripts/security/README.md`.

## Known open weak spots

These are real risks not yet covered by defenses. Address before
shipping to a wider audience.

- **Blind signing in `signCoinSpends` / `sendTransaction`**: popup shows
  count of spends but no decoded effect. A malicious dApp can pass a
  bundle that drains the wallet and the user approves "1 coin spend".
- **No per-method permission scopes**: every connection gets
  `methods: ["*"]`. A dApp granted for read access can immediately call
  a signing method (which does pop the approval popup, but no
  "this dApp may never request signing" mode exists).
- **`takeOffer` royalty assertion**: popup shows royalty percentages but
  doesn't verify the on-chain royalty puzzle hash actually receives
  what's claimed. Trust the engine's decode_offer; don't trust the dApp's
  framing of it.
- **No connection auto-expiry**: granted connections live forever until
  the user revokes from Settings → Connected sites. Consider an
  expiry/heartbeat for high-risk methods.
- **No anti-CSRF on the popup ↔ SW channel**: any extension page with
  `chrome.runtime` access can call `decideApproval`. Today only the
  popup uses it; if we ever add an iframe-embedded approval surface,
  add a per-request token check.

## Other useful pointers

- **Test wallet mnemonic** used by all `pw-*` scripts: hard-coded in
  `scripts/pw-wc-coverage.mjs` and friends. It's a fixed throwaway —
  don't reuse for anything real.
- **Persistent test profiles**: `/tmp/Loroco-PW-Shared` (general tests)
  and `/tmp/Loroco-PW-Security` (audit). Rotate `Loroco-PW-Shared` after
  rebuilding WASM (the SW caches the old module otherwise).
- **The auto-memory dir** at
  `~/.claude/projects/-Users-marvin-Projects-Ozone-loroco/memory/`
  captures non-obvious context across sessions; read it before assuming
  patterns from elsewhere.
