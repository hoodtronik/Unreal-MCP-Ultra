import { describe, expect, it } from "vitest";
import { countStances, footSkate, lockOffsets, type FootFrame } from "../../src/tools/walk.js";

// Synthetic walk: left ball planted f0-9 then swinging; right ball swinging then planted f10-19.
function walkFrames(slidePerFrame: number): FootFrame[] {
  const out: FootFrame[] = [];
  for (let f = 0; f < 20; f++) {
    const lDown = f < 10, rDown = f >= 10;
    out.push({ frame: f, bones: {
      ball_l: [lDown ? f * slidePerFrame : 10 * slidePerFrame + (f - 9) * 12, -10, lDown ? 0 : 8],
      ball_r: [rDown ? 100 + (f - 10) * slidePerFrame : f * 10, 10, rDown ? 0 : 8],
    } });
  }
  return out;
}

describe("foot QA", () => {
  it("planted feet at the right speed read as planted", () => {
    const s = footSkate(walkFrames(0.3));
    expect(s.map((x) => x.side)).toEqual(["l", "r"]);
    for (const x of s) {
      expect(x.mean).toBeCloseTo(0.3, 5);
      expect(x.stances).toBe(1);
      expect(x.planted).toBe(9);
    }
  });

  it("a wrong travel speed reads as skating (live: 100 cm/s off at 24 fps = 4.17 cm/frame)", () => {
    const s = footSkate(walkFrames(100 / 24));
    for (const x of s) expect(x.mean).toBeCloseTo(4.17, 2);
  });

  it("stance count merges threshold flicker and drops 1-2 frame touches", () => {
    expect(countStances([true, true, false, true, true, false, false, false, false, true])).toBe(1);
    expect(countStances([true, true, true, false, false, false, false, true, true, true])).toBe(2);
  });

  it("lockOffsets cancels only planted slides above the lock threshold, cumulatively", () => {
    const fr: FootFrame[] = [0, 1, 2, 3].map((f) => ({ frame: f, bones: { ball_l: [f === 2 ? 5 : f === 3 ? 5.2 : 0, 0, 0] } }));
    const off = lockOffsets(fr);
    expect(off).toEqual({ "2": [-5, 0] });
    // a second pass with nothing left to fix keeps the first pass
    const again = lockOffsets([0, 1, 2].map((f) => ({ frame: f, bones: { ball_l: [0, 0, 0] } })), off);
    expect(again).toEqual(off);
  });
});
