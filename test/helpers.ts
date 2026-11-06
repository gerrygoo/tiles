// Test-only helpers: a synthetic tile, a photographed wall of it, and a tiny PNG writer.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { makeImg, rng, type Img, type RGB } from '../src/lib/image.ts';
import { mapPoint, squareToQuad, type Quad } from '../src/lib/warp.ts';

export const COLORS: RGB[] = [
  [236, 228, 210], // cream glaze
  [32, 70, 140], // cobalt
  [190, 90, 50], // terracotta
  [60, 120, 80], // green
];

/** Ground-truth tile: label at (u, v) in [0,1]². Not rotationally symmetric (green dot). */
export function tileLabel(u: number, v: number): number {
  const x = u - 0.5, y = v - 0.5, r = Math.hypot(x, y);
  if (Math.hypot(u - 0.2, v - 0.2) < 0.06) return 3; // asymmetric mark
  if (Math.abs(x) + Math.abs(y) < 0.18) return 2; // centre diamond
  if (r > 0.25 && r < 0.36) return 1; // ring
  for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) if (Math.hypot(u - cx, v - cy) < 0.22) return 1; // corner quarter-circles
  return 0;
}

export function renderTile(size: number, rot = 0): { img: Img; labels: Uint8Array } {
  const img = makeImg(size, size), labels = new Uint8Array(size * size);
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      let u = (i + 0.5) / size, v = (j + 0.5) / size;
      for (let k = 0; k < rot; k++) [u, v] = [v, 1 - u];
      const L = tileLabel(u, v), c = COLORS[L], o = (j * size + i) * 4;
      labels[j * size + i] = L;
      img.data.set([...c, 255], o);
    }
  return { img, labels };
}

function invert3(H: number[]): number[] {
  const [a, b, c, d, e, f, g, h] = H, i = 1;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
}

/** A photo of a cols×rows wall seen through `quad`, tiles at quarter turns `turns`, with
 * grout, sensor noise and a glare blob on tile 0. */
export function renderWall(W: number, Hh: number, quad: Quad, cols: number, rows: number, turns: number[], seed = 3): Img {
  const M = invert3(squareToQuad(quad));
  const img = makeImg(W, Hh), rand = rng(seed);
  const grout = 0.03;
  for (let y = 0; y < Hh; y++)
    for (let x = 0; x < W; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w = M[6] * px + M[7] * py + M[8];
      const U = (M[0] * px + M[1] * py + M[2]) / w, V = (M[3] * px + M[4] * py + M[5]) / w;
      let c: number[] = [120, 115, 110]; // wall outside the tiles
      if (U >= 0 && U < 1 && V >= 0 && V < 1) {
        const ci = Math.floor(U * cols), rj = Math.floor(V * rows);
        let u = U * cols - ci, v = V * rows - rj;
        if (u < grout / 2 || v < grout / 2 || u > 1 - grout / 2 || v > 1 - grout / 2) c = [170, 165, 158];
        else {
          for (let k = 0; k < turns[rj * cols + ci]; k++) [u, v] = [v, 1 - u];
          c = COLORS[tileLabel(u, v)].slice();
          const shade = 0.85 + 0.15 * (1 - V); // uneven light
          c = c.map((ch) => ch * shade);
          if (ci === 0 && rj === 0 && Math.hypot(u - 0.65, v - 0.4) < 0.15) c = [250, 250, 250]; // glare
        }
      }
      const o = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) img.data[o + k] = c[k] + (rand() - 0.5) * 40;
      img.data[o + 3] = 255;
    }
  return img;
}

export { mapPoint };

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(b: Uint8Array): number {
  let c = -1;
  for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(Buffer.from(type, 'ascii'), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
export function writePNG(path: string, img: Img): void {
  const { width: w, height: h } = img;
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) raw.set(img.data.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 6, 0, 0, 0], 8);
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())]));
}
