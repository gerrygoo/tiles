// Perspective rectification and multi-tile combining.
//
// The user marks the four outer corners of a block of cols × rows tiles. Each tile cell is
// mapped back to a flat size × size square through the homography of that quad, then the
// cells are lined up (a wall often has tiles laid at different quarter turns) and merged
// with a per-pixel median, which drops glare, dirt and chips that only hit one tile.

import { makeImg, type Img } from './image.ts';

export type Pt = [number, number];
/** Corners in order: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Pt, Pt, Pt, Pt];

/** Coefficients [a,b,c,d,e,f,g,h] with x = (a u + b v + c) / (g u + h v + 1), y = (d u + e v + f) / (…).
 * Maps the unit square (u, v ∈ [0, 1]) onto the quad (Heckbert's square-to-quad). */
export function squareToQuad(q: Quad): number[] {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den;
    h = (dx1 * sy - sx * dy1) / den;
  }
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
}

export function mapPoint(H: number[], u: number, v: number): Pt {
  const w = H[6] * u + H[7] * v + 1;
  return [(H[0] * u + H[1] * v + H[2]) / w, (H[3] * u + H[4] * v + H[5]) / w];
}

/** Bilinear sample at continuous pixel coordinates (pixel centres at +0.5). */
function sample(src: Img, x: number, y: number, out: Float32Array): void {
  const { width: W, height: H, data } = src;
  const fx = Math.min(Math.max(x - 0.5, 0), W - 1);
  const fy = Math.min(Math.max(y - 0.5, 0), H - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1);
  const ax = fx - x0, ay = fy - y0;
  const i00 = (y0 * W + x0) * 4, i10 = (y0 * W + x1) * 4, i01 = (y1 * W + x0) * 4, i11 = (y1 * W + x1) * 4;
  for (let c = 0; c < 3; c++) {
    const top = data[i00 + c] * (1 - ax) + data[i10 + c] * ax;
    const bot = data[i01 + c] * (1 - ax) + data[i11 + c] * ax;
    out[c] += top * (1 - ay) + bot * ay;
  }
}

/** Warps the (u0,v0)–(u1,v1) part of the quad's unit square to a flat size × size image.
 * ss × ss supersampling per output pixel keeps a big photo from aliasing when shrunk. */
export function warpRegion(src: Img, H: number[], u0: number, v0: number, u1: number, v1: number, size: number, ss = 2): Img {
  const out = makeImg(size, size);
  const acc = new Float32Array(3);
  const n = ss * ss;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      acc.fill(0);
      for (let b = 0; b < ss; b++) {
        for (let a = 0; a < ss; a++) {
          const u = u0 + ((i + (a + 0.5) / ss) / size) * (u1 - u0);
          const v = v0 + ((j + (b + 0.5) / ss) / size) * (v1 - v0);
          const [x, y] = mapPoint(H, u, v);
          sample(src, x, y, acc);
        }
      }
      const o = (j * size + i) * 4;
      out.data[o] = acc[0] / n;
      out.data[o + 1] = acc[1] / n;
      out.data[o + 2] = acc[2] / n;
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** One flat image per tile cell, row-major. `trim` (0–0.2) is cut off every side of each
 * cell, to drop grout lines and bevelled edges. `pad` extra pixels are kept around each
 * trimmed cell (reaching into grout and neighbours), so the align step can shift, turn and
 * zoom the crop without going back to the photo: images are size + 2·pad square. */
export function extractTiles(src: Img, quad: Quad, cols: number, rows: number, size: number, trim = 0, pad = 0): Img[] {
  const H = squareToQuad(quad);
  const padU = ((1 - 2 * trim) / cols) * (pad / size), padV = ((1 - 2 * trim) / rows) * (pad / size);
  const tiles: Img[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const u0 = (c + trim) / cols - padU, v0 = (r + trim) / rows - padV;
      const u1 = (c + 1 - trim) / cols + padU, v1 = (r + 1 - trim) / rows + padV;
      tiles.push(warpRegion(src, H, u0, v0, u1, v1, size + 2 * pad));
    }
  }
  return tiles;
}

// ---- the square's symmetry group (D4) --------------------------------------------------

/** For op k, where output pixel (x, y) reads from in an m+1 sized square. */
export const OPS: ((x: number, y: number, m: number) => Pt)[] = [
  (x, y) => [x, y], // 0 identity
  (x, y, m) => [y, m - x], // 1 quarter turn clockwise
  (x, y, m) => [m - x, m - y], // 2 half turn
  (x, y, m) => [m - y, x], // 3 quarter turn counter-clockwise
  (x, y, m) => [m - x, y], // 4 mirror left-right
  (x, y, m) => [x, m - y], // 5 mirror top-bottom
  (x, y) => [y, x], // 6 mirror on the main diagonal
  (x, y, m) => [m - y, m - x], // 7 mirror on the other diagonal
];

export const ROT_CW = 1;
export const ROT_CCW = 3;

