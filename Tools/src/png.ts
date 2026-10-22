import { inflateSync } from "node:zlib";

// CLAUDE-NOTE (2026-10-22): a minimal PNG reader (8-bit greyscale / RGB / RGBA, non-interlaced - what Movie Render
// Queue and viewport captures write) so render checks can measure pixels without adding an image dependency. Used to
// prove render passes differ (lit vs unlit vs lighting-only...) and to measure clipping / exposure.

export type Image = { width: number; height: number; channels: number; data: Uint8Array };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(buf: Buffer): Image {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8, width = 0, height = 0, depth = 0, color = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      depth = body[8]; color = body[9]; interlace = body[12];
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const channels = color === 0 ? 1 : color === 2 ? 3 : color === 4 ? 2 : color === 6 ? 4 : 0;
  if (depth !== 8 || !channels || interlace) throw new Error(`unsupported PNG (depth ${depth}, colour type ${color}, interlace ${interlace})`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      out[y * stride + x] = (v + (f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c))) & 255;
    }
  }
  return { width, height, channels, data: out };
}

export type Stats = { mean: number; std: number; clipped: number; dark: number; colours: number };

/** Luma statistics over a region (fractions 0..1 of the frame), sampled every `step` pixels. */
export function imageStats(img: Image, region: [number, number, number, number] = [0, 0, 1, 1], step = 2): Stats {
  const [x0, y0, x1, y1] = [Math.floor(region[0] * img.width), Math.floor(region[1] * img.height), Math.ceil(region[2] * img.width), Math.ceil(region[3] * img.height)];
  let n = 0, sum = 0, sum2 = 0, clip = 0, dark = 0;
  const seen = new Set<number>();
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * img.width + x) * img.channels;
      const r = img.data[i], g = img.channels >= 3 ? img.data[i + 1] : r, b = img.channels >= 3 ? img.data[i + 2] : r;
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += l; sum2 += l * l; n++;
      if (l >= 250) clip++;
      if (l <= 5) dark++;
      if (seen.size < 5000) seen.add((r << 16) | (g << 8) | b);
    }
  }
  const mean = sum / Math.max(1, n);
  return { mean: +mean.toFixed(2), std: +Math.sqrt(Math.max(0, sum2 / Math.max(1, n) - mean * mean)).toFixed(2),
    clipped: +(clip / Math.max(1, n)).toFixed(4), dark: +(dark / Math.max(1, n)).toFixed(4), colours: seen.size };
}

/** Mean absolute luma difference between two images of the same size (sampled). */
export function lumaDiff(a: Image, b: Image, step = 2): number {
  if (a.width !== b.width || a.height !== b.height) return Infinity;
  let n = 0, s = 0;
  for (let y = 0; y < a.height; y += step) {
    for (let x = 0; x < a.width; x += step) {
      const ia = (y * a.width + x) * a.channels, ib = (y * b.width + x) * b.channels;
      const la = 0.2126 * a.data[ia] + 0.7152 * a.data[ia + (a.channels >= 3 ? 1 : 0)] + 0.0722 * a.data[ia + (a.channels >= 3 ? 2 : 0)];
      const lb = 0.2126 * b.data[ib] + 0.7152 * b.data[ib + (b.channels >= 3 ? 1 : 0)] + 0.0722 * b.data[ib + (b.channels >= 3 ? 2 : 0)];
      s += Math.abs(la - lb); n++;
    }
  }
  return +(s / Math.max(1, n)).toFixed(2);
}
