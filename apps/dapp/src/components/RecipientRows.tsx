import { Button, TextInput } from "./ui";
import { decimalToBase } from "../lib/mojos";

export interface OutRow {
  address: string;
  amount: string;
}

export const emptyRow = (): OutRow => ({ address: "", amount: "" });

/** Validate + convert UI rows into wire outputs (amounts as mojo strings). */
export function rowsToOutputs(rows: OutRow[], decimals: number) {
  const filled = rows.filter((r) => r.address.trim() !== "" || r.amount.trim() !== "");
  if (filled.length === 0) throw new Error("Add at least one recipient");
  return filled.map((r, i) => {
    const address = r.address.trim();
    if (!/^(xch|txch)1[a-z0-9]{20,}$/.test(address)) {
      throw new Error(`Recipient ${i + 1}: not a bech32m XCH address`);
    }
    const mojos = decimalToBase(r.amount, decimals);
    if (mojos <= 0n) throw new Error(`Recipient ${i + 1}: amount must be greater than zero`);
    return { address, amount: mojos.toString() };
  });
}

/** Sum of the row amounts as a display decimal (best-effort while typing). */
export function rowsTotal(rows: OutRow[], decimals: number): bigint {
  let total = 0n;
  for (const r of rows) {
    try {
      const v = decimalToBase(r.amount, decimals);
      if (v > 0n) total += v;
    } catch {
      /* mid-typing — skip */
    }
  }
  return total;
}

export function RecipientRows({
  rows,
  onChange,
  unit,
  disabled,
}: {
  rows: OutRow[];
  onChange: (rows: OutRow[]) => void;
  unit: string;
  disabled?: boolean;
}) {
  const update = (i: number, patch: Partial<OutRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="row-list">
      {rows.map((row, i) => (
        <div className="row-line" key={i}>
          <span className="grow">
            <TextInput
              value={row.address}
              onChange={(e) => update(i, { address: e.target.value })}
              placeholder={`Recipient ${i + 1} — xch1…`}
              spellCheck={false}
              disabled={disabled}
            />
          </span>
          <span className="w-amount">
            <TextInput
              value={row.amount}
              onChange={(e) => update(i, { amount: e.target.value })}
              placeholder={unit}
              inputMode="decimal"
              disabled={disabled}
            />
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="row-remove"
            title="Remove recipient"
            disabled={disabled || rows.length === 1}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            ✕
          </Button>
        </div>
      ))}
      <div>
        <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange([...rows, emptyRow()])}>
          + Add recipient
        </Button>
      </div>
    </div>
  );
}
