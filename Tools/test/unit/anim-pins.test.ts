import { describe, it, expect } from "vitest";
import { pinDefaultFromText } from "../../src/tools/animation-mutation.js";

describe("pinDefaultFromText", () => {
  it("turns UE struct text into pin default text", () => {
    expect(pinDefaultFromText("(X=-35.000000,Y=25.000000,Z=150.000000)")).toBe("-35,25,150"); // live: hand at (-35,25,150)
    expect(pinDefaultFromText("(Pitch=10.000000,Yaw=20.000000,Roll=0.000000)")).toBe("10,20,0");
    expect(pinDefaultFromText("True")).toBe("true");
    expect(pinDefaultFromText("0.5")).toBe("0.5");
    expect(pinDefaultFromText('((BranchFilters=((BoneName="spine_01"))))')).toBe('((BranchFilters=((BoneName="spine_01"))))');
  });
});
