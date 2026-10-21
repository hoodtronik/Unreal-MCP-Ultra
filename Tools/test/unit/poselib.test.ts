import { describe, expect, it } from "vitest";
import { boneDiff } from "../../src/tools/poselib.js";

describe("boneDiff", () => {
  it("identical poses compare every bone at 0", () => {
    const a = { pelvis: [0, 0, 90], hand_r: [-40, 5, 160] };
    const d = boneDiff(a, { ...a });
    expect(d.compared).toBe(2);
    expect(d.max).toBe(0);
  });
  it("finds the worst bone", () => {
    const d = boneDiff({ pelvis: [0, 0, 90], hand_r: [-40, 5, 160] }, { pelvis: [0, 0, 91], hand_r: [-40, 5, 150] });
    expect(d.worst).toBe("hand_r");
    expect(d.max).toBe(10);
  });
  it("no common bones -> compared 0 (must not read as a perfect match)", () => {
    expect(boneDiff({ a: [0, 0, 0] }, { b: [0, 0, 0] }).compared).toBe(0);
  });
});
