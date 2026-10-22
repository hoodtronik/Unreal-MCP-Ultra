import { describe, it, expect } from "vitest";
import { impliedRate } from "../../src/tools/take-record.js";

describe("impliedRate", () => {
  it("reads rate 1 from the live walk take (clip time wraps at 1.5 s)", () => {
    const s = [[0.227, 0.875], [0.68, 1.333], [1.133, 0.283], [1.586, 0.742], [2.039, 1.192], [2.492, 0.142]].map(([t, clip_t]) => ({ t, clip_t }));
    expect(impliedRate(s, 1.5)).toBeCloseTo(1.0, 1);
  });
  it("reads half speed", () => {
    const s = [0, 0.4, 0.8, 1.2].map((t) => ({ t, clip_t: (t * 0.5) % 1.5 }));
    expect(impliedRate(s, 1.5)).toBeCloseTo(0.5, 3);
  });
});
