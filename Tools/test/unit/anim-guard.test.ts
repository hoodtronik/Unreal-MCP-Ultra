import { describe, expect, it } from "vitest";
import { compileSummary } from "../../src/tools/anim-guard.js";

// Shapes taken from live /api/validate-blueprint answers on UE 5.6.1 (ABP_Lab, ABP_Unwired).
const unwiredRoot = { isValid: true, warningCount: 2, errors: [], warnings: [
  { graph: "AnimGraph", nodeTitle: "Output Pose\nAnimGraph", message: "Result  was visible but ignored" },
  { source: "log", message: "[AssetLog] x.uasset: [Compiler] Result was visible but ignored" },
] };

describe("compileSummary", () => {
  it("clean compile is OK", () => {
    expect(compileSummary({ isValid: true, errors: [], warnings: [] }).ok).toBe(true);
  });
  it("an unwired Output Pose is an error even though the compiler only warns", () => {
    const s = compileSummary(unwiredRoot);
    expect(s.ok).toBe(false);
    expect(s.lines[0]).toContain("UNWIRED GRAPH");
    expect(s.lines.filter((l) => l.includes("visible but ignored"))).toHaveLength(1); // [log] duplicate dropped
  });
  it("warnings the step expects are reported as incomplete, not errors", () => {
    const s = compileSummary({ isValid: true, errors: [], warnings: [
      { graph: "Locomotion", nodeTitle: "Output Animation Pose", message: "Result was visible but ignored" }] },
      [/^\[Locomotion\] Output Animation Pose/i]);
    expect(s.ok).toBe(true);
    expect(s.lines.join("\n")).toContain("incomplete");
  });
  it("compiler errors and isValid=false fail", () => {
    expect(compileSummary({ isValid: true, errors: ["bad pin"], warnings: [] }).ok).toBe(false);
    expect(compileSummary({ isValid: false, errors: [], warnings: [] }).ok).toBe(false);
  });
});
