import { CopyText } from "./CopyText";
import { explorerUrl, shortenHex, type ExplorerKind } from "../../lib/format";

// A short, copyable id that also links to the block explorer. Falls back to a
// plain CopyText when no explorer URL applies (e.g. unknown network).
export function IdLink({
  value,
  kind,
  chainId,
  head = 10,
  tail = 8,
}: {
  value: string;
  kind: ExplorerKind;
  chainId: string | null | undefined;
  head?: number;
  tail?: number;
}) {
  const url = explorerUrl(kind, value, chainId);
  return (
    <span className="id-link">
      <CopyText text={value} display={shortenHex(value, head, tail)} />
      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer" title="Open in Spacescan" className="ext-link">
          ↗
        </a>
      )}
    </span>
  );
}
