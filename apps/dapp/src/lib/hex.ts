// Hex helpers for signing flows (signMessage takes a hex `message`).

export function textToHex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function hexToText(hex: string): string {
  const clean = hex.replace(/^0x/, "");
  if (clean.length % 2 !== 0) throw new Error("Hex string has odd length");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

/** True if `s` is exactly 32 bytes of hex (64 chars, optional 0x prefix). */
export function isHex32(s: string): boolean {
  return /^(0x)?[0-9a-fA-F]{64}$/.test(s.trim());
}

/** True if `s` is any even-length hex string (optional 0x prefix). */
export function isHex(s: string): boolean {
  const clean = s.trim().replace(/^0x/, "");
  return clean.length > 0 && clean.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(clean);
}
