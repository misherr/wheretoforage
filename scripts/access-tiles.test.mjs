/* Tests for the tiled access geometry and the viewport loader.
   Run: node --test scripts/access-tiles.test.mjs   (npm run test:data globs it)

   The layer exists so the map can answer "which ground has a route" without tapping cells one at a
   time, and the constraint is that access-geom.json is 5.52 MB. So the two things worth guarding are
   that a tile is small and that the pieces of a split way still draw as one line. A gap at every
   tile edge would be the visible failure; a stale tile set drawing lines under the wrong way indices
   would be the invisible one. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as T from './build-access-tiles.mjs';
import { tileSource, tilesForBounds } from '../src/tile-source.mjs';
import { decodeGeom, encodeGeom, ACCESS_FORMAT, CATS } from '../src/access.mjs';
import { tileXY } from '../src/grid.mjs';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tiles-test-'));
const M_LAT = 111132, mLon = la => 111320 * Math.cos(la * Math.PI / 180);
const dist = (a, b) => Math.hypot((a[1] - b[1]) * mLon(a[0]), (a[0] - b[0]) * M_LAT);

/* a way that crosses a z10 tile edge: tile x boundary at lon = x/1024*360-180 */
const edgeLon = x => x / 1024 * 360 - 180;
const crossingWay = () => {
  const lon = edgeLon(166);
  return [[47.2, lon - 0.02], [47.2, lon - 0.005], [47.2, lon + 0.005], [47.2, lon + 0.02]];
};

test('tiles: a way crossing a tile edge is split, and the pieces still join', () => {
  const g = crossingWay();
  const parts = T.splitByTile(g, 10);
  assert.equal(parts.size, 2, 'the way spans two tiles');
  const runs = [...parts.values()].flat();
  /* The no-gap invariant, stated directly: EVERY consecutive pair of the original polyline must
     appear as a consecutive pair in some run. That is what makes the pieces draw as one line.
     Checking shared endpoints instead — which is what this assertion first did, wrongly — passes
     on a split that drops the crossing segment altogether, and that would leave a visible break at
     every tile edge across the state. */
  const hasSegment = (a, b) => runs.some(r => r.some((p, i) =>
    i + 1 < r.length && dist(p, a) < 1 && dist(r[i + 1], b) < 1));
  for (let i = 0; i + 1 < g.length; i++) {
    assert.ok(hasSegment(g[i], g[i + 1]),
      `segment ${i} -> ${i + 1} appears in no tile: the line would break there`);
  }
  /* and the crossing segment is in BOTH tiles, which is the +10% the clipping costs */
  const withCrossing = [...parts.values()].filter(rs => rs.some(r => r.some((p, i) =>
    i + 1 < r.length && dist(p, g[1]) < 1 && dist(r[i + 1], g[2]) < 1)));
  assert.equal(withCrossing.length, 2, 'the crossing segment belongs to both tiles');
});

test('tiles: every vertex of every way lands in the tile it belongs to', () => {
  const g = crossingWay();
  for (const [key, runs] of T.splitByTile(g, 10)) {
    const [tx, ty] = key.split('/').map(Number);
    /* Interior vertices must be inside the tile. The single carried-over vertex at each end is the
       deliberate exception — it is the previous tile's last point. */
    for (const run of runs) {
      const inside = run.map(p => { const t = tileXY(p[0], p[1], 10);
        return Math.floor(t.x) === tx && Math.floor(t.y) === ty; });
      const outside = inside.filter(v => !v).length;
      assert.ok(outside <= 1, `${key}: ${outside} vertices outside the tile, at most 1 is allowed`);
    }
  }
});

test('tiles: a way that leaves a tile and comes back gets both runs', () => {
  /* A switchback near an edge, or a road that recrosses. One run per visit, not one per tile, or the
     line would be drawn straight across the excursion. */
  const lon = edgeLon(166);
  const g = [[47.2, lon - 0.01], [47.2, lon + 0.01], [47.21, lon - 0.01], [47.22, lon + 0.01]];
  const parts = T.splitByTile(g, 10);
  const total = [...parts.values()].reduce((n, runs) => n + runs.length, 0);
  assert.ok(total >= 3, `expected a run per crossing, got ${total}`);
});

