import { describe, it, expect } from "vitest";
import { trailStats } from "../../src/tools/pose-trail.js";

describe("trailStats", () => {
  it("measures a steady path and flags a snapping frame as a pop", () => {
    const frames = Array.from({ length: 10 }, (_, i) => i);
    const steady = frames.map((f) => [0, f * 12.5, 100]); // 300 cm/s at 24 fps (live walk head: 304 cm/s)
    const s = trailStats(steady, frames, 24);
    expect(s.meanSpeed).toBeCloseTo(300, 1);
    expect(s.pops).toEqual([]);
    const snap = steady.map((p, i) => (i >= 6 ? [p[0], p[1] + 60, p[2]] : p)); // 60 cm jump into frame 6
    expect(trailStats(snap, frames, 24).pops).toEqual([6]);
  });
});
