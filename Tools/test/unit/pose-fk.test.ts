import { describe, it, expect } from "vitest";
import { fkError, qAngle, qmul } from "../../src/tools/pose-fk.js";

const rx = (deg: number) => [Math.sin((deg * Math.PI) / 360), 0, 0, Math.cos((deg * Math.PI) / 360)];

describe("pose_fk quaternion checks", () => {
  it("qmul composes rotations about one axis additively", () => {
    expect(qAngle(qmul(rx(20), rx(40)), rx(60))).toBeCloseTo(0, 6);
  });
  it("fkError accepts base * ctrl and rejects ctrl * base (live: upperarm roll -60, dot 1.0 vs 0.93)", () => {
    const base = [-0.1129958171525243, 0.1614191559964468, -0.330629789756035, 0.922962482178614];
    const measured = [0.3636239929138394, -0.02552180512765143, -0.36704337517485774, 0.855806864882884];
    expect(fkError(base, rx(60), measured)).toBeLessThan(0.01);
    expect(qAngle(qmul(rx(60), base), measured)).toBeGreaterThan(20);
  });
});
