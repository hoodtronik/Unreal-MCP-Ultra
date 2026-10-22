import { describe, it, expect } from "vitest";
import { keyFrames, midFrames } from "../../src/tools/shot-follow.js";

describe("follow key schedule", () => {
  it("keys every n frames and always the last frame", () => {
    expect(keyFrames(0, 24, 4)).toEqual([0, 4, 8, 12, 16, 20, 24]);
    expect(keyFrames(24, 47, 4)).toEqual([24, 28, 32, 36, 40, 44, 47]);
  });
  it("checks the midpoints between keys", () => {
    expect(midFrames([24, 28, 32, 36, 40, 44, 47])).toEqual([26, 30, 34, 38, 42, 45]);
  });
});
