/* The roads-and-trails overlay: a rendered raster, drawn by a third party, over our own map.
   Run: node --test scripts/road-overlay.test.mjs   (npm run test:data globs it)

   There is very little logic here to test, and that is the point of the design — the cartography is
   somebody else's. What can go wrong is configuration that fails quietly: a credit the licence
   requires going missing, a blend set where it multiplies against nothing, the approach line being
   darkened by the road it traces, or the vector layer this replaced creeping back half-deleted. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = rel => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const app = read('../index.html');
const constant = name => {
  const m = new RegExp(`const ${name}='([^']*)'`).exec(app);
  assert.ok(m, `${name} must be a single-quoted constant in index.html`);
  return m[1];
};

test('credit: OpenTopoMap carries the attribution its CC-BY-SA terms ask for', () => {
  const a = constant('OTM_ATTRIBUTION');
  assert.match(a, /OpenStreetMap/, 'the data');
  assert.match(a, /contributors/, 'OSM credits its contributors, not itself');
  assert.match(a, /SRTM/, 'the terrain the hillshade comes from');
  assert.match(a, /Map style/i, 'the style credit — the part the old string left out');
  assert.match(a, /CC-BY-SA/, 'and the licence mark');
});

test('credit: the basemap and the overlay share the one compliant string', () => {
  assert.match(app, /topo:L\.tileLayer\(OTM_URL,\{[^}]*attribution:OTM_ATTRIBUTION/,
    'the OpenTopoMap basemap uses the shared credit');
  assert.ok(!/attribution:'© OpenStreetMap, SRTM \| OpenTopoMap'/.test(app), 'the short credit is gone');
  const block = app.slice(app.indexOf('const ROAD_OVERLAYS={'), app.indexOf('const ROAD_OVERLAY='));
  assert.match(block, /opentopomap:\{[^]*?attribution:OTM_ATTRIBUTION/, 'and so does the overlay');
});

test('fallback: Stadia is configured, credited, and selectable without a code change', () => {
  const block = app.slice(app.indexOf('const ROAD_OVERLAYS={'), app.indexOf('const ROAD_OVERLAY='));
  assert.match(block, /stadia:\{[^]*?tiles\.stadiamaps\.com\/tiles\/stamen_terrain_lines/, 'the lines-only style');
  for (const who of ['Stadia Maps', 'Stamen Design', 'OpenMapTiles', 'OpenStreetMap'])
    assert.match(block.slice(block.indexOf('stadia:')), new RegExp(who), `Stadia's credit names ${who}`);
  assert.match(app, /new URLSearchParams\(location\.search\)\.get\('roads'\)/, '?roads= picks a source');
  assert.match(app, /return q&&ROAD_OVERLAYS\[q\]\?q:'opentopomap'/,
    'an unknown value falls back to the default rather than to nothing');
});

test('blend: the multiply and the filter are set on the pane, not on the layer inside it', () => {
  /* A Leaflet pane is a stacking context. A mix-blend-mode on the tile layer's own container blends
     against the pane's empty backdrop, which multiplies against transparency and changes nothing. */
  assert.match(app, /roadsPane\.style\.cssText\+=';'\+ROAD_OVERLAYS\[ROAD_OVERLAY\]\.css/);
  const otm = /opentopomap:\{[^]*?css:'([^']*)'/.exec(app)[1];
  assert.match(otm, /mix-blend-mode:multiply/, 'OpenTopoMap is opaque, so it has to be multiplied');
  assert.match(otm, /brightness\([\d.]+\) contrast\([\d.]+\)/, 'with its fills whitened first');
  assert.match(otm, /saturate\(\.\d+\)/, 'and desaturated only partly');
  assert.ok(!/grayscale/.test(otm), 'full greyscale turns a blue stream into a black line that reads as a track');
  assert.ok(!/className:'[^']*multiply/.test(app), 'no blend class on a tile layer');
});

test('panes: fills, then roads, then the approach line', () => {
  const z = name => Number(new RegExp(`${name}\\.style\\.zIndex=(\\d+)`).exec(app)?.[1]
    ?? new RegExp(`createPane\\('${name}'\\)\\.style\\.zIndex=(\\d+)`).exec(app)?.[1]);
  const roads = z('roadsPane'), approach = z('approach');
  assert.ok(roads > 400, 'above the overlayPane the fills are drawn in (400)');
  assert.ok(approach > roads, 'the approach line is above the multiplied overlay, or the road darkens it');
  const draw = app.slice(app.indexOf('async function drawApproach'), app.indexOf('async function drawApproach') + 1600);
  assert.equal((draw.match(/pane:'approach'/g) || []).length, 2, 'both strokes of the approach line');
});

test('base: the overlay stands down over the basemap that already draws it', () => {
  assert.match(app, /opentopomap:\{[^]*?base:'topo'/);
  assert.match(app, /const roadsRedundant=\(\)=>ROAD_OVERLAYS\[ROAD_OVERLAY\]\.base===baseOrder\[baseIdx\]/);
  assert.match(app, /bases\[baseOrder\[baseIdx\]\]\.addTo\(map\); syncRoads\(\);/, 'switching base re-decides it');
  assert.match(app, /already drawn by this basemap/, 'and the legend says why the switch looks idle');
});

test('honesty: the menu and legend say whose drawing it is and what a line means', () => {
  assert.match(app, /what is mapped, not passable, open or legal/);
  assert.match(app, /mapped, not confirmed passable or open/);
  assert.match(app, /draws them/, 'the legend names the renderer');
});

test('removed: nothing of the vector layer is left to half-work', () => {
  for (const gone of ['TrailCanvas', 'trailLayer', 'lineCat', 'LINE_LAYERS', 'network-tiles', 'tile-source',
                      'TRAILS_MIN_ZOOM', 'NETWORK_OMITS'])
    assert.ok(!app.includes(gone), `index.html still mentions ${gone}`);
  for (const f of ['../src/tile-source.mjs', './build-network-tiles.mjs', '../data/network-tiles'])
    assert.ok(!fs.existsSync(fileURLToPath(new URL(f, import.meta.url))), `${f} should be deleted`);
  const bake = read('./build-access.mjs');
  assert.ok(!/writeNetworkTiles|network-tiles/.test(bake), 'the bake no longer writes map tiles');
  const acc = read('../src/access.mjs');
  assert.ok(!/TRAILS_MIN_ZOOM|NETWORK_OMITS/.test(acc), 'nor does access.mjs carry layer-only constants');
});
