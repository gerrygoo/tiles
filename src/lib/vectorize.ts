// Label map → SVG.
//
// Per colour: walk the pixel-edge boundary of its regions into closed loops (outer loops run
// clockwise on screen, holes counter-clockwise, so `fill-rule: nonzero` gets holes right),
// take the edge midpoints and blur them along the loop, simplify with Ramer–Douglas–Peucker,
// then draw it as quadratic curves through the segment midpoints, keeping vertices that turn
// more than `cornerDeg` as sharp corners.
// The most common colour is a full background rect and isn't traced. Each path also gets a
// hairline stroke in its own colour, which hides the slivers where two neighbours' smoothed
// edges don't quite meet.

import { hex, type RGB } from './image.ts';

export interface VectorOptions {
  /** RDP tolerance in pixels. Higher: fewer points, looser fit. */
  tolerance: number;
  /** Turns sharper than this (degrees) stay corners; gentler ones become curves. */
  cornerDeg: number;
  /** Loops enclosing fewer pixels than this are dropped. */
  minArea: number;
  /** Passes of a [1 2 1] blur along the contour before simplifying: irons out the pixel
   * staircase and photo noise (3 passes ≈ 1.2 px), at the cost of slightly rounder corners. */
  smooth: number;
}

export const DEFAULT_VECTOR: VectorOptions = { tolerance: 0.8, cornerDeg: 60, minArea: 6, smooth: 3 };

type Loop = number[]; // flat x,y pairs

const DX = [1, 0, -1, 0]; // E S W N (screen coordinates, y down)
const DY = [0, 1, 0, -1];

/** Boundary loops of every region with label L, as every pixel-grid vertex along them. */
export function traceLoops(labels: Uint8Array, w: number, h: number, L: number): Loop[] {
  const W1 = w + 1;
  const out = new Uint8Array(W1 * (h + 1)); // bitmask of outgoing directions per vertex
  const inL = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && labels[y * w + x] === L;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (labels[y * w + x] !== L) continue;
      if (!inL(x, y - 1)) out[y * W1 + x] |= 1; // top edge, heading E
      if (!inL(x + 1, y)) out[y * W1 + x + 1] |= 2; // right edge, heading S
      if (!inL(x, y + 1)) out[(y + 1) * W1 + x + 1] |= 4; // bottom edge, heading W
      if (!inL(x - 1, y)) out[(y + 1) * W1 + x] |= 8; // left edge, heading N
    }
  }
  const used = new Uint8Array(out.length);
  const loops: Loop[] = [];
  for (let v0 = 0; v0 < out.length; v0++) {
    let free = out[v0] & ~used[v0];
    while (free) {
      const d0 = 31 - Math.clz32(free & -free); // lowest free direction
      const loop: Loop = [];
      let v = v0, d = d0;
      for (;;) {
        used[v] |= 1 << d;
        const x = v % W1, y = (v - x) / W1;
        const nv = (y + DY[d]) * W1 + x + DX[d];
        // At a saddle (two ways out) turn right, which keeps diagonal pixels apart.
        const o = out[nv];
        let nd: number;
        if ((o & (o - 1)) === 0) nd = 31 - Math.clz32(o);
        else nd = o & (1 << ((d + 1) & 3)) ? (d + 1) & 3 : (d + 3) & 3;
        loop.push(nv % W1, Math.floor(nv / W1));
        v = nv;
        d = nd;
        if (v === v0 && d === d0) break;
      }
      loops.push(loop);
      free = out[v0] & ~used[v0];
    }
  }
  return loops;
}

/** Edge midpoints of a dense pixel-grid loop, blurred `passes` times along the loop. */
export function smoothLoop(p: Loop, passes: number): Loop {
  const n = p.length / 2;
  let a = new Float64Array(p.length);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a[i * 2] = (p[i * 2] + p[j * 2]) / 2;
    a[i * 2 + 1] = (p[i * 2 + 1] + p[j * 2 + 1]) / 2;
  }
  for (let k = 0; k < passes; k++) {
    const b = new Float64Array(a.length);
    for (let i = 0; i < n; i++) {
      const h = ((i + n - 1) % n) * 2, j = ((i + 1) % n) * 2;
      b[i * 2] = (a[h] + 2 * a[i * 2] + a[j]) / 4;
      b[i * 2 + 1] = (a[h + 1] + 2 * a[i * 2 + 1] + a[j + 1]) / 4;
    }
    a = b;
  }
  return Array.from(a);
}

/** Signed shoelace area (positive for clockwise on screen). */
export function loopArea(p: Loop): number {
  let a = 0;
  const n = p.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    a += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  return a / 2;
}

