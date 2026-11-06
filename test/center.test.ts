import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoAlign, centerOn, resample, NO_FIT } from '../src/lib/center.ts';
import { makeImg } from '../src/lib/image.ts';
import { COLORS } from './helpers.ts';

/** Periodic pattern; `sym` true is D4-symmetric, false only mirrors left ↔ right. */
function label(u: number, v: number, sym: boolean): number {
  u -= Math.floor(u);
  v -= Math.floor(v);
  const x = u - 0.5, y = v - 0.5, r = Math.hypot(x, y);
  if (!sym && y < -0.1 && Math.abs(x) < 0.08) return 3; // a stem: breaks every symmetry but mirror-x
  if (Math.abs(x) + Math.abs(y) < 0.18) return 2;
  if (r > 0.25 && r < 0.36) return 1;
  if (Math.abs(Math.abs(x) - Math.abs(y)) < 0.03 && r > 0.38) return 3;
  for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) if (Math.hypot(u - cx, v - cy) < 0.2) return 1;
  return 0;
}

/** A padded flat tile whose design is off by (dx, dy), rot degrees and an aspect stretch. */
function padded(dx: number, dy: number, rot: number, aspect: number, sym = true) {
  const size = 256, pad = 32, P = size + 2 * pad, img = makeImg(P, P);
  const t = (rot * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  for (let j = 0; j < P; j++)
    for (let i = 0; i < P; i++) {
      const X = (i + 0.5 - pad) / size - 0.5 - dx, Y = (j + 0.5 - pad) / size - 0.5 - dy;
      const x = (c * X + s * Y) / Math.sqrt(aspect), y = (-s * X + c * Y) * Math.sqrt(aspect);
      img.data.set([...COLORS[label(x + 0.5, y + 0.5, sym)], 255], (j * P + i) * 4);
    }
  return { img, size, pad };
}

test('auto-align finds the symmetry and undoes shift, rotation and stretch', () => {
  for (const [dx, dy, rot, aspect] of [[0.03, -0.02, 1.5, 1], [-0.05, 0.04, -2.5, 1.06]]) {
    const a = autoAlign(padded(dx, dy, rot, aspect));
    assert.equal(a.symmetry, 'd4');
    assert.ok(Math.abs(a.fit.tx - dx) < 0.004 && Math.abs(a.fit.ty - dy) < 0.004, `shift ${a.fit.tx},${a.fit.ty}`);
    assert.ok(Math.abs(a.fit.rot - rot) < 0.3, `rot ${a.fit.rot}`);
    assert.ok(Math.abs(a.fit.aspect - aspect) < 0.01, `aspect ${a.fit.aspect}`);
  }
});

test('a tile with only a left-right mirror is detected as such', () => {
  const a = autoAlign(padded(0.04, 0.02, 0, 1, false));
  assert.equal(a.symmetry, 'mirror-x', `scores ${a.scores.map((s) => s.toFixed(2))}`);
  assert.ok(Math.abs(a.fit.tx - 0.04) < 0.005, `tx ${a.fit.tx}`);
});

test('no fit is the plain centre crop; centerOn none changes nothing', () => {
  const p = padded(0, 0, 0, 1);
  const r = resample(p, NO_FIT);
  assert.equal(r.width, 256);
  assert.deepEqual(centerOn(p, 'none', NO_FIT), NO_FIT);
});
