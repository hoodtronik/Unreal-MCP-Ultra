import { describe, it, expect } from "vitest";
import { rotatorQuat } from "../../src/tools/clip.js";
import { qAngle } from "../../src/tools/pose-fk.js";

describe("rotatorQuat", () => {
  it("matches UE FRotator::Quaternion for single-axis rotations", () => {
    const y = rotatorQuat(0, 90, 0);
    expect(y[2]).toBeCloseTo(Math.SQRT1_2, 6); expect(y[3]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(qAngle(rotatorQuat(0, 0, -20), [0, 0, 0, 1])).toBeCloseTo(20, 6); // live: head -20 roll -> 19.99 deg from ref
    expect(qAngle(rotatorQuat(25, 0, 0), [0, 0, 0, 1])).toBeCloseTo(25, 6);
  });
});
