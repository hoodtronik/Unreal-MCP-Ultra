import { describe, it, expect } from "vitest";
import { groupStills } from "../../src/tools/shot-stills.js";

describe("groupStills", () => {
  it("groups by camera and frame, cameras in numeric spawn order", () => {
    const g = groupStills(["S.CineCameraActor_23.0020.png", "S.CineCameraActor_20.0020.png", "S.CineCameraActor_22.0034.png",
      "S.CineCameraActor_20.0034.png", "Other.CineCameraActor_1.0001.png", "S.CineCameraActor_22.0020.png"], "S");
    expect(g.cameras).toEqual(["CineCameraActor_20", "CineCameraActor_22", "CineCameraActor_23"]);
    expect(g.byCam.CineCameraActor_20[34]).toBe("S.CineCameraActor_20.0034.png");
    expect(g.byCam.CineCameraActor_23[34]).toBeUndefined();
  });
});
