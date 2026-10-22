import { describe, it, expect } from "vitest";
import { lerpKeys } from "../../src/tools/shot-rig.js";

describe("lerpKeys", () => {
  const k = [{ frame: 0, value: 0 }, { frame: 47, value: 1 }];
  it("interpolates linearly and holds outside the keys", () => {
    expect(lerpKeys(k, 23)).toBeCloseTo(0.48936, 4); // live rail position 0.4894
    expect(lerpKeys(k, -5)).toBe(0);
    expect(lerpKeys(k, 60)).toBe(1);
    expect(lerpKeys([{ frame: 0, value: -10 }, { frame: 47, value: 35 }], 24)).toBeCloseTo(12.979, 3); // live crane pitch
  });
});
