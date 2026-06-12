/* Loroco UI Kit — framework-agnostic entry.
 *
 * Exposes the design tokens as plain JS (for styled-components, theme
 * objects, canvas rendering, emails…) plus the icon path data. The CSS
 * files in ../css are the canonical styling surface; these constants
 * mirror them and must stay in sync.
 */

export { LOROCO_MARK_DATA_URI } from "./mark-data-uri";

export const lorocoColors = {
  // Brand
  terraLight: "#e8854f",
  terra: "#c0633c",
  terraDeep: "#984220",
  terraDark: "#8e3608",
  greenLime: "#9fcb5e",
  green: "#7db23e",
  greenMid: "#4f7322",
  greenDeep: "#3d5520",
  cream: "#faf3de",
  beige: "#eadcc2",
  charcoal: "#2a2a2a",
  // Semantic
  primary: "#c0633c",
  primaryPress: "#984220",
  accent: "#7db23e",
  accentPress: "#4f7322",
  action: "#9fcb5e",
  actionText: "#0e1113",
  warn: "#14b8a6",
  warnDeep: "#0f8a7d",
  red: "#ff6767",
  gold: "#ffc400",
} as const;

export const lorocoThemes = {
  light: {
    bg: "#f2f2f2",
    surface: "#fefefe",
    surface2: "#fefefe",
    text: "#23262f",
    textStrong: "#17262a",
    textMute: "#969aa0",
    hint: "#6b7280",
    border: "#d8dce0",
    wordmark: "#c0633c",
  },
  dark: {
    bg: "#101018",
    surface: "#1a1a22",
    surface2: "#25252e",
    text: "#ffffff",
    textStrong: "#ffffff",
    textMute: "#bac7ce",
    hint: "#969aa0",
    border: "#2c2c36",
    wordmark: "#f5e8d6",
  },
} as const;

export const lorocoRadii = { sm: 6, md: 12, lg: 20, xl: 28, pill: 999 } as const;

export const lorocoSpace = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32 } as const;

export const lorocoFonts = {
  ui: '"Poppins", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  brand: '"Nunito", "Poppins", system-ui, sans-serif',
  mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
  /** Google Fonts URL serving exactly the weights the kit uses. */
  googleFontsUrl:
    "https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&family=Nunito:wght@800;900&display=swap",
} as const;

import iconData from "../icons/icons.json";

export type LorocoIconName = keyof typeof iconData.icons;

/** Icon name → array of inner SVG element strings (24×24 viewBox, stroke=currentColor). */
export const lorocoIconPaths: Record<LorocoIconName, readonly string[]> = iconData.icons;

export const lorocoIconNames = Object.keys(iconData.icons) as LorocoIconName[];
