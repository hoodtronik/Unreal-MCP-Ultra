import { describe, it, expect } from "vitest";
import { tweenFraction } from "../../src/tools/pose-tween.js";

describe("tweenFraction", () => {
  it("maps the Tween tool value [-1, 1] to the fraction prev -> next (measured live)", () => {
    expect(tweenFraction(-1)).toBe(0);
    expect(tweenFraction(0)).toBe(0.5);
    expect(tweenFraction(1)).toBe(1);
    expect(tweenFraction(0.5)).toBe(0.75); // hand z -17.014 -> 45.399 keyed 29.796
    expect(tweenFraction(-0.4)).toBeCloseTo(0.3, 10);
  });
});
