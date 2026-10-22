import { describe, it, expect } from "vitest";
import { overlapOf } from "../../src/tools/shot-sightlines.js";

describe("overlapOf", () => {
  it("measures how much of a box another box covers, clipped to the frame", () => {
    const hero = { u: [-0.5, 0.4], v: [-2.2, 0.34], dist: 318 };
    const statue = { u: [-0.34, 0.04], v: [-0.94, 0.37], dist: 665 };
    expect(overlapOf(hero, statue)).toBeGreaterThan(0.9);
    expect(overlapOf({ u: [2, 3], v: [0, 1], dist: 1 }, statue)).toBe(0);
  });
});
