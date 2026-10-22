import { describe, it, expect } from "vitest";
import { angleDiff, controlMismatches, facingOf, parsePoseOutput, posingScript } from "../../src/tools/posing.js";

describe("posing helpers", () => {
  it("angleDiff wraps to [-180, 180)", () => {
    expect(angleDiff(-90, 270)).toBeCloseTo(0);
    expect(angleDiff(179, -179)).toBeCloseTo(-2);
    expect(angleDiff(-90, -68)).toBeCloseTo(-22);
  });

  it("facingOf prefers shoulders, falls back to toes", () => {
    expect(facingOf({ ok: true, facing: { shoulders: -68, toes: -63 } })).toBe(-68);
    expect(facingOf({ ok: true, facing: { toes: 12 } })).toBe(12);
    expect(facingOf({ ok: true })).toBeNull();
  });

  it("controlMismatches flags only real differences", () => {
    expect(controlMismatches({ control: "a", rotation: [10, -30, 0] }, { rotation: [10, 330, 0] })).toEqual([]);
    expect(controlMismatches({ control: "a", location: [1, 2, 3] }, { location: [1, 2, 3.5] })).toHaveLength(1);
    expect(controlMismatches({ control: "s", value: true }, { value: false })).toHaveLength(1);
    expect(controlMismatches({ control: "f", value: 0.5 }, { value: 0.5 })).toEqual([]);
    expect(controlMismatches({ control: "x", value: 1 }, undefined)).toEqual(["no readback"]);
  });

  it("parsePoseOutput finds the sentinel among UE warnings", () => {
    const r = parsePoseOutput('<string>:1: DeprecationWarning: x\n__POSE__{"ok": true, "n": 3}\n');
    expect(r).toEqual({ ok: true, n: 3 });
    expect(parsePoseOutput("nothing").ok).toBe(false);
  });

  it("posingScript embeds the lib and base64 params", () => {
    const s = posingScript("read_pose(**P)", { seq: "/Game/X", quote: "it's \"q\"" });
    expect(s).not.toMatch(/\.py\s/); // UE would treat the command as a file path
    const lib = /exec\(_b64\.b64decode\("([^"]+)"\)/.exec(s)![1];
    expect(Buffer.from(lib, "base64").toString("utf-8")).toContain("def read_pose(");
    expect(s).toContain("_res = read_pose(**P)");
    const b64 = /P = _json\.loads\(_b64\.b64decode\("([^"]+)"\)/.exec(s)![1];
    expect(JSON.parse(Buffer.from(b64, "base64").toString("utf-8")).quote).toBe("it's \"q\"");
  });
});

import { retargetVerdict } from "../../src/tools/retarget.js";

describe("retarget verdict (thresholds calibrated live 2026-10-21)", () => {
  it("passes the good Manny->girl retarget and fails the known-broken / wrong-clip cases", () => {
    expect(retargetVerdict({ ok: true, mean_motion_err_deg: 3.39, pelvis_height_max_diff: 0.0 }).ok).toBe(true);
    expect(retargetVerdict({ ok: true, mean_motion_err_deg: 3.39, pelvis_height_max_diff: 1.185 }).ok).toBe(false);
    expect(retargetVerdict({ ok: true, mean_motion_err_deg: 11.77, pelvis_height_max_diff: 0.0 }).ok).toBe(false);
    expect(retargetVerdict({ ok: false, error: "x" }).reasons).toEqual(["x"]);
    // Aligned retarget pose: motion error (vs each skeleton's own ref pose) rises while absolute angles match.
    expect(retargetVerdict({ ok: true, mean_motion_err_deg: 7.5, mean_abs_angle_deg: 0.82, pelvis_height_max_diff: 0 }).ok).toBe(true);
    expect(retargetVerdict({ ok: true, mean_motion_err_deg: 11.77, mean_abs_angle_deg: 20, pelvis_height_max_diff: 0 }).ok).toBe(false);
  });
});
