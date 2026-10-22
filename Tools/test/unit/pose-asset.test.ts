import { describe, it, expect } from "vitest";
import { expectedTarget } from "../../src/tools/pose-asset.js";

describe("pose_asset check target", () => {
  it("one pose at full weight -> that pose; all zero -> base; anything else -> partial", () => {
    expect(expectedTarget({ WaveHigh: 1 })).toEqual({ kind: "pose", pose: "WaveHigh" });
    expect(expectedTarget({ WaveHigh: 1, Pose_3: 0 })).toEqual({ kind: "pose", pose: "WaveHigh" });
    expect(expectedTarget({ WaveHigh: 0 })).toEqual({ kind: "base" });
    expect(expectedTarget({ WaveHigh: 0.5 })).toEqual({ kind: "partial" }); // live: not half-way (36 / 63 cm)
    expect(expectedTarget({ A: 1, B: 1 })).toEqual({ kind: "partial" });
  });
});
