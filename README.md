# Loroco

Chia browser extension wallet — Goby-compatible (CHIP-0002), powered by a
WASM-compiled fork of [Sage](https://github.com/xch-dev/sage). Syncs against
`coinset.org` by default; can also talk to a local
[`loroco-local-sync`](https://github.com/MarvinQuevedo/loroco-local-sync)
daemon for P2P peer sync over mTLS.

## Repo shape — read this first

> **Sage source is embedded directly in this repo** under `vendor/sage/`.
> It is **not** a submodule today. This is a temporary choice: it makes the
> dev loop simpler (one `git clone` = everything) while we iterate on the
> Sage fork heavily. Once Sage stabilises and we publish `@loroco/wallet-wasm`
> to a private npm registry, `vendor/sage/` will move out of this repo
> (either as a git submodule pointing at the upstream fork, or removed
> entirely in favour of consuming the published wasm package).
>
> What this means for you today:
> - Commits that touch `vendor/sage/` and commits that touch
>   `packages/extension/` live side-by-side in the same history.
> - When updating Sage from upstream, replace the tree (e.g. `rsync` from a
>   checked-out clone of `MarvinQuevedo/sage`) rather than `git submodule
>   update`.
> - `vendor/chia-wallet-sdk/` IS a normal git submodule — we modify it
>   rarely enough that submodule semantics still work fine.

## Layout

```
loroco/
├── packages/
│   ├── extension/         # WXT app (popup + service worker + content script)
│   ├── goby-provider/     # window.chia injector + CHIP-0002 types
│   ├── storage-idb/       # IndexedDB-backed Storage impl for the WASM module
│   └── wallet-wasm/       # wasm-pack output of crates/sage-wasm (regenerated)
├── vendor/
│   ├── sage/              # EMBEDDED Sage Rust source (see notice above)
│   └── chia-wallet-sdk/   # SUBMODULE — MarvinQuevedo/chia-wallet-sdk @ feat/peer-client-feature
├── scripts/               # Playwright smoke + sync benches
└── .cargo/config.toml     # wasm32-unknown-unknown rustflags
```

## Sage as an engine — not a pile of WASM exports

The Sage Rust library is used **as a single engine instance**, same pattern Ozone uses today through `sage_flutter_binding` (Dart FFI). The JS side only knows:

```ts
const engine = new Sage(idbCallbacks);          // boot the engine
const res = await engine.request(method, jsonParams);  // single dispatch
```

We do **not** ship 110 individual wasm-bindgen exports. We do **not** glue together other JS chia libs (`chia-bls.js`, `clvm-rs.wasm`, `greenweb`, etc.). Everything the wallet needs lives inside the sage engine.

## First-time setup

```bash
git clone --recurse-submodules git@github.com:MarvinQuevedo/loroco.git
cd loroco
pnpm install
```

Already cloned? Pull the chia-wallet-sdk submodule:

```bash
git submodule update --init --recursive
```

You also need:

- Rust toolchain (`rustup`, target `wasm32-unknown-unknown`)
- `wasm-pack` (`cargo install wasm-pack`)
- Brew LLVM (`brew install llvm`) — used by `CC_wasm32_unknown_unknown`

## Daily commands

Run all of these from `~/Projects/Ozone/loroco/`.

| Command | What it does |
|---|---|
| `pnpm start` | Fast build (skips wasm rebuild) + launch Chrome with the extension loaded. **Use this most of the time.** |
| `pnpm start:full` | Full build (rebuilds wasm too, ~1 min) + launch Chrome. Run after editing `vendor/sage/`. |
| `pnpm dev` | WXT dev mode — live reload + auto-launches Chrome. Best for iterating on UI. |
| `pnpm chrome` | Just open Chrome with the existing build (no rebuild). |
| `pnpm build:fast` | Build the extension only — does NOT touch wasm. ~2 s. |
| `pnpm build` | Full build: rebuild wasm + rebuild extension. ~1 min on cold cache. |
| `pnpm zip` | Produce `.output/chrome-mv3.zip` for distribution. |
| `pnpm typecheck` | Run `tsc --noEmit` across all workspace packages. |

The `pnpm chrome` script uses a per-repo profile at `./.chrome-profile/` so
it doesn't touch your daily browsing session. The profile is persistent —
log in once, the wallet state survives subsequent launches.

If you want the extension in your *real* Chrome instead: go to
`chrome://extensions/` → enable Developer mode → **Load unpacked** → pick
`packages/extension/.output/chrome-mv3/`.

## Optional: local peer-sync sidecar

For real P2P sync (instead of `coinset.org` HTTP), run
[`loroco-local-sync`](https://github.com/MarvinQuevedo/loroco-local-sync)
on `127.0.0.1`. The extension auto-detects it via `sidecar-client.ts`. See
that repo's README for build + run instructions.

## Related repos

- [`MarvinQuevedo/loroco-local-sync`](https://github.com/MarvinQuevedo/loroco-local-sync) — the sidecar daemon (split for independent release cycle).
- [`MarvinQuevedo/loroco-wallet`](https://github.com/MarvinQuevedo/loroco-wallet) — older variant of this repo where Sage is a git submodule. Kept as the **target future state** for once we publish `wallet-wasm` as a package.
- [`MarvinQuevedo/sage`](https://github.com/MarvinQuevedo/sage) — upstream of the embedded sage source (branch `web/coinset-sync`).
