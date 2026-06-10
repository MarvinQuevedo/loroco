// BigInt-safe mojo conversions.
//
// XCH balances routinely exceed 2^53, so amounts MUST round-trip through
// BigInt — never Number(). 1 XCH = 1e12 mojos, 1 CAT = 1e3 CAT-mojos.

export const XCH_DECIMALS = 12;
export const CAT_DECIMALS = 3;

/** Parse a human decimal string ("1.5") into base units (mojos) as a bigint. */
export function decimalToBase(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === ".") return 0n;
  if (!/^\d*\.?\d*$/.test(trimmed)) {
    throw new Error(`Invalid amount: ${value}`);
  }
  const neg = trimmed.startsWith("-");
  const [intPart = "0", fracPartRaw = ""] = trimmed.replace(/^-/, "").split(".");
  // Pad / truncate the fractional part to exactly `decimals` digits.
  const fracPart = fracPartRaw.slice(0, decimals).padEnd(decimals, "0");
  const base = BigInt(intPart || "0") * 10n ** BigInt(decimals) + BigInt(fracPart || "0");
  return neg ? -base : base;
}

/** Format base units (mojos) as a human decimal string, trimming trailing zeros. */
export function baseToDecimal(base: bigint | string, decimals: number): string {
  const v = typeof base === "string" ? BigInt(base) : base;
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  let fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  const out = fracStr ? `${whole}.${fracStr}` : `${whole}`;
  return neg ? `-${out}` : out;
}

export const xchToMojos = (xch: string): bigint => decimalToBase(xch, XCH_DECIMALS);
export const mojosToXch = (mojos: bigint | string): string => baseToDecimal(mojos, XCH_DECIMALS);
export const catToMojos = (cat: string): bigint => decimalToBase(cat, CAT_DECIMALS);
export const mojosToCat = (mojos: bigint | string): string => baseToDecimal(mojos, CAT_DECIMALS);
