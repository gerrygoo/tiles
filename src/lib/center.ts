// Centring the tile for tiling.
//
// The corners a person drags are a few pixels off, so the flattened tile is slightly shifted,
// turned and squashed, and copies of it won't meet cleanly at the seams. Decorative tiles are
// almost always symmetric about their centre, so the crop is fitted to make the tile as
// symmetric as possible: shift (tx, ty), rotation and aspect are searched; zoom can't be told
// from symmetry and is left to the person (the repeat preview shows when the seams meet).
//
// Works on a padded flat tile: `size` core pixels plus `pad` pixels of context on every side
// (see extractTiles), so the fitted crop can reach beyond the original one.

import { makeImg, type Img } from './image.ts';
import { OPS, SYMMETRY_OPS, type Symmetry } from './warp.ts';

export interface Padded {
  img: Img;
  /** Core tile size in pixels. */
  size: number;
  /** Context pixels on each side; img is size + 2·pad square. */
  pad: number;
}

export interface Fit {
  /** Centre offset, as a fraction of the tile. */
  tx: number;
  ty: number;
  /** Degrees, clockwise. */
  rot: number;
  /** >1 zooms in (crop gets smaller). */
  zoom: number;
  /** Width/height stretch of the crop, 1 = square. */
  aspect: number;
}

export const NO_FIT: Fit = { tx: 0, ty: 0, rot: 0, zoom: 1, aspect: 1 };

/** Output pixel (i, j) of an n×n crop → source pixel in the padded image. */
function mapper(p: Padded, f: Fit, n: number) {
  const t = (f.rot * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const ax = Math.sqrt(f.aspect) / f.zoom, ay = 1 / Math.sqrt(f.aspect) / f.zoom;
  return (i: number, j: number): [number, number] => {
    const x = ((i + 0.5) / n - 0.5) * ax, y = ((j + 0.5) / n - 0.5) * ay;
    const u = 0.5 + f.tx + c * x - s * y, v = 0.5 + f.ty + s * x + c * y;
    return [p.pad + u * p.size, p.pad + v * p.size];
  };
}

function bilinear(img: Img, x: number, y: number, out: Float32Array, o: number): void {
  const { width: W, height: H, data } = img;
  const fx = Math.min(Math.max(x - 0.5, 0), W - 1), fy = Math.min(Math.max(y - 0.5, 0), H - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1);
  const ax = fx - x0, ay = fy - y0;
  for (let ch = 0; ch < 3; ch++) {
    const a = data[(y0 * W + x0) * 4 + ch] * (1 - ax) + data[(y0 * W + x1) * 4 + ch] * ax;
    const b = data[(y1 * W + x0) * 4 + ch] * (1 - ax) + data[(y1 * W + x1) * 4 + ch] * ax;
    out[o + ch] = a * (1 - ay) + b * ay;
  }
}

/** The fitted crop as a size × size tile. */
export function resample(p: Padded, f: Fit): Img {
  const n = p.size, map = mapper(p, f, n), out = makeImg(n, n), px = new Float32Array(3);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const [x, y] = map(i, j);
      bilinear(p.img, x, y, px, 0);
      const o = (j * n + i) * 4;
      out.data[o] = px[0];
      out.data[o + 1] = px[1];
      out.data[o + 2] = px[2];
      out.data[o + 3] = 255;
    }
  return out;
}

/** Box-downsamples by an integer factor (size and pad must divide by it). */
export function shrink(p: Padded, factor: number): Padded {
  const W = p.img.width, w = Math.floor(W / factor), out = makeImg(w, w), k = factor * factor;
  for (let y = 0; y < w; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        let sum = 0;
        for (let b = 0; b < factor; b++)
          for (let a = 0; a < factor; a++) sum += p.img.data[((y * factor + b) * W + x * factor + a) * 4 + ch];
        out.data[o + ch] = sum / k;
      }
      out.data[o + 3] = 255;
    }
  return { img: out, size: p.size / factor, pad: p.pad / factor };
}

const N = 64; // fitting resolution

