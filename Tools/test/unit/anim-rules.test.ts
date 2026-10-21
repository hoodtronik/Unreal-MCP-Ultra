import { describe, it, expect } from "vitest";
import { ruleFunction, joinMarks, decideState, STATE_MATCH_CM } from "../../src/tools/anim-rules.js";
import { compileSummary } from "../../src/tools/anim-guard.js";

describe("ruleFunction", () => {
  it("maps float and int comparisons to KismetMathLibrary", () => {
    expect(ruleFunction(">", "float").fn).toBe("Greater_DoubleDouble");
    expect(ruleFunction("<=", "int").fn).toBe("LessEqual_IntInt");
    expect(ruleFunction("!=", "float").fn).toBe("NotEqual_DoubleDouble");
  });
  it("wires bools directly or through Not", () => {
    expect(ruleFunction("true", "bool")).toEqual({ fn: null });
    expect(ruleFunction("false", "bool").fn).toBe("Not_PreBool");
  });
  it("rejects mismatched op and type", () => {
    expect(ruleFunction(">", "bool").error).toBeTruthy();
    expect(ruleFunction("true", "float").error).toBeTruthy();
  });
});

describe("joinMarks", () => {
  const marks = [{ name: "N_0", crossfade: 0.2, mark: 9000 }, { name: "N_1", crossfade: 0.3, mark: 9001 }];
  it("joins by crossfade marker, not by order", () => {
    const nodes = [
      { nodeType: "AnimTransition", fromState: "Walk", toState: "Idle", crossfadeDuration: 9001 },
      { nodeType: "AnimState", stateName: "Idle" },
      { nodeType: "AnimTransition", fromState: "Idle", toState: "Walk", crossfadeDuration: 9000 },
    ];
    const j = joinMarks(marks, nodes);
    expect(j[0]).toMatchObject({ name: "N_0", from: "Idle", to: "Walk", crossfade: 0.2 });
    expect(j[1]).toMatchObject({ name: "N_1", from: "Walk", to: "Idle", crossfade: 0.3 });
  });
  it("leaves unmatched nodes without from/to (crossfade still restorable)", () => {
    expect(joinMarks(marks, [])[0]).toMatchObject({ name: "N_0", crossfade: 0.2, from: undefined });
  });
});

describe("decideState", () => {
  const sc = { Idle: "/A/MM_Idle", Walk: "/A/Walk" };
  it("picks the closest clip within tolerance", () => {
    expect(decideState(sc, { "/A/MM_Idle": { cm: 34 }, "/A/Walk": { cm: 1.2 } }).state).toBe("Walk");
  });
  it("returns null when no clip matches (mid-blend or unknown pose)", () => {
    expect(decideState(sc, { "/A/MM_Idle": { cm: STATE_MATCH_CM + 5 }, "/A/Walk": { cm: 12 } }).state).toBeNull();
  });
});

describe("compileSummary", () => {
  it("treats a transition that can never fire as unwired", () => {
    const s = compileSummary({ isValid: false, warnings: [{ graph: "SM", nodeTitle: "Walk to Idle", message: "Walk to Idle will never be taken, please connect something to Can Enter Transition" }] });
    expect(s.ok).toBe(false);
    expect(s.lines[0]).toMatch(/UNWIRED/);
  });
});
