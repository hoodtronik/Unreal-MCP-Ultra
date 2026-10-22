import { describe, it, expect } from "vitest";
import { activeAt, sampleFrames, constraintChecks, type PairSample } from "../../src/tools/seq-constrain.js";

const keys: [number, boolean][] = [[20, true], [40, false]];
const s = (frame: number, child: number[], parent: number[], rel = [0, 0, 0]): PairSample => ({ frame, child, parent, rel, rel_rot: [0, 0, 0] });

describe("activeAt / sampleFrames", () => {
  it("is off before the first key and follows the keys", () => {
    expect(activeAt(keys, 0)).toBe(false);
    expect(activeAt(keys, 20)).toBe(true);
    expect(activeAt(keys, 39)).toBe(true);
    expect(activeAt(keys, 40)).toBe(false);
  });
  it("samples around keys and inside the span", () => {
    const f = sampleFrames(keys, 56);
    expect(f).toContain(18);
    expect(f).toContain(42);
    expect(f).toContain(30);
    expect(f).not.toContain(0);
  });
});

describe("constraintChecks", () => {
  it("passes a carried prop (live: drift 0, no pop)", () => {
    const v = constraintChecks("parent", keys, [
      s(19, [0, 0, 89], [1, 2, 90]), s(20, [0, 0, 89], [0, 0, 89]), s(21, [0, 4, 88], [0, 4, 88]), s(40, [0, 9, 87], [0, 9, 87]), s(41, [0, 9, 87], [0, 21, 87]),
    ]);
    expect(v.bad).toBe(0);
  });
  it("flags the 40 cm snap of maintainOffset:false (live negative control)", () => {
    const v = constraintChecks("parent", keys, [s(19, [0, 0, 129], [0, 0, 92]), s(20, [0, 0, 89], [0, 2.8, 89])]);
    expect(v.bad).toBe(1);
  });
  it("flags a child that stops following", () => {
    const v = constraintChecks("parent", keys, [s(20, [0, 0, 0], [0, 0, 0], [0, 0, 0]), s(26, [0, 0, 0], [0, 50, 0], [0, -50, 0])]);
    expect(v.bad).toBeGreaterThan(0);
  });
  it("look_at: fails a 40 deg misaim (the axis bug)", () => {
    expect(constraintChecks("look_at", [[0, true]], [s(0, [0, 0, 0], [1, 0, 0], [39.9, 0, 0])]).bad).toBe(1);
    expect(constraintChecks("look_at", [[0, true]], [s(0, [0, 0, 0], [1, 0, 0], [0, 0, 0])]).bad).toBe(0);
  });
});