/** Applies one D4 op to a square image. */
export function transform(img: Img, op: number): Img {
  const n = img.width, m = n - 1;
  const out = makeImg(n, n);
  const f = OPS[op];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const [sx, sy] = f(x, y, m);
      const s = (sy * n + sx) * 4, o = (y * n + x) * 4;
      out.data[o] = img.data[s];
      out.data[o + 1] = img.data[s + 1];
      out.data[o + 2] = img.data[s + 2];
      out.data[o + 3] = 255;
    }
  }
  return out;
}

export type Symmetry = 'none' | 'mirror-x' | 'mirror-y' | 'mirror-xy' | 'diagonal' | 'rot2' | 'rot4' | 'd4';

export const SYMMETRY_OPS: Record<Symmetry, number[]> = {
  none: [0],
  'mirror-x': [0, 4],
  'mirror-y': [0, 5],
  'mirror-xy': [0, 2, 4, 5],
  diagonal: [0, 6],
  rot2: [0, 2],
  rot4: [0, 1, 2, 3],
  d4: [0, 1, 2, 3, 4, 5, 6, 7],
};

function median(buf: Uint8Array | Float32Array, n: number): number {
  for (let i = 1; i < n; i++) {
    const v = buf[i];
    let j = i - 1;
    while (j >= 0 && buf[j] > v) {
      buf[j + 1] = buf[j];
      j--;
    }
    buf[j + 1] = v;
  }
  return n & 1 ? buf[n >> 1] : (buf[(n >> 1) - 1] + buf[n >> 1]) / 2;
}

/** Forces a symmetry on the tile: every pixel becomes the median of its images under the
 * group. Most decorative tiles are symmetric, so this also averages out photo noise. */
export function symmetrize(img: Img, mode: Symmetry): Img {
  const ops = SYMMETRY_OPS[mode].map((k) => OPS[k]);
  if (ops.length === 1) return img;
  const n = img.width, m = n - 1;
  const out = makeImg(n, n);
  const buf = new Uint8Array(ops.length);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const o = (y * n + x) * 4;
      for (let c = 0; c < 3; c++) {
        for (let k = 0; k < ops.length; k++) {
          const [sx, sy] = ops[k](x, y, m);
          buf[k] = img.data[(sy * n + sx) * 4 + c];
        }
        out.data[o + c] = median(buf, ops.length);
      }
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** Per-pixel, per-channel median of same-sized images. */
export function medianOf(imgs: Img[]): Img {
  if (imgs.length === 1) return imgs[0];
  const { width: w, height: h } = imgs[0];
  const out = makeImg(w, h);
  const buf = new Uint8Array(imgs.length);
  for (let i = 0; i < w * h * 4; i += 4) {
    for (let c = 0; c < 3; c++) {
      for (let k = 0; k < imgs.length; k++) buf[k] = imgs[k].data[i + c];
      out.data[i + c] = median(buf, imgs.length);
    }
    out.data[i + 3] = 255;
  }
  return out;
}

function thumb(img: Img, n: number): Float32Array {
  const s = img.width / n;
  const out = new Float32Array(n * n * 3);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const o = (Math.floor(y / s) * n + Math.floor(x / s)) * 3, i = (y * img.width + x) * 4;
      out[o] += img.data[i];
      out[o + 1] += img.data[i + 1];
      out[o + 2] += img.data[i + 2];
    }
  }
  return out;
}

function rotDist(a: Float32Array, b: Float32Array, n: number, op: number): number {
  const f = OPS[op], m = n - 1;
  let d = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const [sx, sy] = f(x, y, m);
      const i = (y * n + x) * 3, j = (sy * n + sx) * 3;
      d += Math.abs(a[i] - b[j]) + Math.abs(a[i + 1] - b[j + 1]) + Math.abs(a[i + 2] - b[j + 2]);
    }
  }
  return d;
}

/** Turns each tile (quarter turns only: a real tile can't be laid mirrored) to best match
 * the others, then returns their median and the turn picked for each tile. Two passes:
 * match against the first tile, then against the median of that first guess. */
export function combineTiles(tiles: Img[], align: boolean): { tile: Img; turns: number[] } {
  if (tiles.length === 1 || !align) return { tile: medianOf(tiles), turns: tiles.map(() => 0) };
  const N = 32;
  const th = tiles.map((t) => thumb(t, N));
  let ref = th[0];
  let turns: number[] = [];
  for (let pass = 0; pass < 2; pass++) {
    turns = th.map((t) => {
      let best = 0, bestD = Infinity;
      for (const op of [0, 1, 2, 3]) {
        const d = rotDist(ref, t, N, op);
        if (d < bestD) [best, bestD] = [op, d];
      }
      return best;
    });
    if (pass === 0) ref = thumb(medianOf(tiles.map((t, i) => transform(t, turns[i]))), N);
  }
  return { tile: medianOf(tiles.map((t, i) => (turns[i] ? transform(t, turns[i]) : t))), turns };
}
