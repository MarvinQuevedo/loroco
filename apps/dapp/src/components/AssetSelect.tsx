import type { CatAssetView } from "@ozone/goby-provider/types";
import { Select } from "./ui";
import { shortenHex } from "../lib/format";
import { mojosToCat } from "../lib/mojos";

export function catLabel(c: CatAssetView): string {
  const name = c.symbol || c.name || shortenHex(c.assetId);
  return `${name} · ${mojosToCat(c.balance)} available`;
}

/**
 * Asset dropdown. `value` is "" for native XCH, otherwise the CAT asset id.
 * `catsOnly` drops the XCH entry (bulkSendCat, CAT-only flows).
 */
export function AssetSelect({
  cats,
  value,
  onChange,
  catsOnly = false,
  disabled,
}: {
  cats: CatAssetView[];
  value: string;
  onChange: (assetId: string) => void;
  catsOnly?: boolean;
  disabled?: boolean;
}) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      {!catsOnly && <option value="">XCH (native)</option>}
      {catsOnly && cats.length === 0 && <option value="">No CATs in this wallet</option>}
      {cats.map((c) => (
        <option key={c.assetId} value={c.assetId}>
          {catLabel(c)}
        </option>
      ))}
    </Select>
  );
}
