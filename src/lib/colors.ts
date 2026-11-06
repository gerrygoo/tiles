// Reducing the flat tile to a few flat colours.
//
// gb (gb.ggo.blue) builds 256-colour GIF palettes with median cut on the GPU and dithers.
// A tile wants the opposite: 2–8 colours, no dithering, clean regions that trace well. So
// this is k-means in CIE Lab (perceptual distances, so a glazed blue and its shadow land
// together) on the CPU; one 512² image is cheap and works on any phone.

import { makeImg, rng, rgbToLab, type Img, type RGB } from './image.ts';

/** Edge-preserving smoothing: flattens glaze texture and noise without blurring the lines
 * between colours. radius 0 returns the input. */
export function bilateral(img: Img, radius: number, sigmaRange = 28): Img {
  if (radius <= 0) return img;
  const { width: w, height: h, data } = img;
  const out = makeImg(w, h);
  const ss = Math.max(radius / 2, 0.5);
  const spatial: number[] = [];
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) spatial.push(Math.exp(-(dx * dx + dy * dy) / (2 * ss * ss)));
  const rangeLut = new Float32Array(3 * 255 * 255 + 1);
  for (let i = 0; i < rangeLut.length; i++) rangeLut[i] = Math.exp(-i / (2 * sigmaRange * sigmaRange * 3));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const r0 = data[o], g0 = data[o + 1], b0 = data[o + 2];
      let sr = 0, sg = 0, sb = 0, sw = 0, k = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = Math.min(Math.max(y + dy, 0), h - 1);
        for (let dx = -radius; dx <= radius; dx++, k++) {
          const xx = Math.min(Math.max(x + dx, 0), w - 1);
          const i = (yy * w + xx) * 4;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const wt = spatial[k] * rangeLut[(r - r0) ** 2 + (g - g0) ** 2 + (b - b0) ** 2];
          sr += r * wt;
          sg += g * wt;
          sb += b * wt;
          sw += wt;
        }
      }
      out.data[o] = sr / sw;
      out.data[o + 1] = sg / sw;
      out.data[o + 2] = sb / sw;
      out.data[o + 3] = 255;
    }
  }
  return out;
}

export interface Quantized {
  /** Mean sRGB colour of each cluster, most common first. */
  palette: RGB[];
  /** Cluster index per pixel. */
  labels: Uint8Array;
}

/** k-means++ in Lab on a sample of pixels, then every pixel goes to its nearest centre. */
export function kmeans(img: Img, k: number, seed = 1): Quantized {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const lab = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) rgbToLab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], lab, i * 3);

  const rand = rng(seed);
  const S = Math.min(n, 20000);
  const sample = new Int32Array(S);
  for (let i = 0; i < S; i++) sample[i] = S === n ? i : Math.floor(rand() * n);

  const d2 = (i: number, c: Float32Array, j: number) =>
    (lab[i * 3] - c[j * 3]) ** 2 + (lab[i * 3 + 1] - c[j * 3 + 1]) ** 2 + (lab[i * 3 + 2] - c[j * 3 + 2]) ** 2;

  // k-means++ seeding
  const C = new Float32Array(k * 3);
  const first = sample[Math.floor(rand() * S)];
  C.set(lab.subarray(first * 3, first * 3 + 3), 0);
  const best = new Float32Array(S).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let s = 0; s < S; s++) {
      best[s] = Math.min(best[s], d2(sample[s], C, c - 1));
      total += best[s];
    }
    let r = rand() * total, pick = sample[S - 1];
    for (let s = 0; s < S; s++) {
      r -= best[s];
      if (r <= 0) {
        pick = sample[s];
        break;
      }
    }
    C.set(lab.subarray(pick * 3, pick * 3 + 3), c * 3);
  }

  // Lloyd iterations on the sample
  const assign = new Uint8Array(S);
  for (let it = 0; it < 30; it++) {
    let changed = 0;
    const sum = new Float64Array(k * 3), cnt = new Float64Array(k);
    for (let s = 0; s < S; s++) {
      const i = sample[s];
      let bj = 0, bd = Infinity;
      for (let j = 0; j < k; j++) {
        const d = d2(i, C, j);
        if (d < bd) [bj, bd] = [j, d];
      }
      if (assign[s] !== bj || it === 0) changed++;
      assign[s] = bj;
      cnt[bj]++;
      for (let c = 0; c < 3; c++) sum[bj * 3 + c] += lab[i * 3 + c];
    }
    for (let j = 0; j < k; j++) if (cnt[j]) for (let c = 0; c < 3; c++) C[j * 3 + c] = sum[j * 3 + c] / cnt[j];
    if (!changed) break;
  }

  // full assignment, then palette = mean sRGB per cluster
  const labels = new Uint8Array(n);
  const rgbSum = new Float64Array(k * 3), count = new Float64Array(k);
  for (let i = 0; i < n; i++) {
    let bj = 0, bd = Infinity;
    for (let j = 0; j < k; j++) {
      const d = d2(i, C, j);
      if (d < bd) [bj, bd] = [j, d];
    }
    labels[i] = bj;
    count[bj]++;
    for (let c = 0; c < 3; c++) rgbSum[bj * 3 + c] += data[i * 4 + c];
  }
  const order = [...Array(k).keys()].filter((j) => count[j] > 0).sort((a, b) => count[b] - count[a]);
  const remap = new Uint8Array(k);
  order.forEach((j, r) => (remap[j] = r));
  for (let i = 0; i < n; i++) labels[i] = remap[labels[i]];
  const palette = order.map((j) => [0, 1, 2].map((c) => Math.round(rgbSum[j * 3 + c] / count[j])) as RGB);
  return { palette, labels };
}

