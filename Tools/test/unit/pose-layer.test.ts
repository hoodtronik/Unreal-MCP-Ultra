import { describe, it, expect } from "vitest";
import { boneRegion, editedRegions, regionDiff } from "../../src/tools/pose-layer.js";

describe("pose_layer regions", () => {
  it("classifies Mannequin bones by body region and side", () => {
    expect(boneRegion("calf_l")).toBe("legs");
    expect(boneRegion("ball_r")).toBe("legs");
    expect(boneRegion("spine_01")).toBe("spine");
    expect(boneRegion("neck_02")).toBe("head");
    expect(boneRegion("hand_r")).toBe("arm_r");
    expect(boneRegion("index_02_l")).toBe("arm_l");
    expect(boneRegion("ik_hand_r")).toBe("other");
  });
  it("finds the worst bone per region and counts rotation-only edits (head turn)", () => {
    const id = [0, 0, 0, 1];
    const yaw30 = [0, 0, Math.sin(Math.PI / 12), Math.cos(Math.PI / 12)];
    const clip = { calf_l: { c: [0, 0, 50], q: id }, head: { c: [0, 0, 160], q: id } };
    const lay = { calf_l: { c: [1.2, 0, 50], q: id }, head: { c: [0, 0, 160], q: yaw30 } };
    const d = regionDiff(clip, lay);
    expect(d.legs.cm).toBeCloseTo(1.2, 6); // live: unswitched IK legs swung the knee 1.2 cm
    expect(d.head.cm).toBe(0);
    expect(d.head.deg).toBeCloseTo(30, 6);
    expect(editedRegions([d])).toEqual(["legs", "head"]);
  });
});
