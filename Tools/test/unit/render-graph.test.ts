import { describe, it, expect } from "vitest";
import { plateDiff } from "../../src/tools/render-graph.js";

const img = (px: number[][]) => ({ width: px.length, height: 1, channels: 3, data: Uint8Array.from(px.flat()) });

describe("plateDiff", () => {
  it("separates the removed subject from a stable background", () => {
    const d = plateDiff(img([[200, 200, 200], [10, 10, 10], [10, 10, 10], [10, 10, 10]]), img([[0, 0, 0], [10, 10, 10], [11, 11, 11], [10, 10, 10]]));
    expect(d.changed).toBeCloseTo(0.25);
    expect(d.backgroundShift).toBeCloseTo(1 / 3);
  });
  it("shows an exposure shift as background change", () => {
    const d = plateDiff(img([[100, 100, 100], [100, 100, 100]]), img([[96, 96, 96], [95, 95, 95]]));
    expect(d.changed).toBe(0);
    expect(d.backgroundShift).toBeGreaterThan(1.5);
  });
});
