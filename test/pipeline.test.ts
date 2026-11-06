import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { extractTiles, combineTiles, symmetrize, transform, type Quad } from '../src/lib/warp.ts';
import { bilateral, kmeans, modeFilter, despeckle, labelsToImage } from '../src/lib/colors.ts';
import { vectorize, svgDocument, traceLoops, loopArea, DEFAULT_VECTOR } from '../src/lib/vectorize.ts';
import { sheetSVG, tileSymbol, DEFAULT_PRINT } from '../src/lib/layout.ts';
import { labDist2 } from '../src/lib/image.ts';
import { renderWall, renderTile, writePNG, COLORS } from './helpers.ts';

const OUT = process.env.TILES_TEST_OUT; // set to a directory to dump images for eyeballing
if (OUT) mkdirSync(OUT, { recursive: true });

test('trace: loops wind clockwise, holes counter-clockwise, diagonal pixels stay apart', () => {
  // 4×4: a ring (hole in the middle) plus two pixels touching only at a corner
  const w = 6, h = 4;
  const L = new Uint8Array([
    1, 1, 1, 0, 1, 0,
    1, 0, 1, 0, 0, 1,
    1, 1, 1, 0, 0, 0,
    0, 0, 0, 0, 0, 0,
  ]);
  const areas = traceLoops(L, w, h, 1).map(loopArea).sort((a, b) => a - b);
  assert.deepEqual(areas, [-1, 1, 1, 9]);
});

test('photo of a wall → flat tile → colours → vector', () => {
  const size = 256, cols = 3, rows = 3;
  const turns = [0, 1, 2, 3, 0, 1, 2, 3, 1];
  const quad: Quad = [[180, 90], [860, 140], [900, 760], [130, 690]];
  const photo = renderWall(1000, 800, quad, cols, rows, turns);
  if (OUT) writePNG(`${OUT}/0-photo.png`, photo);

  const tiles = extractTiles(photo, quad, cols, rows, size, 0.03);
  const { tile, turns: found } = combineTiles(tiles, true);
  // each tile turned back to match tile 0 (laid at turn 0): found[i] undoes turns[i]
  assert.deepEqual(found.map((t, i) => (t + turns[i]) % 4), turns.map(() => 0), `turns found ${found}`);
  if (OUT) writePNG(`${OUT}/1-flat.png`, tile);

  const clean = bilateral(tile, 2);
  const q = kmeans(clean, 4);
  let labels = modeFilter(q.labels, size, size, q.palette.length, 2);
  labels = despeckle(labels, size, size, 30);
  if (OUT) writePNG(`${OUT}/2-colors.png`, labelsToImage(labels, size, size, q.palette));

  // match clusters to true colours, then score pixels (truth rendered with the same trim)
  const map = q.palette.map((c) => COLORS.map((t, i) => [labDist2(c, t), i]).sort((a, b) => a[0] - b[0])[0][1]);
  assert.deepEqual([...map].sort(), [0, 1, 2, 3], `palette ${JSON.stringify(q.palette)}`);
  const truth = renderTile(size * 1, 0).labels; // trim 3% shifts things by <8 px; compare core
  let ok = 0, n = 0;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = 0.03 + ((x + 0.5) / size) * 0.94, v = 0.03 + ((y + 0.5) / size) * 0.94;
      const ty = Math.min(size - 1, Math.floor(v * size)), tx = Math.min(size - 1, Math.floor(u * size));
      n++;
      if (map[labels[y * size + x]] === truth[ty * size + tx]) ok++;
    }
  const acc = ok / n;
  assert.ok(acc > 0.97, `pixel accuracy ${acc}`);

  const v = vectorize(labels, size, q.palette, DEFAULT_VECTOR);
  assert.ok(v.paths >= 3 && v.points < 1500, `paths ${v.paths}, points ${v.points}`);
  const svg = svgDocument(v, ' width="512" height="512"');
  if (OUT) {
    writeFileSync(`${OUT}/3-tile.svg`, svg);
    writeFileSync(`${OUT}/4-sheet.svg`, sheetSVG({ ...DEFAULT_PRINT, layout: 'pinwheel' }, 0, 0, tileSymbol(v.body, v.size)));
  }
  console.log(`accuracy ${(acc * 100).toFixed(2)}%  paths ${v.paths}  points ${v.points}  svg ${(svg.length / 1024).toFixed(1)} KB`);
});

test('symmetrize is idempotent on a symmetric image and transform round-trips', () => {
  const { img } = renderTile(64);
  const t = transform(transform(transform(transform(img, 1), 1), 1), 1);
  assert.deepEqual(t.data, img.data);
  const s = symmetrize(img, 'mirror-xy');
  assert.deepEqual(symmetrize(s, 'mirror-xy').data, s.data);
});