/** Relabels through `map` (old index → new index), e.g. after merging two swatches. */
export function remapLabels(labels: Uint8Array, map: number[]): Uint8Array {
  const out = new Uint8Array(labels.length);
  for (let i = 0; i < labels.length; i++) out[i] = map[labels[i]];
  return out;
}

/** 3×3 majority vote, repeated `iters` times: rounds off pixel jaggies along edges. */
export function modeFilter(labels: Uint8Array, w: number, h: number, k: number, iters: number): Uint8Array {
  let cur = labels;
  const cnt = new Uint16Array(k);
  for (let it = 0; it < iters; it++) {
    const next = new Uint8Array(cur.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        cnt.fill(0);
        for (let dy = -1; dy <= 1; dy++) {
          const yy = Math.min(Math.max(y + dy, 0), h - 1);
          for (let dx = -1; dx <= 1; dx++) cnt[cur[yy * w + Math.min(Math.max(x + dx, 0), w - 1)]]++;
        }
        const self = cur[y * w + x];
        let bj = self;
        for (let j = 0; j < k; j++) if (cnt[j] > cnt[bj]) bj = j;
        next[y * w + x] = cnt[bj] >= 5 ? bj : self;
      }
    }
    cur = next;
  }
  return cur;
}

/** Folds every 4-connected blob smaller than minArea pixels into the neighbour colour it
 * shares the most border with. */
export function despeckle(labels: Uint8Array, w: number, h: number, minArea: number): Uint8Array {
  const out = labels.slice();
  if (minArea <= 1) return out;
  const comp = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  for (let pass = 0; pass < 4; pass++) {
    comp.fill(-1);
    let nComp = 0, changed = false;
    for (let s = 0; s < w * h; s++) {
      if (comp[s] >= 0) continue;
      const L = out[s];
      let top = 0, size = 0;
      stack[top++] = s;
      comp[s] = nComp;
      const members: number[] = [];
      while (top) {
        const p = stack[--top];
        members.push(p);
        size++;
        const x = p % w, y = (p - x) / w;
        if (x > 0 && comp[p - 1] < 0 && out[p - 1] === L) (comp[p - 1] = nComp), (stack[top++] = p - 1);
        if (x < w - 1 && comp[p + 1] < 0 && out[p + 1] === L) (comp[p + 1] = nComp), (stack[top++] = p + 1);
        if (y > 0 && comp[p - w] < 0 && out[p - w] === L) (comp[p - w] = nComp), (stack[top++] = p - w);
        if (y < h - 1 && comp[p + w] < 0 && out[p + w] === L) (comp[p + w] = nComp), (stack[top++] = p + w);
      }
      if (size < minArea) {
        const votes = new Map<number, number>();
        for (const p of members) {
          const x = p % w;
          const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w];
          for (const q of nb) {
            if (q < 0 || q >= w * h || out[q] === L) continue;
            votes.set(out[q], (votes.get(out[q]) ?? 0) + 1);
          }
        }
        let bestL = -1, bestV = 0;
        for (const [l, v] of votes) if (v > bestV) [bestL, bestV] = [l, v];
        if (bestL >= 0) {
          for (const p of members) out[p] = bestL;
          changed = true;
        }
      }
      nComp++;
    }
    if (!changed) break;
  }
  return out;
}

export function labelsToImage(labels: Uint8Array, w: number, h: number, palette: RGB[]): Img {
  const out = makeImg(w, h);
  for (let i = 0; i < w * h; i++) {
    const c = palette[labels[i]] ?? [255, 0, 255];
    out.data[i * 4] = c[0];
    out.data[i * 4 + 1] = c[1];
    out.data[i * 4 + 2] = c[2];
    out.data[i * 4 + 3] = 255;
  }
  return out;
}
