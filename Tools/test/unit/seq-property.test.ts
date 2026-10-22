import { describe, it, expect } from "vitest";
import { expectedAt, matches, toSrgb8 } from "../../src/tools/seq-property.js";

describe("seq_property checks", () => {
  it("toSrgb8 matches UE's linear -> 8-bit sRGB (live: 0.4 -> 170, 0.6 -> 203, 0.7 -> 218)", () => {
    expect(toSrgb8(0.4)).toBe(170);
    expect(toSrgb8(0.6)).toBe(203);
    expect(toSrgb8(0.7)).toBe(218);
    expect(toSrgb8(1)).toBe(255);
  });
  it("expectedAt interpolates linear keys, holds constant / bool keys, skips auto between keys", () => {
    const k = [{ frame: 0, value: 500 }, { frame: 24, value: 8000 }];
    expect(expectedAt(k, 12, "linear")).toBe(4250); // live: 4250
    expect(expectedAt(k, 12, "constant")).toBe(500);
    expect(expectedAt(k, 12, "auto")).toBeNull();
    expect(expectedAt([{ frame: 0, value: [0.4, 0.6, 1] }, { frame: 24, value: [1, 0.75, 0.5] }], 12, "linear")).toEqual([0.7, 0.675, 0.75]);
  });
  it("matches compares 8-bit colours in sRGB and floats relatively", () => {
    expect(matches([218, 214, 225, 255], [0.7, 0.675, 0.75])).toBe(true);
    expect(matches([170, 203, 255, 255], [1, 0.75, 0.5])).toBe(false);
    expect(matches(4250, 4250.5)).toBe(true);
    expect(matches(true, false)).toBe(false);
  });
});
