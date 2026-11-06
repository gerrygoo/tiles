# CLAUDE.md

Notes for agents. `README.md` covers what the app does and how to run it.

## Shape

Same stack and deploy as `~/code/gb` (gb.ggo.blue): Vite + TypeScript + Svelte 5, static site on
GitHub Pages, no server. Solo repo: push to `main`, no PRs unless asked.

| File | Role |
|---|---|
| `src/lib/image.ts` | `Img` (ImageData-shaped), sRGB/Lab, hex, seeded PRNG |
| `src/lib/warp.ts` | homography, `extractTiles`, D4 ops, `symmetrize`, `combineTiles` (align turns + median) |
| `src/lib/center.ts` | align step: symmetry detection, crop fit (shift/rotation/aspect) on a padded tile |
| `src/lib/colors.ts` | bilateral smoothing, k-means in Lab, mode filter, despeckle |
| `src/lib/vectorize.ts` | pixel-edge tracing → smoothed, RDP-simplified quadratic paths → SVG |
| `src/lib/layout.ts` | print sheets: one infinite tiled plane in mm, each sheet is a viewBox onto it |
| `src/lib/dom.ts` | browser-only: photo loading, canvas painting, downloads, reading a tile SVG |
| `src/App.svelte` | the four steps; pipeline stages are a chain of `$derived` values |
| `src/components/Corners.svelte` | photo with draggable corners, magnifier, tile grid overlay |

`src/lib/*.ts` except `dom.ts` are pure (no DOM), so `node --test` runs them directly (Node 22+
strips types; imports use `.ts` extensions and only erasable syntax: no enums or parameter
properties).

## Decisions

- **Not gb's quantizer.** gb does median cut + dithering on WebGPU for 256-colour GIFs. Tiles
  want 2–10 flat colours and no dither, so k-means in Lab on the CPU; one 512² image is cheap,
  and no WebGPU means it works on any phone (the main use: photographing a wall).
- **Big data in `$state.raw`** (photo, flattened tile). Deep proxies on pixel arrays are slow.
- **Heavy work is synchronous on the main thread**, behind sliders that commit on release
  (`Slider.svelte`). If it gets sluggish on phones at 768/1024 px, move `colors.ts` +
  `vectorize.ts` into a Worker.
- **Palette edits** are writable `$derived` (`colors`, `merge`) that reset when k-means reruns.
- **Vector gaps:** the most common colour is a background rect (not traced); other paths get a
  0.8 px stroke in their own colour to cover slivers between independently smoothed neighbours.
- **Padded flat tile.** `extractTiles` keeps `size/8` px of context per side, so the align step
  can move the crop without re-warping the photo. `center.ts` fits at 64 px (`size` must divide
  by 64, `pad` by `size/64`: true for 384/512/768/1024).
- **Symmetry detection is relative.** Each D4 op is fitted alone and scored against unrelated
  pixels (1 = none). Real photos of symmetric tiles score ~0.3 from glaze/noise, while a small
  asymmetric detail on a clean tile only reaches ~0.2, so no absolute cutoff works: an op
  counts if within 1.6× of the best (floor 0.08, cap 0.6). Small asymmetric details (a dot
  covering ~1% of the tile) are missed, and enforcing symmetry then erases them; the person
  can pick a smaller group or untick "make it exactly symmetric". Zoom is never fitted
  (symmetry is scale-invariant); the repeat preview is how the person sets it.
- **Alignment only uses quarter turns**, never mirrors: a real tile can't be laid mirrored.
- **Print:** `@page { size; margin: 0 }` plus padded `.page` divs; the tile is one
  `<symbol id="tile">` in a hidden SVG that every sheet `<use>`s.

## Testing UI

No browser in CI. Locally, a Playwright Chromium lives in `~/.cache/ms-playwright/chromium-1140`;
drive `npm run preview` with `playwright-core` (`executablePath` to that binary) and the test's
synthetic wall photo. Use `page.pdf({ preferCSSPageSize: true })` after
`emulateMedia({ media: 'print' })` to check the print output.
