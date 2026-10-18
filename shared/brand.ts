// Quorum – Markengeometrie und ein kleiner Software-Rasterizer (ohne Abhängigkeiten).
// Wird vom Hauptprozess (Fenster-/Tray-Icon zur Laufzeit) und von scripts/make-icons.ts (PNG/ICO/ICNS) genutzt.
// Bewusst nur Typannotationen, keine TS-only-Syntax – so läuft die Datei auch direkt mit `node`.

export type Pt = [number, number];
export interface Shape { pts: Pt[]; color: [number, number, number] }

/**
 * Die Marke: ein Dreiecksring aus drei scharfen Scherben (drei Modelle) um eine kleine Mitte (der Konsens / das Quorum).
 * Koordinaten im 100×100-Raster. Keine Rundungen.
 */
export const MARK: Shape[] = [
  { pts: [[48.88, 9.05], [48.88, 36.3], [30.47, 69.78], [7.96, 83.45]], color: [79, 123, 255] },   // links – Hub-Blau
  { pts: [[51.12, 9.05], [92.04, 83.45], [69.53, 69.78], [51.12, 36.3]], color: [138, 107, 255] }, // rechts – Hub-Violett
  { pts: [[90.92, 85.48], [9.08, 85.48], [31.59, 71.81], [68.41, 71.81]], color: [201, 211, 255] }, // unten – Schimmer
  { pts: [[50, 47.5], [58.4, 63.5], [41.6, 63.5]], color: [255, 255, 255] },                        // Mitte – Quorum
];

function inside(p: Pt, poly: Pt[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/**
 * Rastert die Marke in ein RGBA-Bild (size×size).
 * background: dunkles Quadrat mit leicht abgeschrägten Ecken (App-Icon) – sonst transparent.
 * order: "rgba" (PNG) oder "bgra" (Electron nativeImage.createFromBitmap).
 */
export function rasterize(size: number, opts: { background?: boolean; padding?: number; order?: 'rgba' | 'bgra' } = {}): Uint8Array {
  const pad = opts.padding ?? (opts.background ? 0.2 : 0.04);
  const scale = (size * (1 - pad * 2)) / 100;
  const off = size * pad;
  const ss = 3; // 3×3 Supersampling
  const out = new Uint8Array(size * size * 4);
  const bgR = 14, bgG = 15, bgB = 19;
  const cut = size * 0.2; // Eckenabschrägung
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss, py = y + (sy + 0.5) / ss;
          let col: [number, number, number] | null = null;
          // Marke
          const mp: Pt = [(px - off) / scale, (py - off) / scale];
          for (let i = MARK.length - 1; i >= 0; i--) if (inside(mp, MARK[i].pts)) { col = MARK[i].color; break; }
          let alpha = col ? 1 : 0;
          if (!col && opts.background) {
            // Hintergrund mit abgeschrägten Ecken
            const dx = Math.min(px, size - px), dy = Math.min(py, size - py);
            if (dx + dy >= cut) { col = [bgR, bgG, bgB]; alpha = 1; }
          }
          if (col) { r += col[0] * alpha; g += col[1] * alpha; b += col[2] * alpha; a += alpha; }
        }
      }
      const n = ss * ss, i = (y * size + x) * 4;
      const cov = a / n;
      const rr = a ? r / a : 0, gg = a ? g / a : 0, bb = a ? b / a : 0;
      const bgra = opts.order === 'bgra';
      out[i] = Math.round(bgra ? bb : rr);
      out[i + 1] = Math.round(gg);
      out[i + 2] = Math.round(bgra ? rr : bb);
      out[i + 3] = Math.round(cov * 255);
    }
  }
  return out;
}
