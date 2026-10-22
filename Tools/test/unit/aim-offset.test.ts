import { describe, it, expect } from "vitest";
import { aimAxisChecks, aimBodyChecks, angDiff } from "../../src/tools/aim-offset.js";

// Live AO_Look numbers (2026-10-22): yaw -90/+90 -> head -30.4/+29.9, pitch +-90 -> +-44.4, body unchanged.
const good = [
  { x: 0, y: 0, yaw: 100, pitch: 0 },
  { x: -90, y: 0, yaw: 69.6, pitch: 0.7 },
  { x: 90, y: 0, yaw: 129.9, pitch: 1.5 },
  { x: 0, y: 90, yaw: 101.1, pitch: 44.3 },
  { x: 0, y: -90, yaw: 105.5, pitch: -44.4 },
];

describe("aimAxisChecks", () => {
  it("passes opposite, clean axes", () => {
    expect(aimAxisChecks(good).ok).toBe(true);
  });
  it("fails swapped axes (the pre-fix AO_Look: X moved pitch, Y moved yaw)", () => {
    const swapped = good.map((p) => ({ ...p, yaw: p.x === 0 && p.y === 0 ? 100 : 100 + (p.pitch), pitch: p.yaw - 100 }));
    expect(aimAxisChecks(swapped).ok).toBe(false);
  });
  it("fails when both extremes turn the same way", () => {
    const same = good.map((p) => (p.x === 90 ? { ...p, yaw: 69 } : p));
    expect(aimAxisChecks(same).ok).toBe(false);
  });
  it("needs a (0,0) point", () => {
    expect(aimAxisChecks(good.slice(1)).ok).toBe(false);
  });
  it("wraps angles", () => {
    expect(angDiff(-179, 179)).toBeCloseTo(2);
  });
});

describe("aimBodyChecks", () => {
  const base = { pelvis_z: 93.86, spine_len: 66.7 };
  it("accepts an intact body", () => {
    expect(aimBodyChecks(base, good.map((p) => ({ ...p, pelvis_z: 93.9, spine_len: 66.71 })))).toEqual([]);
  });
  it("flags the 4x stretch the eyes caught (pelvis z 379)", () => {
    expect(aimBodyChecks(base, [{ ...good[0], pelvis_z: 379.4, spine_len: 250 }]).length).toBe(1);
  });
});
