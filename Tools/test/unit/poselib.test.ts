import { describe, expect, it } from "vitest";
import { boneDiff, mirrorCheck } from "../../src/tools/poselib.js";

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

describe("mirrorCheck", () => {
  const want = { pelvis: [0, 0, 90], hand_l: [40, 5, 160], ik_hand_gun: [-40, 5, 160] };
  it("ignores unskinned ik_ bones (no partner) and passes an exact mirror", () => {
    const c = mirrorCheck(want, { pelvis: [0, 0, 90], hand_l: [40.1, 5, 160], ik_hand_gun: [99, 0, 0] });
    expect(c.ok).toBe(true);
    expect(c.compared).toBe(2);
  });
  it("fails past the tolerance", () => {
    expect(mirrorCheck(want, { pelvis: [0, 0, 90], hand_l: [-40, 5, 160] }).ok).toBe(false);
  });
  it("fails on reflected (inside-out) bones even when every position matches", () => {
    const c = mirrorCheck(want, { pelvis: [0, 0, 90], hand_l: [40, 5, 160] }, ["hand_l"]);
    expect(c.max).toBe(0);
    expect(c.ok).toBe(false);
  });
  it("fails when a bone is missing from the readback", () => {
    expect(mirrorCheck(want, { pelvis: [0, 0, 90] }).ok).toBe(false);
  });
});
