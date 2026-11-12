import { describe, expect, it } from "vitest";
import { OVERLAY_COLORS, overlay, type Pixels } from "../src/core/imagediff";

/** A white image with the listed pixels drawn black. */
function image(width: number, height: number, ink: [number, number][]): Pixels {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const [x, y] of ink) data.set([0, 0, 0, 255], (y * width + x) * 4);
  return { width, height, data };
}
const colorAt = (img: Pixels, x: number, y: number) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));

describe("overlay", () => {
  it("colors ink by which revision it's in", () => {
    const r = overlay(image(3, 1, [[0, 0], [1, 0]]), image(3, 1, [[1, 0], [2, 0]]));
    expect([r.removed, r.common, r.added]).toEqual([1, 1, 1]);
    expect(colorAt(r, 0, 0)).toEqual([...OVERLAY_COLORS.removed]);
    expect(colorAt(r, 1, 0)).toEqual([...OVERLAY_COLORS.common]);
    expect(colorAt(r, 2, 0)).toEqual([...OVERLAY_COLORS.added]);
  });

  it("reports no change for identical drawings", () => {
    const a = image(4, 4, [[1, 1], [2, 2]]);
    const r = overlay(a, a);
    expect([r.removed, r.added, r.common]).toEqual([0, 0, 2]);
  });

  it("boxes separate clusters of change separately", () => {
    const r = overlay(image(200, 100, []), image(200, 100, [[2, 2], [3, 3], [150, 80]]));
    expect(r.regions).toHaveLength(2);
    expect(r.regions[0]).toMatchObject({ x: 0, y: 0 });
    expect(overlay(image(10, 10, [[1, 1]]), image(10, 10, [[1, 1]])).regions).toEqual([]);
  });

  it("aligns pages of different sizes and counts the extra area", () => {
    const r = overlay(image(2, 2, []), image(3, 3, [[2, 2]]));
    expect([r.width, r.height, r.added]).toEqual([3, 3, 1]);
  });
});