function rdpOpen(p: Loop, a: number, b: number, tol2: number, keep: Uint8Array): void {
  const stack = [a, b];
  while (stack.length) {
    const j = stack.pop()!, i = stack.pop()!;
    const ax = p[i * 2], ay = p[i * 2 + 1], bx = p[j * 2], by = p[j * 2 + 1];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let worst = -1, wd = tol2;
    for (let k = i + 1; k < j; k++) {
      const px = p[k * 2] - ax, py = p[k * 2 + 1] - ay;
      const d = len2 ? (px * dy - py * dx) ** 2 / len2 : px * px + py * py;
      if (d > wd) [worst, wd] = [k, d];
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push(i, worst, worst, j);
    }
  }
}

/** RDP on a closed loop: split at the vertex farthest from the first, simplify both halves. */
export function simplifyLoop(p: Loop, tol: number): Loop {
  const n = p.length / 2;
  if (n <= 4) return p;
  let far = 0, fd = -1;
  for (let k = 1; k < n; k++) {
    const d = (p[k * 2] - p[0]) ** 2 + (p[k * 2 + 1] - p[1]) ** 2;
    if (d > fd) [far, fd] = [k, d];
  }
  const ext = p.concat([p[0], p[1]]); // vertex n = vertex 0
  const keep = new Uint8Array(n + 1);
  keep[0] = keep[far] = 1;
  rdpOpen(ext, 0, far, tol * tol, keep);
  rdpOpen(ext, far, n, tol * tol, keep);
  const out: Loop = [];
  for (let k = 0; k < n; k++) if (keep[k]) out.push(p[k * 2], p[k * 2 + 1]);
  return out;
}

const f = (v: number) => (Math.round(v * 10) / 10).toString();

/** SVG path data for one closed loop. */
export function loopPath(p: Loop, cornerDeg: number): string {
  const n = p.length / 2;
  if (n < 3) return '';
  const X = (i: number) => p[((i + n) % n) * 2], Y = (i: number) => p[((i + n) % n) * 2 + 1];
  const cosLim = Math.cos((cornerDeg * Math.PI) / 180);
  const corner: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const ax = X(i) - X(i - 1), ay = Y(i) - Y(i - 1), bx = X(i + 1) - X(i), by = Y(i + 1) - Y(i);
    const cos = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1);
    corner.push(cos < cosLim);
  }
  const mid = (i: number) => `${f((X(i) + X(i + 1)) / 2)} ${f((Y(i) + Y(i + 1)) / 2)}`;
  const c0 = corner.indexOf(true);
  if (c0 < 0) {
    let d = `M${mid(n - 1)}`;
    for (let i = 0; i < n; i++) d += `Q${f(X(i))} ${f(Y(i))} ${mid(i)}`;
    return d + 'Z';
  }
  let d = `M${f(X(c0))} ${f(Y(c0))}`;
  for (let k = 1; k < n; k++) {
    const i = (c0 + k) % n;
    d += corner[i] ? `L${f(X(i))} ${f(Y(i))}` : `Q${f(X(i))} ${f(Y(i))} ${mid(i)}`;
  }
  return d + 'Z';
}

export interface VectorResult {
  /** Inner SVG markup (no <svg> wrapper), in a size × size coordinate space. */
  body: string;
  size: number;
  paths: number;
  points: number;
}

export function vectorize(labels: Uint8Array, size: number, palette: RGB[], opt: VectorOptions): VectorResult {
  const area = new Float64Array(palette.length);
  for (let i = 0; i < labels.length; i++) area[labels[i]]++;
  const order = [...palette.keys()].filter((j) => area[j] > 0).sort((a, b) => area[b] - area[a]);
  if (!order.length) return { body: '', size, paths: 0, points: 0 };
  let body = `<rect width="${size}" height="${size}" fill="${hex(palette[order[0]])}"/>`;
  let paths = 0, points = 0;
  for (const L of order.slice(1)) {
    let d = '';
    for (const loop of traceLoops(labels, size, size, L)) {
      if (Math.abs(loopArea(loop)) < opt.minArea) continue;
      const s = simplifyLoop(smoothLoop(loop, opt.smooth), opt.tolerance);
      points += s.length / 2;
      d += loopPath(s, opt.cornerDeg);
    }
    if (!d) continue;
    const c = hex(palette[L]);
    body += `<path fill="${c}" stroke="${c}" stroke-width="0.8" stroke-linejoin="round" d="${d}"/>`;
    paths++;
  }
  return { body, size, paths, points };
}

export function svgDocument(v: VectorResult, sizeAttr = ''): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${v.size} ${v.size}"${sizeAttr}>${v.body}</svg>`;
}
