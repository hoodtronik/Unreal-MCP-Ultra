import { describe, it, expect } from "vitest";
import { fadeAt } from "../../src/tools/seq-tracks.js";

describe("fadeAt", () => {
  it("interpolates fade keys and holds outside", () => {
    const k = [[60, 0], [80, 1]];
    expect(fadeAt(k, 0)).toBe(0);
    expect(fadeAt(k, 70)).toBeCloseTo(0.5);
    expect(fadeAt(k, 99)).toBe(1);
  });
});
