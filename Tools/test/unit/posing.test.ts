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
