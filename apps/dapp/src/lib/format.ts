// Display formatters. Rule (from CLAUDE.md): never truncate an address or
// asset id so hard that a swap could hide in the elided middle. Keep 10 head
// / 8 tail characters minimum.

export function shortenAddress(addr: string | null | undefined, head = 10, tail = 8): string {
  if (!addr) return "—";
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

export function shortenHex(hex: string | null | undefined, head = 10, tail = 8): string {
  return shortenAddress(hex, head, tail);
}

// Block-explorer deep links (Spacescan). Returns the URL for the given entity,
// adding the testnet11 network hint when needed. Used to make ids in tables
// clickable — a real wallet-console expectation.
export type ExplorerKind = "coin" | "tx" | "address" | "nft" | "offer";

export function explorerUrl(
  kind: ExplorerKind,
  value: string,
  chainId: string | null | undefined,
): string | null {
  if (!value) return null;
  const base = "https://www.spacescan.io";
  const q = chainId === "testnet11" ? "?network=testnet11" : "";
  switch (kind) {
    case "coin":
    case "tx": // a confirmed tx id is the coin id in our TransactionView
      return `${base}/coin/${value}${q}`;
    case "address":
      return `${base}/address/${value}${q}`;
    case "nft":
      return `${base}/nft/${value}${q}`;
    case "offer":
      return `${base}/offer/${value}${q}`;
    default:
      return null;
  }
}

export function fmtNumber(n: number | bigint | string): string {
  try {
    const v = typeof n === "string" ? Number(n) : n;
    return new Intl.NumberFormat().format(v as number | bigint);
  } catch {
    return String(n);
  }
}

/** Relative time from a ms epoch. Returns "—" for null/0/unknown. */
export function timeAgo(ms: number | null | undefined): string {
  if (!ms) return "—";
  const diff = msNow() - ms;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ms).toLocaleDateString();
}

// Isolated so the rest of the module stays pure / testable.
function msNow(): number {
  return new Date().getTime();
}
