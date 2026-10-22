import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
import { decodePng, imageStats, lumaDiff } from "../../src/png.js";
import { exrLayers, wavSpan } from "../../src/tools/render-passes.js";

function crc32(b: Buffer): number {
  let c = ~0;
  for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** 2x2 RGB PNG, row 0 filter Sub, row 1 filter Up (exercises the unfilter paths). */
function png2x2(): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2;
  // pixels: (10,20,30) (40,60,90) / (10,20,30) (250,250,250)
  const raw = Buffer.from([1, 10, 20, 30, 30, 40, 60, 2, 0, 0, 0, 210, 190, 160]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

describe("png decoder", () => {
  it("decodes 8-bit RGB with Sub and Up filters", () => {
    const im = decodePng(png2x2());
    expect([im.width, im.height, im.channels]).toEqual([2, 2, 3]);
    expect(Array.from(im.data)).toEqual([10, 20, 30, 40, 60, 90, 10, 20, 30, 250, 250, 250]);
    const s = imageStats(im, [0, 0, 1, 1], 1);
    expect(s.clipped).toBe(0.25);
    expect(lumaDiff(im, im, 1)).toBe(0);
  });
});

describe("exrLayers / wavSpan", () => {
  it("reads layer names from an EXR channel list", () => {
    const ch = (n: string) => Buffer.concat([Buffer.from(n + "\0", "latin1"), Buffer.alloc(16)]);
    const list = Buffer.concat([ch("A"), ch("B"), ch("PathTracer.R"), ch("FinalImageMovieRenderQueue_WorldDepth.R"), Buffer.from([0])]);
    const size = Buffer.alloc(4); size.writeInt32LE(list.length);
    const head = Buffer.alloc(8); head.writeUInt32LE(20000630, 0); head.writeUInt32LE(2, 4);
    const buf = Buffer.concat([head, Buffer.from("channels\0chlist\0", "latin1"), size, list, Buffer.from([0])]);
    expect(exrLayers(buf).sort()).toEqual(["(rgba)", "FinalImageMovieRenderQueue_WorldDepth", "PathTracer"]);
  });
  it("finds where sound starts and stops in a 16-bit WAV", () => {
    const rate = 1000, frames = 2000; // 1 s silence, 0.5 s tone, 0.5 s silence
    const data = Buffer.alloc(frames * 2);
    for (let i = 1000; i < 1500; i++) data.writeInt16LE(Math.round(Math.sin(i) * 8000), i * 2);
    const h = Buffer.alloc(44);
    h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write("data", 36); h.writeUInt32LE(data.length, 40);
    const w = wavSpan(Buffer.concat([h, data]));
    expect(w.seconds).toBe(2);
    expect(w.soundFrom).toBe(1);
    expect(w.soundTo).toBe(1.5);
  });
});

import { regionColour, sharpness } from "../../src/png.js";
import { boxRegion, outsideSharpness } from "../../src/tools/shot-look.js";

describe("shot_look metrics", () => {
  it("measures chroma, sharpness and maps screen boxes", () => {
    const flat = { width: 4, height: 4, channels: 3, data: new Uint8Array(48).fill(100) };
    expect(sharpness(flat)).toBe(0);
    const chk = { width: 4, height: 4, channels: 3, data: new Uint8Array(48).map((_, i) => ((Math.floor(i / 3) % 4) + Math.floor(i / 12)) % 2 ? 200 : 0) };
    expect(sharpness(chk)).toBeGreaterThan(500);
    const red = { width: 2, height: 2, channels: 3, data: new Uint8Array([200, 0, 0, 200, 0, 0, 200, 0, 0, 200, 0, 0]) };
    expect(regionColour(red, [0, 0, 1, 1], 1)).toMatchObject({ r: 200, g: 0, b: 0, chroma: 200 });
    expect(boxRegion([-0.5, 0.5], [-1, 0.5])).toEqual([0.25, 0.25, 0.75, 1]);
    expect(outsideSharpness(2, 4, [0, 0, 0.5, 1])).toBe(0);
  });
});

import { halves } from "../../src/tools/shot-light.js";

describe("shot_light halves", () => {
  it("splits a region into screen-left / screen-right", () => {
    expect(halves([0.2, 0.1, 0.6, 0.9])).toEqual([[0.2, 0.1, 0.4, 0.9], [0.4, 0.1, 0.6, 0.9]]);
  });
});