// Source index of each pixel under each D4 op, at the fitting resolution.
const OP_INDEX = OPS.map((op) => {
  const t = new Int32Array(N * N);
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const [si, sj] = op(i, j, N - 1);
      t[j * N + i] = sj * N + si;
    }
  return t;
});

/** Mean absolute difference between the crop and its images under `ops`. */
export function asymmetry(t: Padded, f: Fit, ops: number[], buf: Float32Array): number {
  const r = (f.rot * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const ax = Math.sqrt(f.aspect) / f.zoom / N, ay = 1 / Math.sqrt(f.aspect) / f.zoom / N;
  const { width: W, data } = t.img;
  const max = W - 1;
  for (let j = 0; j < N; j++) {
    const y = (j + 0.5 - N / 2) * ay;
    for (let i = 0; i < N; i++) {
      const x = (i + 0.5 - N / 2) * ax;
      const fx = Math.min(Math.max(t.pad + (0.5 + f.tx + c * x - s * y) * t.size - 0.5, 0), max);
      const fy = Math.min(Math.max(t.pad + (0.5 + f.ty + s * x + c * y) * t.size - 0.5, 0), max);
      const x0 = fx | 0, y0 = fy | 0, x1 = x0 < max ? x0 + 1 : x0, y1 = y0 < max ? y0 + 1 : y0;
      const wx = fx - x0, wy = fy - y0;
      const a = (y0 * W + x0) * 4, b = (y0 * W + x1) * 4, d = (y1 * W + x0) * 4, e = (y1 * W + x1) * 4;
      const o = (j * N + i) * 3;
      for (let ch = 0; ch < 3; ch++) {
        const top = data[a + ch] + (data[b + ch] - data[a + ch]) * wx;
        const bot = data[d + ch] + (data[e + ch] - data[d + ch]) * wx;
        buf[o + ch] = top + (bot - top) * wy;
      }
    }
  }
  let sum = 0, cnt = 0;
  for (const k of ops) {
    if (k === 0) continue;
    const idx = OP_INDEX[k];
    for (let p = 0; p < N * N; p++) {
      const a = p * 3, b = idx[p] * 3;
      sum += Math.abs(buf[a] - buf[b]) + Math.abs(buf[a + 1] - buf[b + 1]) + Math.abs(buf[a + 2] - buf[b + 2]);
    }
    cnt += N * N;
  }
  return cnt ? sum / cnt : 0;
}

/** Difference between unrelated pixels of the crop: the score when there's no symmetry. */
function baseline(t: Padded, f: Fit, buf: Float32Array): number {
  asymmetry(t, f, [], buf);
  const M = N * N;
  let d = 0;
  for (let p = 0; p < M; p++) {
    const a = p * 3, b = ((p * 7919 + 1237) % M) * 3;
    d += Math.abs(buf[a] - buf[b]) + Math.abs(buf[a + 1] - buf[b + 1]) + Math.abs(buf[a + 2] - buf[b + 2]);
  }
  return d / M || 1;
}

/** Nelder–Mead over a small parameter vector. */
function minimize(fn: (x: number[]) => number, x0: number[], step: number[], iters: number): number[] {
  const n = x0.length;
  let pts = [x0, ...step.map((s, i) => x0.map((v, j) => (i === j ? v + s : v)))].map((x) => ({ x, f: fn(x) }));
  for (let it = 0; it < iters; it++) {
    pts.sort((a, b) => a.f - b.f);
    const c = new Array(n).fill(0);
    for (const p of pts.slice(0, n)) p.x.forEach((v, i) => (c[i] += v / n));
    const worst = pts[n];
    const at = (k: number) => c.map((v, i) => v + k * (worst.x[i] - v));
    const r = { x: at(-1), f: 0 };
    r.f = fn(r.x);
    if (r.f < pts[0].f) {
      const e = { x: at(-2), f: 0 };
      e.f = fn(e.x);
      pts[n] = e.f < r.f ? e : r;
    } else if (r.f < pts[n - 1].f) pts[n] = r;
    else {
      const k = { x: at(0.5), f: 0 };
      k.f = fn(k.x);
      if (k.f < worst.f) pts[n] = k;
      else pts = pts.map((p, i) => (i === 0 ? p : { x: p.x.map((v, j) => (v + pts[0].x[j]) / 2), f: fn(p.x.map((v, j) => (v + pts[0].x[j]) / 2)) }));
    }
  }
  pts.sort((a, b) => a.f - b.f);
  return pts[0].x;
}

const clampFit = (f: Fit, pad: number): Fit => ({
  tx: Math.max(-pad, Math.min(pad, f.tx)),
  ty: Math.max(-pad, Math.min(pad, f.ty)),
  rot: Math.max(-12, Math.min(12, f.rot)),
  zoom: f.zoom,
  aspect: Math.max(0.85, Math.min(1.18, f.aspect)),
});

/** Best shift/rotation/aspect for symmetry under `ops`, starting from `start` (its zoom kept). */
function fitOn(t: Padded, ops: number[], start: Fit, iters = 160): { fit: Fit; err: number } {
  const buf = new Float32Array(N * N * 3);
  const lim = (t.pad / t.size) * 0.9;
  const toFit = (x: number[]) => clampFit({ tx: x[0], ty: x[1], rot: x[2], zoom: start.zoom, aspect: Math.exp(x[3]) }, lim);
  const cost = (x: number[]) => asymmetry(t, toFit(x), ops, buf);
  // coarse grid over the shift, then refine everything
  let best = [start.tx, start.ty, start.rot, Math.log(start.aspect)], bestF = cost(best);
  const step = 2 / N;
  for (let ty = -lim; ty <= lim; ty += step)
    for (let tx = -lim; tx <= lim; tx += step) {
      const x = [tx, ty, start.rot, Math.log(start.aspect)], f = cost(x);
      if (f < bestF) [best, bestF] = [x, f];
    }
  const x = minimize(cost, best, [0.01, 0.01, 1, 0.02], iters);
  const fit = toFit(x);
  return { fit, err: asymmetry(t, fit, ops, buf) / baseline(t, fit, buf) };
}

/** Symmetry groups from largest to smallest; detection picks the first whose ops all fit. */
const ORDER: Symmetry[] = ['d4', 'rot4', 'mirror-xy', 'mirror-x', 'mirror-y', 'diagonal', 'rot2'];

export interface Alignment {
  fit: Fit;
  symmetry: Symmetry;
  /** Per D4 op (1–7): asymmetry relative to unrelated pixels after fitting it alone. 1 is no
   * symmetry at all; a real, symmetric tile photographed scores ~0.2–0.4 (glaze, texture). */
  scores: number[];
}

/** Detects which symmetries the tile has, then centres the crop on them.
 *
 * Scores can't be judged on an absolute scale: glaze and photo noise put a truly symmetric
 * real tile at ~0.3, while a small asymmetric detail on a clean tile only lifts a score to
 * ~0.2. They do cluster, though: the symmetries a tile has score close to its best one. So
 * an op counts if it's within 1.6× of the best score (floor 0.08 for clean images), and
 * never above 0.6. */
export function autoAlign(p: Padded, start: Fit = NO_FIT): Alignment {
  const t = shrink(p, p.size / N);
  const scores = [0];
  for (let k = 1; k < 8; k++) scores.push(fitOn(t, [k], start, 50).err); // rough fits: only deciding yes/no
  const cut = Math.min(0.6, Math.max(0.08, 1.6 * Math.min(...scores.slice(1))));
  const symmetry = ORDER.find((g) => SYMMETRY_OPS[g].every((k) => scores[k] < cut)) ?? 'none';
  const fit = symmetry === 'none' ? { ...start } : fitOn(t, SYMMETRY_OPS[symmetry], start).fit;
  return { fit, symmetry, scores };
}

/** Centres the crop for a symmetry the person picked. */
export function centerOn(p: Padded, symmetry: Symmetry, start: Fit = NO_FIT): Fit {
  if (symmetry === 'none') return { ...start };
  return fitOn(shrink(p, p.size / N), SYMMETRY_OPS[symmetry], start).fit;
}
