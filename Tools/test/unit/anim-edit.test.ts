import { describe, it, expect } from "vitest";
import { lerpKeys } from "../../src/tools/anim-edit.js";

describe("lerpKeys", () => {
  const k: [number, number][] = [[0, 0], [0.75, 1], [1.5, 0]];
  it("matches the live linear curve (0.5 at 0.375, 0.4 at 1.2)", () => {
    expect(lerpKeys(k, 0.375)).toBeCloseTo(0.5);
    expect(lerpKeys(k, 1.2)).toBeCloseTo(0.4);
  });
  it("holds the end values outside the keys", () => {
    expect(lerpKeys(k, -1)).toBe(0);
    expect(lerpKeys(k, 9)).toBe(0);
  });
});
