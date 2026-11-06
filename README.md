# tiles

Photograph a tiled wall, get the tile's design back as a clean vector, and print sheets covered
in it. Live at https://tiles.ggo.blue. Everything runs in the browser; photos never leave the
device.

1. **Photo**: take or choose a photo, drag four corners onto a block of `cols × rows` tiles.
2. **Align**: the block is flattened (perspective removed) and the tiles are merged with a
   per-pixel median, lining up tiles that were laid turned. The tile's symmetry is detected and
   the crop shifted, turned and stretched to centre the design on it, then the symmetry is
   enforced exactly. Zoom is set by hand against a 3×3 repeat preview, until the seams meet.
3. **Colours**: k-means picks 2–10 flat colours; swatches can be recoloured or merged, specks
   removed.
4. **Vector**: each colour is traced to smooth SVG paths. Download SVG or PNG.
5. **Print**: paper, tile size in mm, grout, layout (straight, pinwheel, mirrored, checker,
   brick, random turns), multi-sheet spreads that join up. Print or save as PDF from the browser.

## Develop

```bash
nvm use
npm install
npm run dev      # http://localhost:5173
npm test         # pipeline tests on a synthetic photographed wall
npm run check    # svelte-check + tsc
```

`TILES_TEST_OUT=/some/dir npm test` also writes the test's photo, flat tile, colours, SVG and a
print sheet there for eyeballing.

## Deploy

Push to `main`: GitHub Actions builds and publishes to GitHub Pages (`public/CNAME` →
`tiles.ggo.blue`), same as gb.
