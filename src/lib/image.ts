/** RGBA pixels, same layout as DOM ImageData, so either can be passed in. */
export interface Img {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type RGB = [number, number, number];

export function makeImg(width: number, height: number): Img {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** sRGB 0–1 → linear light. Same as gb's `src/lib/palette.ts`. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) LIN[i] = srgbToLinear(i / 255);

function labF(t: number): number {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

/** sRGB bytes → CIE Lab (D65). Writes into out[o..o+2]. */
export function rgbToLab(r: number, g: number, b: number, out: Float32Array, o: number): void {
  const R = LIN[r], G = LIN[g], B = LIN[b];
  const fx = labF((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const fy = labF(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const fz = labF((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  out[o] = 116 * fy - 16;
  out[o + 1] = 500 * (fx - fy);
  out[o + 2] = 200 * (fy - fz);
}

export function labDist2(a: RGB, b: RGB): number {
  const la = new Float32Array(3), lb = new Float32Array(3);
  rgbToLab(a[0], a[1], a[2], la, 0);
  rgbToLab(b[0], b[1], b[2], lb, 0);
  return (la[0] - lb[0]) ** 2 + (la[1] - lb[1]) ** 2 + (la[2] - lb[2]) ** 2;
}

export function hex(c: RGB): string {
  return '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

export function fromHex(h: string): RGB {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Deterministic PRNG (mulberry32) so the same photo + settings gives the same tile. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
