import { describe, it, expect } from "vitest";
import { handheldNoise } from "../../src/tools/shot-shake.js";

describe("handheldNoise", () => {
  it("is deterministic, bounded and smooth at 24 fps", () => {
    const a = Array.from({ length: 48 }, (_, i) => handheldNoise(7, 2, i / 24, 1.2));
    const b = Array.from({ length: 48 }, (_, i) => handheldNoise(7, 2, i / 24, 1.2));
    expect(a).toEqual(b);
    expect(Math.max(...a.map(Math.abs))).toBeLessThanOrEqual(1);
    const step = Math.max(...a.slice(1).map((v, i) => Math.abs(v - a[i])));
    expect(step).toBeLessThan(0.6); // no frame-to-frame jumps
    expect(handheldNoise(8, 2, 0.5, 1.2)).not.toBeCloseTo(handheldNoise(7, 2, 0.5, 1.2), 3); // seed matters
  });
});
