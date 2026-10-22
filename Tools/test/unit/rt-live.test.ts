import { describe, it, expect } from "vitest";
import { motionRange } from "../../src/tools/rt-live.js";
import { compileSummary } from "../../src/tools/anim-guard.js";

describe("motionRange", () => {
  it("is 0 for a frozen target and the largest role travel otherwise", () => {
    const still = { foot_l: [1, 2, 3], hand_r: [4, 5, 6] };
    expect(motionRange([still, still, still])).toBe(0);
    expect(motionRange([still, { foot_l: [1, 32, 3], hand_r: [4, 5, 6] }])).toBeCloseTo(30);
  });
});

describe("compileSummary non-pose pins", () => {
  it("does not call RetargetPoseFromMesh's ignored Source pin an unwired graph (live false failure)", () => {
    const d = { isValid: true, warnings: [{ graph: "AnimGraph", nodeTitle: "Retarget Pose From Mesh", message: "Source was visible but ignored" }] };
    expect(compileSummary(d).ok).toBe(true);
  });
  it("still fails an ignored pose pin", () => {
    const d = { isValid: true, warnings: [{ graph: "AnimGraph", nodeTitle: "Output Pose", message: "Result was visible but ignored" }] };
    expect(compileSummary(d).ok).toBe(false);
  });
});
