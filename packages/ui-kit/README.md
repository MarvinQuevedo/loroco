# @loroco/ui-kit

Brand assets, design tokens, typography, icons and optional React
components for dApps that integrate the **Loroco** Chia wallet. Use it
so your connect button, approval prompts and wallet status UI look
exactly like the wallet itself.

Everything visual mirrors the wallet popup 1:1 — same palette, radii,
spacing and type ramp.

```
css/        tokens.css · fonts.css · components.css · loroco.css (all-in-one)
assets/     icon/ — squircle app icon 16–1024 px (PNG, transparent corners)
icons/      18 UI icons (SVG, stroke, currentColor) + loroco-icons.svg sprite
src/        index.ts (tokens as JS) · react.tsx (React components)
demo/       index.html — kitchen sink, light & dark side by side
```

## Quick start (any framework)

```html
<link rel="stylesheet" href="node_modules/@loroco/ui-kit/css/loroco.css" />

<button class="loroco-connect-btn">
  <img src="node_modules/@loroco/ui-kit/assets/icon/icon-48.png" class="loroco-mark" alt="" />
  Connect Loroco
</button>
```

With a bundler (Vite/webpack):

```ts
import "@loroco/ui-kit/css/loroco.css";
```

`loroco.css` = `fonts.css` (Google Fonts: Poppins + Nunito) +
`tokens.css` + `components.css`. Self-hosting fonts or strict CSP?
Import `tokens.css` + `components.css` and serve Poppins/Nunito
yourself — everything falls back to system fonts gracefully.

## React

```tsx
import "@loroco/ui-kit/css/loroco.css";
import {
  LorocoConnectButton,
  LorocoLogo,
  LorocoIcon,
  PoweredByLoroco,
} from "@loroco/ui-kit/react";

<LorocoConnectButton onClick={connect} />                 // disconnected
<LorocoConnectButton address={address} onClick={open} />  // connected → address chip
<LorocoLogo variant="stacked" markSrc={icon256} />
<LorocoIcon name="send" size={20} />
<PoweredByLoroco />
```

React is an optional peer dependency; the CSS + assets work standalone.

## Theming

Tokens follow `prefers-color-scheme` by default. Force a theme on any
subtree:

```html
<div class="loroco-dark"> …wallet UI in dark mode… </div>
```

All variables are namespaced `--loroco-*`, all classes `loroco-*` —
nothing collides with your dApp's styles. Tokens are also available as
JS via `import { lorocoColors, lorocoThemes, lorocoRadii, lorocoSpace,
lorocoFonts } from "@loroco/ui-kit"`.

## Brand rules

Palette (front and center):

| Token | Hex | Use |
| --- | --- | --- |
| terra | `#c0633c` | Primary, wordmark on light bg |
| terra-deep | `#984220` | Primary pressed |
| green-lime | `#9fcb5e` | Action buttons (Approve) |
| green | `#7db23e` | Accent — the flower's heart |
| cream | `#faf3de` | Petals, wordmark on dark bg |
| warn (teal) | `#14b8a6` | Pending / caution |
| red | `#ff6767` | Errors, destructive |

Typography: **Poppins** for UI (400/500/600/700), **Nunito 900** for
the wordmark only — always lowercase `loroco`, letter-spacing −0.03 em
to −0.05 em.

Logo usage:

- App icon (squircle): `assets/icon/icon-*.png` — transparent corners,
  works on any background. This is the only raster logo asset shipped.
- Lockup (icon + wordmark): render it live with `.loroco-lockup` /
  `<LorocoLogo />` — the wordmark is typed in Nunito 900 so it stays
  crisp at any size and recolors per theme automatically. Baked PNG
  lockups and flower-only cutouts are intentionally **not** included:
  the existing exports carry baked backgrounds and uneven crops. They
  can be added once clean transparent/vector exports exist.
- The `flower` entry in `icons/` is a simplified monochrome glyph for
  tiny inline UI — it is **not** the logo; don't use it for branding.
- No vector master exists yet; the largest raster is
  `assets/icon/icon-1024.png`. Don't upscale past it.

Display rules (these come from the wallet's security model — keep
them):

- Never truncate an address below ~12 leading + 6 trailing chars
  (`xch1qxw3kt2lf9…f0ksme`). Hiding the middle is fine; hiding almost
  everything lets lookalike addresses pass.
- Render amounts, fees, asset ids and recipients in `--loroco-font-mono`.
- Show users the same values the wallet popup will show — don't
  re-summarize.

## Icons

18 stroke icons, 24×24, `stroke-width: 1.8`, `currentColor`: `wallet
connect send receive offer sign lock check alert copy external qr token
nft site close chevron flower`.

Three ways to consume:

1. **Files** — `icons/<name>.svg` (inline or `<img>`).
2. **Sprite** — inject `icons/loroco-icons.svg` once, then
   `<svg class="loroco-icon"><use href="#send" /></svg>`.
3. **React** — `<LorocoIcon name="send" />`.

Source of truth is `icons/icons.json`; after editing run
`pnpm build:icons` to regenerate the SVG files and the sprite.

## Demo

Open `demo/index.html` from a static server (it fetches `icons.json`):

```bash
npx serve packages/ui-kit   # → http://localhost:3000/demo/
```
