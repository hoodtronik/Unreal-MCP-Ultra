import { describe, it, expect } from "vitest";
import { dist, spread, followReport } from "../../src/tools/pose-space.js";

describe("pose-space helpers", () => {
  it("spread is the largest distance from the first point", () => {
    expect(spread([])).toBe(0);
    expect(spread([[1, 2, 3]])).toBe(0);
    expect(spread([[0, 0, 0], [3, 4, 0], [1, 0, 0]])).toBe(5);
    expect(dist([0, 0, 0], [0, 0, 2])).toBe(2);
  });

  it("followReport: offset held while the parent moves, worst bone gap found", () => {
    const f = followReport([
      { frame: 0, ctrl: [25, 24, 99], rel: [0, 0, 5], space_pos: [25, 24, 94], bone: "hand_r", gap: 0 },
      { frame: 24, ctrl: [22, 32, 99], rel: [0, 0, 5], space_pos: [22, 32, 94], bone: "hand_r", gap: 3.4 },
      { frame: 48, ctrl: [20, 40, 99], rel: [0, 0, 5], space_pos: [20, 40, 94], bone: "hand_r", gap: 0.2 },
    ]);
    expect(f.drift).toBe(0);
    expect(f.moved).toBeCloseTo(Math.hypot(5, 16), 6);
    expect(f.gap).toBe(3.4);
    expect(f.gapFrame).toBe(24);
    expect(f.bone).toBe("hand_r");
  });

  it("followReport: world space uses the control itself as the moving point", () => {
    const f = followReport([
      { frame: 0, ctrl: [0, 0, 0], rel: [0, 0, 0], space_pos: null },
      { frame: 1, ctrl: [0, 0, 1], rel: [0, 0, 1], space_pos: null },
    ]);
    expect(f.moved).toBe(1);
    expect(f.drift).toBe(1);
  });
});
