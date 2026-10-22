import { describe, it, expect } from "vitest";
import { montageTimeAt, type Segment } from "../../src/tools/montage.js";

const seg = (anim: string, startPos: number, animStart: number, animEnd: number, rate = 1, loops = 1): Segment =>
  ({ anim, startPos, animStart, animEnd, rate, loops, length: ((animEnd - animStart) / rate) * loops });

describe("montageTimeAt", () => {
  it("maps positions across trimmed segments laid end to end", () => {
    const s = [seg("/Game/A.A", 0, 0.5, 1.5), seg("/Game/B.B", 1, 0, 2)];
    expect(montageTimeAt(s, 0.25)).toEqual({ anim: "/Game/A", t: 0.75 });
    expect(montageTimeAt(s, 1.5)).toEqual({ anim: "/Game/B", t: 0.5 });
    expect(montageTimeAt(s, 3.5)).toBeNull();
  });
  it("applies play rate and wraps looping segments", () => {
    const s = [seg("/Game/W.W", 0, 0, 1, 2, 3)]; // 1 s clip at 2x, 3 loops -> 1.5 s
    expect(montageTimeAt(s, 0.25)!.t).toBeCloseTo(0.5, 6);
    expect(montageTimeAt(s, 0.75)!.t).toBeCloseTo(0.5, 6); // second loop
  });
});
