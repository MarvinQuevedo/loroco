/* Loroco UI Kit — optional React bindings.
 *
 * Thin wrappers over the CSS classes in css/components.css; import
 * "@loroco/ui-kit/css/loroco.css" (or the individual files) alongside.
 * The icon SVG markup comes from icons/icons.json — our own static
 * data, so the innerHTML render is safe.
 */
import * as React from "react";
import {
  LOROCO_MARK_DATA_URI,
  lorocoIconPaths,
  type LorocoIconName,
} from "./index";

export type { LorocoIconName };

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* ── Icon ─────────────────────────────────────────────────────────── */

export interface LorocoIconProps extends React.SVGProps<SVGSVGElement> {
  name: LorocoIconName;
  /** Pixel size; defaults to the .loroco-icon CSS size (20). */
  size?: number;
  title?: string;
}

export function LorocoIcon({ name, size, title, className, ...rest }: LorocoIconProps) {
  const elements = lorocoIconPaths[name];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx("loroco-icon", className)}
      width={size}
      height={size}
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      dangerouslySetInnerHTML={{ __html: elements.join("") }}
      {...rest}
    />
  );
}

/* ── Logo / lockup ────────────────────────────────────────────────── */

export interface LorocoLogoProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** horizontal (default) | sm | stacked | mark (icon only) */
  variant?: "horizontal" | "sm" | "stacked" | "mark";
  /**
   * Image used as the mark. Defaults to an inlined 48px squircle —
   * fine up to ~32px renders; for `stacked` pass assets/icon/icon-256.png.
   */
  markSrc?: string;
}

export function LorocoLogo({ variant = "horizontal", markSrc, className, ...rest }: LorocoLogoProps) {
  const src = markSrc ?? LOROCO_MARK_DATA_URI;
  if (variant === "mark") {
    return (
      <span className={cx("loroco-lockup", className)} {...rest}>
        <img src={src} alt="Loroco" className="loroco-mark" />
      </span>
    );
  }
  return (
    <span
      className={cx(
        "loroco-lockup",
        variant === "sm" && "loroco-lockup--sm",
        variant === "stacked" && "loroco-lockup--stacked",
        className,
      )}
      {...rest}
    >
      <img src={src} alt="" className="loroco-mark" />
      <span className="loroco-word">loroco</span>
    </span>
  );
}

/* ── Connect button ───────────────────────────────────────────────── */

export interface LorocoConnectButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Connected wallet address; when set the button renders as an address chip. */
  address?: string;
  /** Label while disconnected. */
  label?: string;
  /** Visual style: outline (default) blends in; solid is terracotta. */
  appearance?: "outline" | "solid";
  markSrc?: string;
}

function truncateAddress(addr: string): string {
  // Keep enough characters that a lookalike swap stays visible
  // (same rule as the wallet popup: never down to 2+2).
  if (addr.length <= 24) return addr;
  return `${addr.slice(0, 12)}…${addr.slice(-6)}`;
}

export function LorocoConnectButton({
  address,
  label = "Connect Loroco",
  appearance = "outline",
  markSrc,
  className,
  children,
  ...rest
}: LorocoConnectButtonProps) {
  const src = markSrc ?? LOROCO_MARK_DATA_URI;
  return (
    <button
      type="button"
      className={cx(
        "loroco-connect-btn",
        appearance === "solid" && "loroco-connect-btn--solid",
        className,
      )}
      {...rest}
    >
      <img src={src} alt="" className="loroco-mark" />
      {children ??
        (address ? (
          <span className="loroco-mono">{truncateAddress(address)}</span>
        ) : (
          label
        ))}
    </button>
  );
}

/* ── Powered-by attribution ───────────────────────────────────────── */

export interface PoweredByLorocoProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  markSrc?: string;
}

export function PoweredByLoroco({ markSrc, className, href, ...rest }: PoweredByLorocoProps) {
  return (
    <a
      className={cx("loroco-powered", className)}
      href={href ?? "https://loroco.app"}
      target="_blank"
      rel="noreferrer"
      {...rest}
    >
      <img src={markSrc ?? LOROCO_MARK_DATA_URI} alt="" className="loroco-mark" />
      <span>Powered by</span>
      <span className="loroco-powered-name">loroco</span>
    </a>
  );
}
