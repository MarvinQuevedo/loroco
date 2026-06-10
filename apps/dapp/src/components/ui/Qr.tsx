// Inline-SVG QR (no canvas). Themed via currentColor so it follows light/dark.
// Ported from the extension popup's qr.tsx.

import qrcode from "qrcode-generator";

export function Qr({ data, size = 168, margin = 4 }: { data: string; size?: number; margin?: number }) {
  const qr = qrcode(0, "M");
  qr.addData(data);
  qr.make();
  const n = qr.getModuleCount();
  const cell = (size - margin * 2) / n;
  const rects: string[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) {
        rects.push(
          `<rect x="${(margin + c * cell).toFixed(2)}" y="${(margin + r * cell).toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}" />`,
        );
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="transparent"/><g fill="currentColor">${rects.join("")}</g></svg>`;
  return <span className="qr" dangerouslySetInnerHTML={{ __html: svg }} />;
}
