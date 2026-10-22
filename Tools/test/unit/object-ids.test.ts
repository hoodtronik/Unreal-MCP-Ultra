import { describe, it, expect } from "vitest";
import { idCounts } from "../../src/tools/object-ids.js";

const img = (px: number[][]) => ({ width: px.length, height: 1, channels: 3, data: Uint8Array.from(px.flat()) });

describe("idCounts", () => {
  it("counts palette ids, background and off-palette pixels", () => {
    const c = idCounts(img([[0, 0, 0], [255, 0, 0], [255, 0, 0], [0, 255, 0], [120, 60, 30]]), 2);
    expect(c.ids).toEqual([2, 1]);
    expect(c.background).toBe(1);
    expect(c.other).toBe(1);
  });
  it("treats ids beyond the listed objects as off-palette", () => {
    expect(idCounts(img([[0, 0, 255]]), 2).other).toBe(1);
  });
});
