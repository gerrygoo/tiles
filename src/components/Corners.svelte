<script lang="ts">
  // The photo with four draggable corners. A magnifier shows the area under the finger while
  // dragging, and the quad is divided into the cols × rows tile grid so it's easy to see
  // whether the corners sit on the grout lines.
  import { mapPoint, squareToQuad, type Quad } from '../lib/warp.ts';

  let { source, quad = $bindable(), cols, rows }: { source: HTMLCanvasElement; quad: Quad; cols: number; rows: number } = $props();

  let canvas: HTMLCanvasElement;
  let wrap: HTMLDivElement;
  let cssW = $state(600);
  let active = $state(-1); // 0–3 corner, 4 = whole quad
  let grab: [number, number] = [0, 0];

  const scale = $derived(cssW / source.width);
  const cssH = $derived(source.height * scale);

  $effect(() => {
    const ro = new ResizeObserver(([e]) => (cssW = Math.min(e.contentRect.width, (window.innerHeight * 0.72 * source.width) / source.height)));
    ro.observe(wrap);
    return () => ro.disconnect();
  });

  const accent = () => getComputedStyle(wrap).getPropertyValue('--accent').trim() || '#e4572e';

  $effect(() => {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    ctx.drawImage(source, 0, 0);
    const q = quad.map((p) => [p[0], p[1]]) as Quad;
    const H = squareToQuad(q);
    const lw = 1 / scale;
    const col = accent();
    // dim everything outside the quad
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, source.width, source.height);
    ctx.moveTo(...q[0]);
    for (const p of [q[3], q[2], q[1]]) ctx.lineTo(...p);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fill('evenodd');
    ctx.restore();
    // tile grid
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = lw;
    ctx.setLineDash([6 * lw, 4 * lw]);
    ctx.beginPath();
    for (let c = 1; c < cols; c++) {
      ctx.moveTo(...mapPoint(H, c / cols, 0));
      ctx.lineTo(...mapPoint(H, c / cols, 1));
    }
    for (let r = 1; r < rows; r++) {
      ctx.moveTo(...mapPoint(H, 0, r / rows));
      ctx.lineTo(...mapPoint(H, 1, r / rows));
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = col;
    ctx.lineWidth = 2 * lw;
    ctx.beginPath();
    ctx.moveTo(...q[0]);
    for (const p of [q[1], q[2], q[3]]) ctx.lineTo(...p);
    ctx.closePath();
    ctx.stroke();
    // handles
    q.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p[0], p[1], (i === active ? 9 : 7) * lw, 0, Math.PI * 2);
      ctx.fillStyle = i === active ? col : 'rgba(255,255,255,0.9)';
      ctx.fill();
      ctx.lineWidth = 2 * lw;
      ctx.strokeStyle = col;
      ctx.stroke();
    });
    // magnifier: 3× around the corner being dragged, in the opposite top corner
    if (active >= 0 && active < 4) {
      const R = 64, Z = 3;
      const p = q[active];
      const cx = p[0] * scale < cssW / 2 ? cssW - R - 10 : R + 10, cy = R + 10;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = '#000';
      ctx.fill();
      const s = scale * Z;
      ctx.drawImage(source, p[0] - R / s, p[1] - R / s, (2 * R) / s, (2 * R) / s, cx - R, cy - R, 2 * R, 2 * R);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - R, cy);
      ctx.lineTo(cx + R, cy);
      ctx.moveTo(cx, cy - R);
      ctx.lineTo(cx, cy + R);
      ctx.stroke();
      ctx.restore();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = col;
      ctx.stroke();
    }
  });

  function toPhoto(e: PointerEvent): [number, number] {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale];
  }

  function inside(p: [number, number]): boolean {
    let c = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const [xi, yi] = quad[i], [xj, yj] = quad[j];
      if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  }

  function down(e: PointerEvent) {
    const p = toPhoto(e);
    const reach = (e.pointerType === 'touch' ? 34 : 18) / scale;
    let best = -1, bd = reach;
    quad.forEach((q, i) => {
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bd) [best, bd] = [i, d];
    });
    if (best < 0 && inside(p)) best = 4;
    if (best < 0) return;
    active = best;
    grab = p;
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function move(e: PointerEvent) {
    if (active < 0) return;
    const p = toPhoto(e);
    const clamp = (v: number, m: number) => Math.min(Math.max(v, 0), m);
    if (active < 4) {
      quad[active] = [clamp(p[0], source.width), clamp(p[1], source.height)];
    } else {
      const dx = p[0] - grab[0], dy = p[1] - grab[1];
      quad = quad.map(([x, y]) => [x + dx, y + dy]) as Quad;
      grab = p;
    }
  }
</script>

<div class="corners" bind:this={wrap}>
  <canvas
    bind:this={canvas}
    style:width="{cssW}px"
    style:height="{cssH}px"
    class:dragging={active >= 0}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={() => (active = -1)}
    onpointercancel={() => (active = -1)}
  ></canvas>
</div>

<style>
  .corners {
    width: 100%;
    display: flex;
    justify-content: center;
  }
  canvas {
    display: block;
    border-radius: var(--r);
    touch-action: none;
    cursor: crosshair;
  }
  canvas.dragging {
    cursor: grabbing;
  }
</style>
