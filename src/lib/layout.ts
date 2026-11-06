// Print sheets covered in the tile.
//
// All sheets look onto one infinite tiled plane in millimetres. Sheet (i, j) shows the
// printable rectangle starting at (i·W, j·H), so a multi-sheet spread lines up when the
// margins are trimmed off and the sheets butted together.

import { rng } from './image.ts';

export const PAPERS = {
  letter: { name: 'Letter', w: 215.9, h: 279.4 },
  legal: { name: 'Legal', w: 215.9, h: 355.6 },
  tabloid: { name: 'Tabloid', w: 279.4, h: 431.8 },
  a5: { name: 'A5', w: 148, h: 210 },
  a4: { name: 'A4', w: 210, h: 297 },
  a3: { name: 'A3', w: 297, h: 420 },
} as const;
export type Paper = keyof typeof PAPERS;

export const LAYOUTS = {
  straight: 'Straight',
  pinwheel: 'Pinwheel (quarter turns in 2×2)',
  mirror: 'Mirrored (book-matched 2×2)',
  checker: 'Checker (alternate quarter turn)',
  brick: 'Brick (half offset)',
  random: 'Random turns',
} as const;
export type Layout = keyof typeof LAYOUTS;

export interface PrintOptions {
  paper: Paper;
  landscape: boolean;
  /** Unprinted border, mm. Most home printers need ~5 mm. */
  margin: number;
  /** Tile edge, mm, not counting grout. */
  tile: number;
  /** Grout line width, mm (0 for none). */
  grout: number;
  groutColor: string;
  layout: Layout;
  /** Pattern origin: tiles centred on the spread, or starting whole at the top-left. */
  align: 'center' | 'corner';
  sheetsX: number;
  sheetsY: number;
  seed: number;
}

export const DEFAULT_PRINT: PrintOptions = {
  paper: 'letter',
  landscape: false,
  margin: 6,
  tile: 50,
  grout: 1.5,
  groutColor: '#d9d4cc',
  layout: 'straight',
  align: 'corner',
  sheetsX: 1,
  sheetsY: 1,
  seed: 7,
};

export function pageSize(o: PrintOptions): { w: number; h: number } {
  const p = PAPERS[o.paper];
  return o.landscape ? { w: p.h, h: p.w } : { w: p.w, h: p.h };
}

export function printable(o: PrintOptions): { w: number; h: number } {
  const p = pageSize(o);
  return { w: p.w - 2 * o.margin, h: p.h - 2 * o.margin };
}

const mod2 = (n: number) => ((n % 2) + 2) % 2;

/** Rotation (deg) and mirroring for the tile at cell (i, j). */
function cellOp(o: PrintOptions, i: number, j: number): { rot: number; mx: boolean; my: boolean } {
  const a = mod2(i), b = mod2(j);
  switch (o.layout) {
    case 'pinwheel':
      return { rot: [[0, 270], [90, 180]][a][b], mx: false, my: false };
    case 'mirror':
      return { rot: 0, mx: a === 1, my: b === 1 };
    case 'checker':
      return { rot: (a + b) % 2 ? 90 : 0, mx: false, my: false };
    case 'random': {
      const r = rng((o.seed * 73856093) ^ (i * 19349663) ^ (j * 83492791))();
      return { rot: 90 * Math.floor(r * 4), mx: false, my: false };
    }
    default:
      return { rot: 0, mx: false, my: false };
  }
}

const n = (v: number) => (Math.round(v * 1000) / 1000).toString();

/** <symbol id="tile"> for the vector tile; reference it once per document. */
export function tileSymbol(body: string, size: number): string {
  return `<symbol id="tile" viewBox="0 0 ${size} ${size}">${body}</symbol>`;
}

/** One sheet's printable area as an SVG sized in mm. Pass `defs` (the tile symbol) for a
 * standalone file; leave it out when the symbol is already in the document. */
export function sheetSVG(o: PrintOptions, si: number, sj: number, defs = ''): string {
  const { w: W, h: H } = printable(o);
  const pitch = o.tile + o.grout;
  const totW = W * o.sheetsX, totH = H * o.sheetsY;
  const x0 = o.align === 'center' ? (totW % pitch) / 2 : 0;
  const y0 = o.align === 'center' ? (totH % pitch) / 2 : 0;
  const vx = si * W, vy = sj * H;
  const shift = o.layout === 'brick' ? pitch / 2 : 0;
  let uses = '';
  const j0 = Math.floor((vy - y0) / pitch) - 1, j1 = Math.ceil((vy + H - y0) / pitch);
  for (let j = j0; j <= j1; j++) {
    const off = mod2(j) ? shift : 0;
    const i0 = Math.floor((vx - x0 - off) / pitch) - 1, i1 = Math.ceil((vx + W - x0 - off) / pitch);
    for (let i = i0; i <= i1; i++) {
      const x = x0 + off + i * pitch + o.grout / 2, y = y0 + j * pitch + o.grout / 2;
      if (x > vx + W || y > vy + H || x + o.tile < vx || y + o.tile < vy) continue;
      const { rot, mx, my } = cellOp(o, i, j);
      const cx = x + o.tile / 2, cy = y + o.tile / 2;
      let t = '';
      if (rot) t += `rotate(${rot} ${n(cx)} ${n(cy)})`;
      if (mx || my) t += ` matrix(${mx ? -1 : 1} 0 0 ${my ? -1 : 1} ${mx ? n(2 * cx) : 0} ${my ? n(2 * cy) : 0})`;
      uses += `<use href="#tile" x="${n(x)}" y="${n(y)}" width="${n(o.tile)}" height="${n(o.tile)}"${t ? ` transform="${t.trim()}"` : ''}/>`;
    }
  }
  const bg = o.grout > 0 ? `<rect x="${n(vx)}" y="${n(vy)}" width="${n(W)}" height="${n(H)}" fill="${o.groutColor}"/>` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${n(W)}mm" height="${n(H)}mm" ` +
    `viewBox="${n(vx)} ${n(vy)} ${n(W)} ${n(H)}">${defs ? `<defs>${defs}</defs>` : ''}${bg}${uses}</svg>`
  );
}

/** Whole tiles per sheet, for the summary line. */
export function tilesPerSheet(o: PrintOptions): { across: number; down: number } {
  const { w, h } = printable(o);
  const pitch = o.tile + o.grout;
  return { across: Math.floor(w / pitch), down: Math.floor(h / pitch) };
}
