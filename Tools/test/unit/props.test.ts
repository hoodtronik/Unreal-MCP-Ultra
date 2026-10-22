import { describe, expect, it } from "vitest";
import { bisect, fingerGap, gapFrom, maxAngleDiff, maxDiff, PRESS_CM, quatAngleDeg, WRAP, wrapCurl } from "../../src/tools/props.js";

describe("grip solve helpers", () => {
  const seg = { index_01: 1.2, index_02: -0.5, index_03: 0.3, thumb_01: 2 };

  it("gapFrom reads one segment, missing = no contact", () => {
    expect(gapFrom(seg, "index", 1)).toBe(-0.5);
    expect(gapFrom(seg, "pinky", 0)).toBe(Infinity);
  });

  it("fingerGap is the closest segment of the finger", () => {
    expect(fingerGap(seg, "index")).toBe(-0.5);
    expect(fingerGap(seg, "thumb")).toBe(2);
  });

  it("bisect keeps the largest non-penetrating curl", () => {
    expect(bisect(0, 90, 45, 0.4)).toEqual([45, 90]);             // clear -> curl more
    expect(bisect(0, 90, 45, -PRESS_CM)).toEqual([45, 90]);       // pad pressed within allowance
    expect(bisect(0, 90, 45, -PRESS_CM - 0.01)).toEqual([0, 45]); // penetrating -> curl less
  });

  it("bisection converges on the contact angle of a monotone gap", () => {
    const gapAt = (deg: number) => 3 - deg / 10; // contact at 30 + 10*PRESS_CM deg
    let [lo, hi] = [0, 90];
    for (let i = 0; i < 7; i++) {
      const mid = (lo + hi) / 2;
      [lo, hi] = bisect(lo, hi, mid, gapAt(mid));
    }
    expect(Math.abs(lo - (30 + 10 * PRESS_CM))).toBeLessThan(90 / 2 ** 7 + 1e-9);
  });

  it("wrapCurl spreads the curl as an even arc", () => {
    expect(wrapCurl(30)).toEqual(WRAP.map((r) => 30 * r));
  });
});

describe("prop_socket checks", () => {
  it("quatAngleDeg measures the turn between two rotations (sign-insensitive)", () => {
    const id = [0, 0, 0, 1];
    const yaw30 = [0, 0, Math.sin(Math.PI / 12), Math.cos(Math.PI / 12)];
    expect(quatAngleDeg(id, id)).toBeCloseTo(0, 6);
    expect(quatAngleDeg(id, yaw30)).toBeCloseTo(30, 6); // live: socket yaw +30 -> turned 30.00, moved 0.001 cm
    expect(quatAngleDeg(id, yaw30.map((v) => -v))).toBeCloseTo(30, 6);
  });
  it("maxAngleDiff compares rotator components modulo 360", () => {
    expect(maxAngleDiff([179.99, 0, -90], [-179.99, 0, 270])).toBeCloseTo(0.02, 6);
    expect(maxAngleDiff([10, 0, 0], [0, 0, 0])).toBe(10);
  });
  it("maxDiff is the largest per-component difference", () => {
    expect(maxDiff([1, 2, 3], [1, 2.5, 2])).toBe(1);
  });
});
