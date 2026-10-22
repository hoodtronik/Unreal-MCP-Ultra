import { describe, it, expect } from "vitest";
import { shotAt } from "../../src/tools/master.js";

describe("shotAt", () => {
  const shots = [
    { sequence: "/Game/A", start: 0, end: 48, offset: 0 },
    { sequence: "/Game/B", start: 48, end: 88, offset: 6000 }, // 6-frame head trim at 1000 ticks/frame
  ];
  it("maps master frames to the shot and its local frame (head trim included)", () => {
    expect(shotAt(shots, 10)).toEqual({ sequence: "/Game/A", local: 10 });
    expect(shotAt(shots, 60)).toEqual({ sequence: "/Game/B", local: 18 }); // live: walker at y -75 = local 18
    expect(shotAt(shots, 88)).toBeNull();
  });
});
