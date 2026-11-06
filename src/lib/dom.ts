// Browser-only helpers: loading photos, painting Img onto canvases, downloads.

import type { Img } from './image.ts';

export interface Photo {
  img: Img;
  canvas: HTMLCanvasElement;
  name: string;
}

/** Decodes an image file (EXIF orientation applied) and scales it to at most maxSide px:
 * a 12 MP phone photo is far more than a tile needs and makes every step slower. */
export async function loadPhoto(file: File, maxSide = 2400): Promise<Photo> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * s);
  canvas.height = Math.round(bmp.height * s);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { img: { data, width, height }, canvas, name: file.name.replace(/\.[^.]+$/, '') };
}

/** Svelte action: draws an Img on the canvas (canvas takes the image's pixel size). */
export function paint(node: HTMLCanvasElement, img: Img | null) {
  const draw = (im: Img | null) => {
    if (!im) return;
    node.width = im.width;
    node.height = im.height;
    node.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(im.data), im.width, im.height), 0, 0);
  };
  draw(img);
  return { update: draw };
}

/** Svelte action: draws the tile 3×3 with no gaps, to show whether the seams meet. */
export function paintRepeat(node: HTMLCanvasElement, img: Img | null) {
  const draw = (im: Img | null) => {
    if (!im) return;
    const one = document.createElement('canvas');
    one.width = im.width;
    one.height = im.height;
    one.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(im.data), im.width, im.height), 0, 0);
    const t = Math.min(im.width, 300);
    node.width = node.height = 3 * t;
    const ctx = node.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) ctx.drawImage(one, i * t, j * t, t, t);
  };
  draw(img);
  return { update: draw };
}

export function download(name: string, data: Blob | string, type = 'image/svg+xml'): void {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export async function svgToPng(svg: string, px: number): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const im = new Image();
    im.src = url;
    await im.decode();
    const c = document.createElement('canvas');
    c.width = c.height = px;
    c.getContext('2d')!.drawImage(im, 0, 0, px, px);
    return await new Promise((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error('PNG encode failed'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Reads a tile SVG saved earlier (by this app or anything square), dropping scripts and
 * event handlers, and returns its inner markup and viewBox size. */
export function readTileSvg(text: string): { body: string; size: number } {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.documentElement;
  if (svg.nodeName !== 'svg') throw new Error("That file isn't an SVG.");
  doc.querySelectorAll('script, foreignObject').forEach((e) => e.remove());
  doc.querySelectorAll('*').forEach((e) => {
    for (const a of [...e.attributes]) if (/^on/i.test(a.name) || /^\s*javascript:/i.test(a.value)) e.removeAttribute(a.name);
  });
  const vb = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  const w = vb.length === 4 ? vb[2] : parseFloat(svg.getAttribute('width') ?? '');
  const h = vb.length === 4 ? vb[3] : parseFloat(svg.getAttribute('height') ?? '');
  if (!(w > 0 && h > 0)) throw new Error('The SVG needs a viewBox or a width and height.');
  let body = svg.innerHTML;
  if (vb.length === 4 && (vb[0] || vb[1] || w !== h)) {
    // normalise to a square 0 0 S S box, stretching a non-square drawing to fit
    const S = Math.max(w, h);
    body = `<g transform="scale(${S / w} ${S / h}) translate(${-vb[0]} ${-vb[1]})">${body}</g>`;
    return { body, size: S };
  }
  return { body, size: w };
}
