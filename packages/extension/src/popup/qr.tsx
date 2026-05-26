// Tiny QR renderer using qrcode-generator (no canvas, no deps beyond the lib).
// Produces an inline SVG so it scales perfectly + themes via currentColor.

import qrcode from "qrcode-generator";

export interface QrProps {
  data: string;
  size?: number;
  margin?: number;
}

export function Qr({ data, size = 200, margin = 4 }: QrProps) {
  const qr = qrcode(0, "M"); // typeNumber 0 = auto, error correction medium
  qr.addData(data);
  qr.make();
  const moduleCount = qr.getModuleCount();
  const cellSize = (size - margin * 2) / moduleCount;
  const cells: string[] = [];
  for (let r = 0; r < moduleCount; r++) {
    for (let c = 0; c < moduleCount; c++) {
      if (qr.isDark(r, c)) {
        const x = margin + c * cellSize;
        const y = margin + r * cellSize;
        cells.push(
          `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cellSize.toFixed(
            2,
          )}" height="${cellSize.toFixed(2)}" />`,
        );
      }
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="transparent"/><g fill="currentColor">${cells.join("")}</g></svg>`;

  return (
    <span
      className="qr"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
