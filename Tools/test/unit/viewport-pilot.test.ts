import { describe, it, expect } from "vitest";
import { xformGap } from "../../src/tools/viewport-pilot.js";

describe("xformGap", () => {
  it("measures location and wrapped rotation gaps", () => {
    const g = xformGap({ location: [0, 0, 0], rotation: [0, 179, 0] }, { location: [3, 4, 0], rotation: [0, -179, 0] });
    expect(g.cm).toBeCloseTo(5);
    expect(g.deg).toBeCloseTo(2);
  });
});
