/** RGBA pixels, as in the browser's ImageData. */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

export interface OverlayResult extends Pixels {
  /** Ink only in the older drawing. */
  removed: number;
  /** Ink only in the newer drawing. */
  added: number;
  /** Ink in both. */
  common: number;
  /** Boxes around clusters of changed pixels, so small edits are easy to spot. */
  regions: Region[];
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Changed pixels within this many pixels of each other are boxed together. */
const CELL = 24;

export const OVERLAY_COLORS = {
  removed: [214, 40, 40],
  added: [20, 150, 70],
  common: [150, 150, 150],
  paper: [255, 255, 255],
} as const;

/** A pixel counts as ink when it's darker than this (0-255 luminance). */
const INK = 160;

function inkAt(img: Pixels, x: number, y: number): boolean {
  if (x >= img.width || y >= img.height) return false;
  const i = (y * img.width + x) * 4;
  const lum = 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!;
  // Transparent pixels are paper.
  return img.data[i + 3]! > 127 && lum < INK;
}

/**
 * Overlays two renderings of a drawing: ink in both is gray, ink only in the older one is red
 * (removed), ink only in the newer one is green (added). Pages of different sizes are aligned at
 * the top-left corner.
 */
export function overlay(older: Pixels, newer: Pixels): OverlayResult {
  const width = Math.max(older.width, newer.width);
  const height = Math.max(older.height, newer.height);
  const data = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  let removed = 0;
  let added = 0;
  let common = 0;
  const cols = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const changedCells = new Uint8Array(cols * rows);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = inkAt(older, x, y);
      const b = inkAt(newer, x, y);
      const color = a && b ? OVERLAY_COLORS.common : a ? OVERLAY_COLORS.removed : b ? OVERLAY_COLORS.added : OVERLAY_COLORS.paper;
      if (a && b) common++;
      else if (a) removed++;
      else if (b) added++;
      if (a !== b) changedCells[Math.floor(y / CELL) * cols + Math.floor(x / CELL)] = 1;
      const i = (y * width + x) * 4;
      data[i] = color[0];
      data[i + 1] = color[1];
      data[i + 2] = color[2];
      data[i + 3] = 255;
    }
  }
  return { width, height, data, removed, added, common, regions: regionsOf(changedCells, cols, rows, width, height) };
}

/** Groups touching changed cells (including diagonals) and returns each group's bounding box. */
function regionsOf(cells: Uint8Array, cols: number, rows: number, width: number, height: number): Region[] {
  const seen = new Uint8Array(cells.length);
  const regions: Region[] = [];
  for (let start = 0; start < cells.length; start++) {
    if (!cells[start] || seen[start]) continue;
    let [minC, maxC, minR, maxR] = [cols, -1, rows, -1];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const c = i % cols;
      const r = Math.floor(i / cols);
      [minC, maxC, minR, maxR] = [Math.min(minC, c), Math.max(maxC, c), Math.min(minR, r), Math.max(maxR, r)];
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const nc = c + dc;
          const nr = r + dr;
          const n = nr * cols + nc;
          if (nc >= 0 && nc < cols && nr >= 0 && nr < rows && cells[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
    }
    const x = minC * CELL;
    const y = minR * CELL;
    regions.push({ x, y, width: Math.min((maxC + 1) * CELL, width) - x, height: Math.min((maxR + 1) * CELL, height) - y });
  }
  return regions;
}
