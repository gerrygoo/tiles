<script lang="ts">
  import { tick } from 'svelte';
  import Corners from './components/Corners.svelte';
  import Slider from './components/Slider.svelte';
  import { extractTiles, combineTiles, symmetrize, transform, ROT_CW, ROT_CCW, type Quad, type Symmetry } from './lib/warp.ts';
  import { bilateral, kmeans, remapLabels, modeFilter, despeckle, labelsToImage } from './lib/colors.ts';
  import { vectorize, svgDocument, DEFAULT_VECTOR, type VectorOptions } from './lib/vectorize.ts';
  import { PAPERS, LAYOUTS, DEFAULT_PRINT, pageSize, printable, sheetSVG, tileSymbol, tilesPerSheet, type PrintOptions } from './lib/layout.ts';
  import { hex, fromHex, labDist2, type Img } from './lib/image.ts';
  import { loadPhoto, paint, paintRepeat, download, svgToPng, readTileSvg, type Photo } from './lib/dom.ts';
  import { autoAlign, centerOn, resample, NO_FIT, type Fit } from './lib/center.ts';

  type Step = 'photo' | 'align' | 'colors' | 'vector' | 'print';
  const STEPS: [Step, string][] = [
    ['photo', 'Photo'],
    ['align', 'Align'],
    ['colors', 'Colours'],
    ['vector', 'Vector'],
    ['print', 'Print'],
  ];

  const SYMMETRIES: [Symmetry, string][] = [
    ['none', 'None'],
    ['mirror-x', 'Mirror left ↔ right'],
    ['mirror-y', 'Mirror top ↕ bottom'],
    ['mirror-xy', 'Mirror both ways'],
    ['diagonal', 'Mirror on the diagonal'],
    ['rot2', 'Half-turn'],
    ['rot4', 'Quarter-turn (4-fold)'],
    ['d4', 'Full (8-fold)'],
  ];

  function stored<T extends object>(key: string, fallback: T): T {
    try {
      const v = JSON.parse(localStorage.getItem(key) ?? 'null');
      return v && typeof v === 'object' ? { ...fallback, ...v } : { ...fallback };
    } catch {
      return { ...fallback };
    }
  }
  function store(key: string, v: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* private mode etc.: settings just don't stick */
    }
  }

  let step = $state<Step>('photo');
  let busy = $state('');
  let error = $state('');

  // ---- 1. photo + corners ----
  let photo = $state.raw<Photo | null>(null);
  let quad = $state<Quad>([[0, 0], [1, 0], [1, 1], [0, 1]]);
  let cols = $state(1);
  let rows = $state(1);
  let trim = $state(2);
  let align = $state(true);
  let res = $state(512);
  let dragging = $state(false);

  async function openPhoto(file: File | undefined) {
    if (!file) return;
    error = '';
    busy = 'Loading photo…';
    try {
      const p = await loadPhoto(file);
      const { width: w, height: h } = p.img;
      const m = 0.15;
      quad = [[w * m, h * m], [w * (1 - m), h * m], [w * (1 - m), h * (1 - m)], [w * m, h * (1 - m)]];
      photo = p;
      raw = null;
      step = 'photo';
    } catch (e) {
      error = `Couldn't open that image (${(e as Error).message}). Try a JPEG or PNG.`;
    } finally {
      busy = '';
    }
  }

  function wholeImage() {
    if (!photo) return;
    const { width: w, height: h } = photo.img;
    quad = [[0, 0], [w, 0], [w, h], [0, h]];
  }

  // ---- 2. flatten + align ----
  // The flat tile keeps `pad` px of context on every side so alignment can move the crop.
  let raw = $state.raw<{ tile: Img; turns: number[]; size: number; pad: number } | null>(null);
  const size = $derived(raw?.size ?? res);

  let fit = $state<Fit>({ ...NO_FIT });
  let symmetry = $state<Symmetry>('none');
  let detected = $state<Symmetry | null>(null);
  let enforce = $state(true);
  let guides = $state(true);
  let turn = $state(0);

  const SYM_NAME = Object.fromEntries(SYMMETRIES) as Record<Symmetry, string>;

  async function working(label: string, fn: () => void) {
    busy = label;
    await new Promise((r) => setTimeout(r, 30)); // let the label paint before the main thread blocks
    try {
      fn();
    } finally {
      busy = '';
    }
  }

  const padded = $derived(raw ? { img: raw.tile, size: raw.size, pad: raw.pad } : null);

  function detect() {
    if (!padded) return;
    const a = autoAlign(padded, { ...NO_FIT, zoom: fit.zoom });
    fit = a.fit;
    symmetry = detected = a.symmetry;
  }

  async function flatten() {
    if (!photo) return;
    await working('Flattening and centring…', () => {
      const pad = res / 8;
      const tiles = extractTiles(photo!.img, $state.snapshot(quad) as Quad, cols, rows, res, trim / 100, pad);
      raw = { ...combineTiles(tiles, align), size: res, pad };
      fit = { ...NO_FIT };
      turn = 0;
      detect();
    });
    step = 'align';
  }

  const aligned = $derived.by(() => {
    if (!padded) return null;
    const t = resample(padded, fit);
    return turn ? transform(t, turn) : t;
  });
  const flat = $derived(aligned ? (enforce ? symmetrize(aligned, symmetry) : aligned) : null);
  const turned = $derived(raw ? raw.turns.filter((t) => t).length : 0);

  function rotate(op: number) {
    turn = [0, 1, 2, 3][(turn + (op === ROT_CW ? 1 : 3)) % 4];
  }

  // ---- 3. colours ----
  let smoothing = $state(2);
  let k = $state(4);
  let edge = $state(2);
  let speckle = $state(40);

  const clean = $derived(flat ? bilateral(flat, smoothing) : null);
  const quant = $derived(clean ? kmeans(clean, k) : null);
  // palette edits: recolouring (colours) and merging swatches (merge: old index → kept index)
  let colors = $derived(quant ? quant.palette.map((c) => [...c] as [number, number, number]) : []);
  let merge = $derived(quant ? quant.palette.map((_, i) => i) : []);
  const labels = $derived.by(() => {
    if (!quant) return null;
    const n = quant.palette.length;
    return despeckle(modeFilter(remapLabels(quant.labels, merge), size, size, n, edge), size, size, speckle);
  });
  const share = $derived.by(() => {
    const s = new Array(colors.length).fill(0);
    if (labels) for (const l of labels) s[l]++;
    return s.map((v) => v / (labels?.length || 1));
  });
  const active = $derived(merge.map((v, i) => (v === i ? i : -1)).filter((i) => i >= 0));
  const colorImg = $derived(labels ? labelsToImage(labels, size, size, colors) : null);

  function mergeAway(i: number) {
    const others = active.filter((j) => j !== i);
    if (!others.length) return;
    const into = others.reduce((a, b) => (labDist2(colors[i], colors[a]) <= labDist2(colors[i], colors[b]) ? a : b));
    merge = merge.map((v) => (v === i ? into : v));
  }

  // ---- 3. vector ----
  let vopt = $state<VectorOptions>(stored('tiles.vector', DEFAULT_VECTOR));
  $effect(() => store('tiles.vector', $state.snapshot(vopt)));
  let view = $state<'vector' | 'colors' | 'photo'>('vector');
  const vec = $derived(labels ? vectorize(labels, size, colors, vopt) : null);
  const tileSvg = $derived(vec ? svgDocument(vec) : '');

  async function savePng() {
    if (!tileSvg) return;
    download(`${photo?.name ?? 'tile'}-tile.png`, await svgToPng(tileSvg, 2048));
  }

  // ---- 4. print ----
  let popt = $state<PrintOptions>(stored('tiles.print', DEFAULT_PRINT));
  $effect(() => store('tiles.print', $state.snapshot(popt)));
  let loaded = $state.raw<{ body: string; size: number; name: string } | null>(null);
  const tile = $derived(loaded ?? (vec ? { body: vec.body, size: vec.size, name: photo?.name ?? 'tile' } : null));
  const page = $derived(pageSize(popt));
  const area = $derived(printable(popt));
  const fits = $derived(tilesPerSheet(popt));
  const sheets = $derived(Array.from({ length: popt.sheetsX * popt.sheetsY }, (_, n) => [n % popt.sheetsX, Math.floor(n / popt.sheetsX)]));
  const defs = $derived(tile ? tileSymbol(tile.body, tile.size) : '');

  async function openTileSvg(file: File | undefined) {
    if (!file) return;
    try {
      loaded = { ...readTileSvg(await file.text()), name: file.name.replace(/\.svg$/i, '') };
      error = '';
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function print() {
    await tick();
    window.print();
  }

  const mm = (v: number) => `${Math.round(v * 10) / 10} mm`;
</script>

<svelte:head>
  {@html `<style>@page { size: ${page.w}mm ${page.h}mm; margin: 0; }</style>`}
</svelte:head>

<svelte:window
  ondragover={(e) => {
    e.preventDefault();
    dragging = true;
  }}
  ondragleave={(e) => {
    if (!e.relatedTarget) dragging = false;
  }}
  ondrop={(e) => {
    e.preventDefault();
    dragging = false;
    const f = e.dataTransfer?.files[0];
    if (f?.type === 'image/svg+xml') {
      openTileSvg(f);
      step = 'print';
    } else openPhoto(f);
  }}
/>

{#if defs}
  <div class="defs" aria-hidden="true">{@html `<svg width="0" height="0"><defs>${defs}</defs></svg>`}</div>
{/if}

<div class="app" class:dragging>
  <header>
    <h1><span class="mark" aria-hidden="true"></span>tiles</h1>
    <nav>
      {#each STEPS as [s, label], i}
        <button class="step" class:on={step === s} disabled={(s !== 'photo' && s !== 'print' && !raw) || (s === 'print' && !tile)} onclick={() => (step = s)}>
          <span class="num">{i + 1}</span>{label}
        </button>
      {/each}
    </nav>
  </header>

  {#if error}<p class="error" role="alert">{error}</p>{/if}

  <main>
    {#if step === 'photo'}
      {#if !photo}
        <label class="drop">
          <input type="file" accept="image/*" onchange={(e) => openPhoto(e.currentTarget.files?.[0])} />
          <strong>Take or choose a photo of the tiles</strong>
          <span>Stand square to the wall, use even light and no flash. Get several identical tiles in the frame if you can: they're merged to clean up glare and chips.</span>
          <span class="btn primary">Choose photo</span>
        </label>
        <p class="note">Everything happens on your device. Photos are never uploaded.</p>
      {:else}
        <div class="split">
          <section class="stage">
            <Corners source={photo.canvas} bind:quad {cols} {rows} />
            <p class="note">Drag the four dots onto the outer corners of a block of tiles; drag inside to move it all. The dashed lines should land on the grout.</p>
          </section>
          <aside class="panel">
            <div class="pair">
              <label class="field">Tiles across
                <input type="number" min="1" max="8" bind:value={cols} />
              </label>
              <label class="field">Tiles down
                <input type="number" min="1" max="8" bind:value={rows} />
              </label>
            </div>
            <Slider label="Trim edges" bind:value={trim} min={0} max={12} step={0.5} fmt={(v) => `${v}%`} hint="Cut this much off each tile's sides to drop grout and bevels." />
            {#if cols * rows > 1}
              <label class="check"><input type="checkbox" bind:checked={align} /> Tiles may be laid turned: line them up</label>
            {/if}
            <label class="field">Detail
              <select bind:value={res}>
                <option value={384}>Low (384 px)</option>
                <option value={512}>Normal (512 px)</option>
                <option value={768}>High (768 px)</option>
                <option value={1024}>Very high (1024 px, slow)</option>
              </select>
            </label>
            <div class="buttons">
              <button onclick={wholeImage}>Use whole image</button>
              <label class="btn">Change photo<input type="file" accept="image/*" onchange={(e) => openPhoto(e.currentTarget.files?.[0])} /></label>
            </div>
            <button class="primary big" onclick={flatten}>Flatten {cols * rows > 1 ? `${cols * rows} tiles` : 'tile'} →</button>
          </aside>
        </div>
      {/if}
    {:else if step === 'align' && raw && padded}
      <div class="split">
        <section class="stage two">
          <figure>
            <div class="guided">
              <canvas use:paint={aligned}></canvas>
              {#if guides}
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                  {#each ['M50 0V100M0 50H100M0 0L100 100M100 0L0 100', 'M50 0V100M0 50H100M0 0L100 100M100 0L0 100'] as d, i}
                    <path {d} class={i ? 'fg' : 'bg'} vector-effect="non-scaling-stroke" />
                  {/each}
                  <circle cx="50" cy="50" r="25" class="fg" vector-effect="non-scaling-stroke" />
                </svg>
              {/if}
            </div>
            <figcaption>Aligned crop: the guides should cross at the design's centre</figcaption>
          </figure>
          <figure>
            <canvas use:paintRepeat={flat}></canvas>
            <figcaption>Repeated 3×3, no grout{enforce && symmetry !== 'none' ? ', symmetry applied' : ''}: check the seams</figcaption>
          </figure>
        </section>
        <aside class="panel">
          {#if turned}<p class="note">{turned} of {raw.turns.length} tiles were laid turned and have been lined up.</p>{/if}
          <p class="note">
            {#if detected && detected !== 'none'}Detected symmetry: <strong>{SYM_NAME[detected]}</strong>. The crop was centred on it.
            {:else}No clear symmetry found, so the crop wasn't moved. Pick one below if the tile has one.{/if}
          </p>
          <label class="field">Symmetry
            <select bind:value={symmetry}>
              {#each SYMMETRIES as [v, l]}<option value={v}>{l}</option>{/each}
            </select>
          </label>
          <div class="buttons">
            <button onclick={() => working('Centring…', () => (fit = centerOn(padded, symmetry, fit)))} disabled={symmetry === 'none'}>Centre on it</button>
            <button onclick={() => working('Detecting…', detect)}>Detect again</button>
          </div>
          <label class="check"><input type="checkbox" bind:checked={enforce} disabled={symmetry === 'none'} /> Make it exactly symmetric</label>
          <Slider label="Zoom" bind:value={fit.zoom} min={0.85} max={1.15} step={0.0025} fmt={(v) => `${(v * 100).toFixed(1)}%`} hint="Symmetry can't tell the scale: adjust until the seams in the repeat meet." />
          <details>
            <summary>Fine-tune by hand</summary>
            <div class="fine">
              <Slider label="Shift right" bind:value={fit.tx} min={-0.12} max={0.12} step={0.001} fmt={(v) => `${(v * 100).toFixed(1)}%`} />
              <Slider label="Shift down" bind:value={fit.ty} min={-0.12} max={0.12} step={0.001} fmt={(v) => `${(v * 100).toFixed(1)}%`} />
              <Slider label="Rotate" bind:value={fit.rot} min={-12} max={12} step={0.05} fmt={(v) => `${v.toFixed(2)}°`} />
              <Slider label="Stretch" bind:value={fit.aspect} min={0.85} max={1.18} step={0.0025} fmt={(v) => `${(v * 100).toFixed(1)}%`} hint="Width relative to height, for photos taken at an angle." />
              <button onclick={() => (fit = { ...NO_FIT })}>Reset to the flattened crop</button>
            </div>
          </details>
          <div class="field">Orientation
            <div class="buttons">
              <button onclick={() => rotate(ROT_CCW)} aria-label="Rotate left">⟲ Left</button>
              <button onclick={() => rotate(ROT_CW)} aria-label="Rotate right">Right ⟳</button>
            </div>
          </div>
          <label class="check"><input type="checkbox" bind:checked={guides} /> Show guides</label>
          <button class="primary big" onclick={() => (step = 'colors')}>Pick colours →</button>
        </aside>
      </div>
    {:else if step === 'colors' && raw}
      <div class="split">
        <section class="stage two">
          <figure><canvas use:paint={clean}></canvas><figcaption>Aligned{cols * rows > 1 ? `, median of ${cols * rows}` : ''}</figcaption></figure>
          <figure><canvas use:paint={colorImg}></canvas><figcaption>{active.length} colours</figcaption></figure>
        </section>
        <aside class="panel">
          <Slider label="Smooth photo" bind:value={smoothing} min={0} max={5} hint="Edge-preserving blur before picking colours." />
          <Slider label="Colours" bind:value={k} min={2} max={10} hint="How many colours to look for. Fine-tune below." />
          <div class="swatches">
            {#each active as i (i)}
              <div class="swatch">
                <input type="color" value={hex(colors[i])} oninput={(e) => (colors = colors.map((c, j) => (j === i ? fromHex(e.currentTarget.value) : c)))} aria-label="Colour {i + 1}" />
                <span class="pct">{Math.round(share[i] * 100)}%</span>
                {#if active.length > 1}<button class="mini" onclick={() => mergeAway(i)} title="Merge into the nearest colour">merge</button>{/if}
              </div>
            {/each}
          </div>
          <Slider label="Round off edges" bind:value={edge} min={0} max={6} />
          <Slider label="Remove specks under" bind:value={speckle} min={0} max={400} step={5} fmt={(v) => `${v} px`} />
          <button class="primary big" onclick={() => (step = 'vector')}>Vectorise →</button>
        </aside>
      </div>
    {:else if step === 'vector' && vec}
      <div class="split">
        <section class="stage">
          <div class="seg" role="tablist">
            {#each [['vector', 'Vector'], ['colors', 'Colours'], ['photo', 'Flattened']] as [v, l]}
              <button role="tab" aria-selected={view === v} class:on={view === v} onclick={() => (view = v as typeof view)}>{l}</button>
            {/each}
          </div>
          <div class="square">
            {#if view === 'vector'}{@html tileSvg}
            {:else if view === 'colors'}<canvas use:paint={colorImg}></canvas>
            {:else}<canvas use:paint={flat}></canvas>{/if}
          </div>
        </section>
        <aside class="panel">
          <Slider label="Smooth outlines" bind:value={vopt.smooth} min={0} max={8} />
          <Slider label="Simplify" bind:value={vopt.tolerance} min={0.2} max={3} step={0.1} fmt={(v) => `${v} px`} hint="How far a simplified outline may stray from the pixels." />
          <Slider label="Keep corners sharper than" bind:value={vopt.cornerDeg} min={20} max={150} step={5} fmt={(v) => `${v}°`} />
          <Slider label="Drop shapes under" bind:value={vopt.minArea} min={0} max={200} step={2} fmt={(v) => `${v} px`} />
          <p class="note">{vec.paths} shapes, {vec.points} points, {(tileSvg.length / 1024).toFixed(1)} KB</p>
          <div class="buttons">
            <button onclick={() => download(`${photo?.name ?? 'tile'}-tile.svg`, tileSvg)}>Download SVG</button>
            <button onclick={savePng}>Download PNG</button>
          </div>
          <button class="primary big" onclick={() => ((loaded = null), (step = 'print'))}>Lay out for print →</button>
        </aside>
      </div>
    {:else if step === 'print' && tile}
      <div class="split">
        <section class="stage">
          <div class="spread" style:grid-template-columns="repeat({popt.sheetsX}, 1fr)" style:max-width="{Math.min(100, (popt.sheetsX / popt.sheetsY) * (page.w / page.h) * 130)}vh">
            {#each sheets as [i, j]}
              <div class="sheet" style:aspect-ratio="{page.w} / {page.h}" style:padding="{(popt.margin / page.w) * 100}%">
                {@html sheetSVG(popt, i, j)}
              </div>
            {/each}
          </div>
        </section>
        <aside class="panel">
          {#if loaded}<p class="note">Using <strong>{loaded.name}.svg</strong>. <button class="link" onclick={() => (loaded = null)} disabled={!vec}>Use this session's tile</button></p>{/if}
          <div class="pair">
            <label class="field">Paper
              <select bind:value={popt.paper}>
                {#each Object.entries(PAPERS) as [k, p]}<option value={k}>{p.name}</option>{/each}
              </select>
            </label>
            <label class="field">Orientation
              <select bind:value={popt.landscape}>
                <option value={false}>Portrait</option>
                <option value={true}>Landscape</option>
              </select>
            </label>
          </div>
          <Slider label="Tile size" bind:value={popt.tile} min={10} max={200} fmt={(v) => `${v} mm`} />
          <div class="pair">
            <Slider label="Grout" bind:value={popt.grout} min={0} max={6} step={0.5} fmt={(v) => `${v} mm`} />
            <label class="field">Grout colour <input type="color" bind:value={popt.groutColor} /></label>
          </div>
          <label class="field">Layout
            <select bind:value={popt.layout}>
              {#each Object.entries(LAYOUTS) as [k, l]}<option value={k}>{l}</option>{/each}
            </select>
          </label>
          {#if popt.layout === 'random'}<button onclick={() => (popt.seed = Math.floor(Math.random() * 1e6))}>Shuffle</button>{/if}
          <label class="field">Start pattern
            <select bind:value={popt.align}>
              <option value="corner">Whole tile at top-left</option>
              <option value="center">Centred</option>
            </select>
          </label>
          <Slider label="Margin" bind:value={popt.margin} min={0} max={20} step={0.5} fmt={(v) => `${v} mm`} hint="Unprinted border. Most printers can't print the last ~5 mm." />
          <div class="pair">
            <label class="field">Sheets across <input type="number" min="1" max="8" bind:value={popt.sheetsX} /></label>
            <label class="field">Sheets down <input type="number" min="1" max="8" bind:value={popt.sheetsY} /></label>
          </div>
          <p class="note">
            {fits.across} × {fits.down} whole tiles per sheet, printable area {mm(area.w)} × {mm(area.h)}.
            {#if sheets.length > 1}The {sheets.length} sheets join up once their margins are trimmed.{/if}
            Print at <strong>100% / actual size</strong>, not "fit to page".
          </p>
          <button class="primary big" onclick={print}>Print or save as PDF</button>
          <div class="buttons">
            <button onclick={() => download(`${tile.name}-sheet.svg`, sheetSVG(popt, 0, 0, defs))}>Download sheet SVG</button>
            <label class="btn">Open tile SVG<input type="file" accept=".svg,image/svg+xml" onchange={(e) => openTileSvg(e.currentTarget.files?.[0])} /></label>
          </div>
        </aside>
      </div>
    {/if}
  </main>

  {#if busy}<div class="busy" role="status">{busy}</div>{/if}
</div>

{#if step === 'print' && tile}
  <div class="print-root">
    {#each sheets as [i, j]}
      <div class="page" style:width="{page.w}mm" style:height="{page.h}mm" style:padding="{popt.margin}mm">
        {@html sheetSVG(popt, i, j)}
      </div>
    {/each}
  </div>
{/if}

<style>
  .app {
    max-width: 1200px;
    margin: 0 auto;
    padding: 0 16px 48px;
  }
  .app.dragging {
    outline: 3px dashed var(--accent);
    outline-offset: -8px;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 16px 0;
  }
  h1 {
    font-size: 1.35rem;
    letter-spacing: 0.02em;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .mark {
    width: 22px;
    height: 22px;
    border-radius: 4px;
    background:
      conic-gradient(var(--accent) 0 25%, var(--ink) 0 50%, var(--accent) 0 75%, var(--ink) 0) 0 0 / 11px 11px;
  }
  nav {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .step {
    border-color: transparent;
    background: none;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .step.on {
    border-color: var(--line);
    background: var(--surface);
  }
  .num {
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    font-size: 0.75rem;
    background: var(--line);
  }
  .step.on .num {
    background: var(--accent);
    color: var(--on-accent);
  }
  .split {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 320px;
    gap: 24px;
    align-items: start;
  }
  @media (max-width: 820px) {
    .split {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  @media (max-width: 520px) {
    header {
      padding: 12px 0;
    }
    nav {
      width: 100%;
      flex-wrap: nowrap;
    }
    .step {
      flex: 1;
      padding: 6px 2px;
      font-size: 0.85rem;
    }
    .step .num {
      display: none;
    }
    .split .stage.two {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  .stage {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
    min-width: 0;
  }
  .stage.two {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  figure {
    display: grid;
    gap: 6px;
  }
  figure canvas,
  .square canvas {
    width: 100%;
    height: auto;
    aspect-ratio: 1;
    border-radius: var(--r);
    display: block;
    image-rendering: auto;
  }
  figcaption {
    font-size: 0.85rem;
    color: var(--muted);
  }
  .square {
    width: 100%;
    max-width: min(100%, 72vh);
    margin: 0 auto;
    aspect-ratio: 1;
    border-radius: var(--r);
    overflow: hidden;
  }
  .square :global(svg) {
    width: 100%;
    height: 100%;
    display: block;
  }
  .panel {
    display: grid;
    gap: 16px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--r);
    padding: 16px;
  }
  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .field {
    display: grid;
    gap: 4px;
    font-size: 0.9rem;
  }
  .check {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 0.9rem;
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .big {
    width: 100%;
    padding: 12px;
    font-size: 1rem;
  }
  .note {
    font-size: 0.85rem;
    color: var(--muted);
    line-height: 1.45;
  }
  .error {
    background: var(--bad-bg);
    color: var(--bad);
    border-radius: var(--r);
    padding: 10px 12px;
    margin-bottom: 12px;
  }
  .drop {
    display: grid;
    justify-items: center;
    gap: 12px;
    text-align: center;
    padding: 64px 24px;
    border: 2px dashed var(--line);
    border-radius: calc(var(--r) * 2);
    background: var(--surface);
    cursor: pointer;
    max-width: 640px;
    margin: 24px auto 12px;
    line-height: 1.5;
  }
  .drop strong {
    font-size: 1.2rem;
  }
  .drop span:not(.btn) {
    color: var(--muted);
  }
  .drop + .note {
    text-align: center;
  }
  label.btn input,
  .drop input {
    display: none;
  }
  .swatches {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
  .swatch {
    display: grid;
    justify-items: center;
    gap: 2px;
  }
  .swatch input[type='color'] {
    width: 44px;
    height: 44px;
  }
  .pct {
    font-size: 0.75rem;
    color: var(--muted);
  }
  .mini {
    font-size: 0.7rem;
    padding: 1px 6px;
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
    text-decoration: underline;
  }
  .seg {
    display: flex;
    gap: 4px;
    justify-content: center;
  }
  .seg button.on {
    background: var(--ink);
    color: var(--bg);
  }
  .spread {
    display: grid;
    gap: 6px;
    margin: 0 auto;
    width: 100%;
  }
  .sheet {
    background: #fff;
    box-shadow: 0 1px 6px rgb(0 0 0 / 0.25);
    width: 100%;
    overflow: hidden;
  }
  .sheet :global(svg) {
    width: 100%;
    height: 100%;
    display: block;
  }
  .guided {
    position: relative;
  }
  .guided svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    fill: none;
  }
  .guided .bg {
    stroke: rgb(0 0 0 / 0.55);
    stroke-width: 3;
  }
  .guided .fg {
    stroke: rgb(255 255 255 / 0.9);
    stroke-width: 1;
    stroke-dasharray: 6 4;
  }
  details summary {
    cursor: pointer;
    font-size: 0.9rem;
  }
  .fine {
    display: grid;
    gap: 14px;
    margin-top: 12px;
  }
  .busy {
    position: fixed;
    inset: auto 16px 16px auto;
    background: var(--ink);
    color: var(--bg);
    padding: 10px 14px;
    border-radius: var(--r);
  }
  .defs {
    position: absolute;
    width: 0;
    height: 0;
    overflow: hidden;
  }
  .print-root {
    display: none;
  }
  @media print {
    .app {
      display: none;
    }
    .print-root {
      display: block;
    }
    .page {
      overflow: hidden;
      break-after: page;
      print-color-adjust: exact;
      -webkit-print-color-adjust: exact;
    }
    .page :global(svg) {
      display: block;
    }
  }
</style>
