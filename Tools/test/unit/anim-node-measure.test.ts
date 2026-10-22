import { describe, it, expect } from "vitest";
import { angleDeg } from "../../src/tools/anim-node-measure.js";

describe("angleDeg", () => {
  it("measures angles between directions", () => {
    expect(angleDeg([1, 0, 0], [0, 1, 0])).toBeCloseTo(90);
    expect(angleDeg([1, 0, 0], [2, 0, 0])).toBeCloseTo(0);
    expect(angleDeg([0.766, 0.643, 0], [1, 0, 0])).toBeCloseTo(40, 0);
  });
});