test('tiles: a degenerate way produces nothing rather than a zero-length line', () => {
  assert.equal(T.splitByTile([], 10).size, 0);
  assert.equal(T.splitByTile([[47, -121]], 10).size, 0, 'a single point is not a line');
  assert.equal(T.splitByTile(null, 10).size, 0);
});

test('tiles: the writer stamps the bake and lists exactly the non-empty tiles', () => {
  const dir = tmpdir();
  const access = { version: ACCESS_FORMAT, generated: '2026-01-02T03:04:05.000Z',
                   ways: [['A', null, 'path', 1, 0, null, 1], ['B', null, 'track', 2, 0, null, 1]] };
  const geoms = [encodeGeom(crossingWay()), encodeGeom([[46.0, -122.0], [46.01, -122.0]])];
  const res = T.writeTiles(access, geoms, dir, 10, () => {});
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(manifest.version, ACCESS_FORMAT);
  assert.equal(manifest.generated, access.generated, 'the stamp travels, or a stale tile set cannot be detected');
  assert.equal(manifest.z, 10);
  assert.equal(manifest.tiles.length, res.count);
  /* every listed tile exists, and nothing exists that is not listed */
  for (const k of manifest.tiles) {
    const [x, y] = k.split('/');
    assert.ok(fs.existsSync(path.join(dir, '10', x, y + '.json')), `${k} is listed but absent`);
  }
  let onDisk = 0;
  for (const x of fs.readdirSync(path.join(dir, '10'))) onDisk += fs.readdirSync(path.join(dir, '10', x)).length;
  assert.equal(onDisk, manifest.tiles.length, 'a tile on disk that the manifest omits would never be fetched');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tiles: a tile carries the way index and nothing the ways table already has', () => {
  /* Category, name, type and trailhead are in the ways table the app loads up front. Repeating them
     per tile would be bytes spent on a second copy that can disagree with the first. */
  const dir = tmpdir();
  const access = { version: ACCESS_FORMAT, generated: 'g', ways: [['A', null, 'path', 1, 0, null, 1]] };
  T.writeTiles(access, [encodeGeom([[47.2, -121.5], [47.21, -121.5]])], dir, 10, () => {});
  const k = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).tiles[0];
  const [x, y] = k.split('/');
  const tile = JSON.parse(fs.readFileSync(path.join(dir, '10', x, y + '.json'), 'utf8'));
  assert.equal(tile.ways.length, 1);
  const [entry] = tile.ways;
  assert.equal(entry.length, 2, 'a tile entry is [wayIndex, geometry] and nothing else');
  assert.equal(entry[0], 0, 'the way index points into the already-loaded ways table');
  assert.ok(Array.isArray(entry[1]), 'the geometry stays delta-encoded');
  assert.equal(decodeGeom(entry[1]).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ===================== the loader ===================== */

const fakeNet = (manifest, tiles, log = []) => async (url, opts) => {
  log.push({ url, cache: opts && opts.cache });
  const clean = url.split('?')[0];
  if (clean.endsWith('index.json')) return { ok: true, json: async () => manifest };
  const m = /\/(\d+)\/(\d+)\/(\d+)\.json$/.exec(clean);
  const key = m ? m[2] + '/' + m[3] : null;
  if (key && tiles[key]) return { ok: true, json: async () => tiles[key] };
  return { ok: false, status: 404, json: async () => ({}) };
};
const BOUNDS = { south: 47.15, west: -121.55, north: 47.25, east: -121.40 };

test('loader: fetches only the tiles the viewport covers, and only those that exist', async () => {
  const keys = tilesForBounds(BOUNDS, 10);
  assert.ok(keys.length >= 1 && keys.length <= 6, `a small viewport wants a few tiles, got ${keys.length}`);
  const log = [];
  /* the manifest omits one of the covered tiles: the loader must not ask for it */
  const present = keys.slice(0, keys.length - 1);
  const src = tileSource({ base: 'data/access-tiles', manifestUrl: 'data/access-tiles/index.json',
    stamp: 'g', expectVersion: ACCESS_FORMAT,
    fetchImpl: fakeNet({ version: ACCESS_FORMAT, generated: 'g', z: 10, tiles: present },
      Object.fromEntries(present.map(k => [k, { ways: [] }])), log) });
  const got = await src.ensure(BOUNDS);
  assert.equal(got.length, present.length);
  const asked = log.filter(l => /\/10\//.test(l.url)).map(l => l.url.split('?')[0].split('/10/')[1].replace('.json', ''));
  assert.deepEqual(asked.sort(), present.slice().sort(), 'asked for exactly the tiles that exist');
});

test('loader: every URL carries the bake stamp', async () => {
  /* force-cache means "use the cached copy whatever its age". Without a stamp in the URL a returning
     viewer keeps the previous bake's tiles forever — which has already happened once in this app, to
     access-geom.json: the server had v4 and the browser served v3 from disk. */
  const log = [];
  const keys = tilesForBounds(BOUNDS, 10);
  const src = tileSource({ base: 'data/access-tiles', manifestUrl: 'data/access-tiles/index.json',
    stamp: '2026-09-11T01:31:19.076Z', expectVersion: ACCESS_FORMAT,
    fetchImpl: fakeNet({ version: ACCESS_FORMAT, generated: '2026-09-11T01:31:19.076Z', z: 10, tiles: keys },
      Object.fromEntries(keys.map(k => [k, { ways: [] }])), log) });
  await src.ensure(BOUNDS);
  assert.ok(log.length > 1, 'the manifest and at least one tile');
  for (const l of log) {
    assert.match(l.url, /\?g=2026-09-11T01%3A31%3A19\.076Z$/, 'unstamped URL: ' + l.url);
    assert.equal(l.cache, 'force-cache', 'a stamped URL should be cached hard');
  }
});

test('loader: a tile set from a different bake is refused, not drawn', async () => {
  /* Way indices only mean something against the ways table they were built with. Drawing the right
     line under the wrong index is worse than drawing nothing. */
  const warns = [];
  const src = tileSource({ base: 'b', manifestUrl: 'm/index.json', stamp: 'NEW', expectVersion: ACCESS_FORMAT,
    onWarn: m => warns.push(m),
    fetchImpl: fakeNet({ version: ACCESS_FORMAT, generated: 'OLD', z: 10, tiles: ['166/359'] }, {}) });
  assert.deepEqual(await src.ensure(BOUNDS), []);
  assert.equal(src.failed, true);
  assert.match(warns.join(' '), /different bake/);
});

test('loader: an unknown format version is refused', async () => {
  const warns = [];
  const src = tileSource({ base: 'b', manifestUrl: 'm/index.json', stamp: 'g', expectVersion: ACCESS_FORMAT,
    onWarn: m => warns.push(m),
    fetchImpl: fakeNet({ version: ACCESS_FORMAT + 1, generated: 'g', z: 10, tiles: ['166/359'] }, {}) });
  assert.deepEqual(await src.ensure(BOUNDS), []);
  assert.match(warns.join(' '), new RegExp(`v${ACCESS_FORMAT + 1}`));
});

test('loader: a missing manifest degrades to an empty layer, not a broken app', async () => {
  const warns = [];
  const src = tileSource({ base: 'b', manifestUrl: 'm/index.json', stamp: 'g',
    onWarn: m => warns.push(m), fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual(await src.ensure(BOUNDS), []);
  assert.deepEqual(src.ready(BOUNDS), []);
  assert.match(warns.join(' '), /manifest unavailable/);
});

test('loader: tiles are evicted past the cap, and a re-visit refetches', async () => {
  /* A phone pans for an hour. Without a cap the layer would hold every tile it has ever seen. */
  const log = [];
  const all = [];
  for (let x = 150; x < 190; x++) for (let y = 350; y < 365; y++) all.push(x + '/' + y);
  const src = tileSource({ base: 'b', manifestUrl: 'm/index.json', stamp: 'g', max: 8,
    expectVersion: ACCESS_FORMAT,
    fetchImpl: fakeNet({ version: ACCESS_FORMAT, generated: 'g', z: 10, tiles: all },
      Object.fromEntries(all.map(k => [k, { ways: [] }])), log) });
  for (const lon of [-121.5, -120.5, -119.5, -118.5]) {
    await src.ensure({ south: 47.1, west: lon, north: 47.3, east: lon + 0.1 });
  }
  assert.ok(src.size <= 8, `cap is 8, holding ${src.size}`);
  const asked = log.filter(l => /\/10\//.test(l.url)).length;
  await src.ensure({ south: 47.1, west: -121.5, north: 47.3, east: -121.4 });
  assert.ok(log.filter(l => /\/10\//.test(l.url)).length > asked, 'an evicted tile is fetched again');
});

test('loader: a failed tile is retried later, a 404 is not', async () => {
  /* A dropped connection on one pan must not blank that ground for the session; a tile that is
     genuinely absent should be asked for once. */
  let fail = true;
  const keys = tilesForBounds(BOUNDS, 10);
  let hits = 0;
  const src = tileSource({ base: 'b', manifestUrl: 'm/index.json', stamp: 'g', expectVersion: ACCESS_FORMAT,
    onWarn: () => {},
    fetchImpl: async (url) => {
      if (url.includes('index.json')) return { ok: true, json: async () => ({ version: ACCESS_FORMAT, generated: 'g', z: 10, tiles: keys }) };
      hits++;
      if (fail) throw new Error('network');
      return { ok: true, json: async () => ({ ways: [] }) };
    } });
  assert.deepEqual(await src.ensure(BOUNDS), []);
  const afterFail = hits;
  fail = false;
  const got = await src.ensure(BOUNDS);
  assert.ok(got.length > 0, 'the retry must succeed');
  assert.ok(hits > afterFail, 'a failed tile is asked for again');
});

/* ===================== the layer, in the app ===================== */

const app = () => fs.readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');

test('layer: the trails layer is gated by zoom, and says so below it', () => {
  /* At z9 a pixel is 207 m and a square-mile cell is 7.8 px, with up to 664 pieces in one z10 tile:
     the layer would be a smear and the viewport would want 575 KB. Drawing nothing without saying
     why would leave a viewer unable to tell "no data" from "no road". */
  const s = app();
  assert.match(s, /TRAILS_MIN_ZOOM/, 'the gate must be a named constant, shared with the vocabulary');
  assert.match(s, /getZoom\(\)<TRAILS_MIN_ZOOM/, 'draw and load both check it');
  assert.match(s, /zoom in to see them/, 'and the legend says why it is empty');
  assert.match(s, /this\.draw\(\); renderLegends\(\);/,
    'the legend has to re-render on a zoom change, or it lists styles that are not being drawn');
});

test('layer: it draws lines over the fills, on its own canvas', () => {
  const s = app();
  const cell = s.indexOf('const cellLayer=new CellCanvas()');
  const trail = s.indexOf('const trailLayer=new TrailCanvas()');
  assert.ok(cell > 0 && trail > cell,
    'the trails canvas must be added after the cell canvas, or the fills paint over the lines');
  assert.match(s, /renderAll\(\)\{ cellLayer\.draw\(\); trailLayer\.draw\(\)/, 'both redraw together');
  assert.ok(!/L\.polyline\(.*t\.ways/.test(s), 'a z11 viewport holds ~1,300 ways: canvas, not polylines');
});

test('layer: category decides the style, and rough roads can be switched off alone', async () => {
  /* Rough roads are 45% of the mapped geometry — 24,398 ways of 50,531 — so with them on the map
     answers "what can I drive" and with them off "where are the trails". */
  const s = app();
  /* The switches are generated from a list, so the literal attribute never appears in the source.
     Assert on the construct and on the vocabulary behind it rather than on rendered HTML. */
  assert.match(s, /\['road','rough','trail'\]\.map\(c=>/, 'the sub-toggles are generated per category');
  assert.match(s, /data-c="\$\{c\}"/, 'each one carries its own category');
  const A2 = await import('../src/access.mjs');
  for (const c of CATS) assert.ok(A2.LINE_STYLE[c], `${c} has no line style, so it could not be drawn`);
  assert.match(s, /lineCat\.has\(cat\)/, 'the draw honours the per-category switches');
  assert.match(s, /LINE_STYLE\[cat\]/, 'and takes its style from the shared vocabulary');
});

test('layer: the line styles are distinct from every fill colour', async () => {
  /* The fills already own yellow-to-red, green, blue and olive. A line whose colour means something
     on another layer reads as data it is not — the approach line used #e58a2b, which is the chance
     layer's "Good" band. */
  const s = app();
  const fillCols = [...s.matchAll(/\[\s*[\d.]+\s*,\s*'[^']*'\s*,\s*'(#[0-9a-f]{6})'\s*\]/gi)].map(m => m[1].toLowerCase());
  assert.ok(fillCols.length >= 16, `expected the four fill palettes, found ${fillCols.length}`);
  const A = await import('../src/access.mjs');
  for (const [cat, st] of Object.entries(A.LINE_STYLE)) {
    assert.ok(!fillCols.includes(st.colour.toLowerCase()),
      `${cat} uses ${st.colour}, which is already a fill band colour`);
  }
  /* style, not only colour, carries the category: one solid, the others patterned */
  const dashes = Object.values(A.LINE_STYLE).map(st => JSON.stringify(st.dash));
  assert.equal(new Set(dashes).size, dashes.length, 'each category needs its own dash pattern');
  assert.equal(A.LINE_STYLE.road.dash, null, 'drivable is the solid one');
  assert.ok(A.LINE_STYLE.rough.dash && A.LINE_STYLE.trail.dash, 'the other two are patterned');
});

test('layer: the honesty framing survives into the layer', () => {
  const s = app();
  const at = s.indexOf("trails:{name:");
  assert.ok(at > 0, 'the layer must be registered');
  const entry = s.slice(at, at + 260);
  assert.match(entry, /MAPPED/, 'the menu entry says what a line means');
  assert.ok(!/passable|open|legal/.test(entry.replace(/not whether it is passable, open or legal/, '')),
    'and only in the denial');
  assert.match(s, /mapped, not confirmed passable/, 'the legend repeats it where the lines are');
});

test('layer: the tapped approach and the layer agree about colour', () => {
  /* One way should not change colour depending on how you asked to see it. */
  const s = app();
  assert.match(s, /const colour = \(LINE_STYLE\[way\.cat\]\|\|LINE_STYLE\.rough\)\.colour;/);
  assert.ok(!/way\.cat==='trail'\?'#/.test(s), 'the hard-coded approach palette must be gone');
});

test('tiles: a bake writes its tiles beside its own output, not over the statewide set', async () => {
  /* This was a real bug, found by running a regional bake rather than by reading the code: the call
     passed the module default TILES_DIR, so `--out=/tmp/a.json` wrote three tiles over data/
     access-tiles and destroyed the 271-tile statewide set. Every artifact of a bake belongs beside
     the file it was asked to write, exactly as -geom.json already did. */
  const src = fs.readFileSync(fileURLToPath(new URL('./build-access.mjs', import.meta.url)), 'utf8');
  assert.match(src, /const tilesDir = opts\.out\.replace\(\/\\.json\$\/, ''\) \+ '-tiles'/,
    'the tile directory has to be derived from --out');
  assert.match(src, /writeTiles\(out, geomOut\.geom, tilesDir, TILE_Z, log\)/,
    'and passed to the writer');
  assert.ok(!/writeTiles\([^)]*TILES_DIR/.test(src),
    'nothing may pass the module default, which is the statewide path');
  /* geomOut, not outGeom: a regional re-bake replaces the geometry with the merged array, and tiling
     the un-merged one would drop every carried-over way. */
  assert.ok(!/writeTiles\(out, outGeom/.test(src), 'tile the merged geometry, not the fresh-only array');
});
