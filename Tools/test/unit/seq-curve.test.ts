import { describe, it, expect } from "vitest";
import { channelDiff } from "../../src/tools/seq-curve.js";

describe("channelDiff", () => {
  it("wraps rotation channels and not others", () => {
    expect(channelDiff("Rotation.Z", -135, 225)).toBe(0); // live: cycle_with_offset 225 reads back as -135
    expect(channelDiff("Rotation.Z", 359, 1)).toBe(2);
    expect(channelDiff("Location.X", 359, 1)).toBe(358);
  });
});
