/* Tests for the access classification and its bake.
   Run: node --test scripts/build-access.test.mjs   (npm run test:data runs it)

   No network: the Overpass and ArcGIS calls are injected, so the geometry and the classification are
   tested against synthetic ways rather than against whatever OSM looks like today.

   The assertion this file exists for is the first one: access must never reach a score. Everything
   else here is about not overclaiming — the data cannot tell "no way exists" from "nobody mapped
   one", and every label has to reflect that. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import * as A from './build-access.mjs';
import * as AC from '../src/access.mjs';
import { cellIndex, cellCenter, DLAT, DLON } from '../src/grid.mjs';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'access-test-'));

/* ===================== the separation that matters ===================== */

test('separation: the model cannot see access, structurally', async () => {
  /* Not a style point. If src/model/ could import access, a later change could quietly let road
     proximity weight a score, and the map would start recommending places because they are easy to
     reach rather than because they grow mushrooms. tests/model/purity.test.mjs already forbids
     src/model/ importing anything outside itself; this checks the other direction — that nothing in
     the model mentions access at all. */
  const dir = fileURLToPath(new URL('../src/model/', import.meta.url));
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.mjs'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/access/i.test(src),
      `src/model/${f} mentions access — the model must not know how reachable a cell is`);
  }
});

test('separation: access.mjs imports nothing from the model', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../src/access.mjs', import.meta.url)), 'utf8');
  for (const m of src.matchAll(/\bfrom\s+(['"])([^'"]+)\1/g)) {
    assert.ok(!/model/.test(m[2]), `src/access.mjs imports ${m[2]}`);
  }
});

/* ===================== classification ===================== */

test('classes: nothing mapped reads as unknown, never as trailless', () => {
  const cls = AC.classifyAccess({ road: -1, trail: -1, rough: -1 });
  assert.equal(cls, 'unknown');
  /* The label is what a user reads at a glance, so it must not assert tracklessness at all. The
     blurb is allowed to say the word — indeed it should, to deny it explicitly — so the two are
     checked differently rather than with one regex that cannot tell a claim from a denial. */
  assert.ok(!/trailless|roadless|no trail|no road/i.test(AC.CLASSES.unknown.label),
    'the at-a-glance label must not claim there is no way, only that none is mapped');
  assert.match(AC.CLASSES.unknown.label, /mapped/i, 'it must say what the map says, not what the ground is');
  assert.match(AC.CLASSES.unknown.blurb, /not\s+(as\s+)?trailless|unknown/i,
    'the explanation must actively warn against reading it as trailless');
  assert.match(AC.CLASSES.unknown.blurb, /nobody has mapped|not been mapped|coverage/i,
    'and must say why absence of data is not absence of a way');
  assert.equal(AC.classifyAccess(null), 'unknown', 'a cell with no access record at all is unknown too');
});

test('classes: every label describes the map rather than the ground', () => {
  // "a way is mapped here", not "a trail exists here" — coverage on private timberland is uneven.
  for (const [name, c] of Object.entries(AC.CLASSES)) {
    assert.match(c.label + ' ' + c.blurb, /mapped/i, `class "${name}" claims more than the data supports`);
  }
});

test('classes: precedence is trail, road, rough, nearby, unknown', () => {
  const near = AC.NEAR - 10, far = AC.REACH - 10, out = -1;
  assert.equal(AC.classifyAccess({ trail: near, road: near, rough: near }), 'trail');
  assert.equal(AC.classifyAccess({ trail: out, road: near, rough: near }), 'road');
  assert.equal(AC.classifyAccess({ trail: out, road: out, rough: near }), 'rough');
  assert.equal(AC.classifyAccess({ trail: out, road: far, rough: out }), 'near',
    'a way beyond NEAR but inside REACH is "nearby", not "in this cell"');
  assert.equal(AC.classifyAccess({ trail: out, road: out, rough: out }), 'unknown');
});

test('classes: the sort key orders by class first, then by how far you walk', () => {
  const easy = { trail: 100, road: -1, rough: -1 };
  const harder = { trail: 700, road: -1, rough: -1 };
  const road = { trail: -1, road: 100, rough: -1 };
  const none = { trail: -1, road: -1, rough: -1 };
  assert.ok(AC.accessRank(easy) < AC.accessRank(harder), 'same class orders by distance');
  assert.ok(AC.accessRank(harder) < AC.accessRank(road), 'class dominates distance');
  assert.ok(AC.accessRank(road) < AC.accessRank(none), 'unknown sorts last');
});

test('classes: a rough way is reported as rough even when it is drivable-looking', () => {
  // 4wd-only and dirt-surfaced roads are the ones people drive to and then wish they had not.
  assert.equal(AC.osmCategory({ highway: 'unclassified' }), 'road');
  assert.equal(AC.osmCategory({ highway: 'unclassified', '4wd_only': 'yes' }), 'rough');
  assert.equal(AC.osmCategory({ highway: 'residential', surface: 'dirt' }), 'rough');
  assert.equal(AC.osmCategory({ highway: 'track' }), 'rough', 'a track is a skid road until proven otherwise');
  assert.equal(AC.osmCategory({ highway: 'road' }), 'rough', 'highway=road means "unknown", not "drivable"');
});

test('classes: decommissioned and unnamed ways are kept, not dropped', () => {
  // These are the ways that reach cut-over timber, and the ones most apps hide.
  assert.equal(AC.osmCategory({ 'abandoned:highway': 'track' }), 'rough');
  assert.equal(AC.osmCategory({ 'disused:highway': 'service' }), 'rough');
  assert.equal(AC.osmCategory({ 'razed:highway': 'track' }), 'rough');
  assert.equal(AC.osmCategory({ highway: 'track' }), 'rough', 'no name required');
  assert.equal(AC.osmCategory({ highway: 'service', service: 'forestry' }), 'rough',
    'a forestry spur counts even though a generic service road does not');
  assert.equal(AC.osmCategory({ highway: 'service' }), null, 'but a bare service road is a driveway');
  assert.equal(AC.osmCategory({ highway: 'footway' }), null, 'and a footway is a sidewalk here');
});

test('classes: USFS maintenance level splits drivable from unmaintained', () => {
  for (const ml of ['3 - SUITABLE FOR PASSENGER CARS', '4 - MODERATE DEGREE OF USER COMFORT', '5 - HIGH DEGREE OF USER COMFORT'])
    assert.ok(AC.USFS_DRIVABLE_ML.test(ml), ml + ' should be drivable');
  for (const ml of ['1 - BASIC CUSTODIAL CARE (CLOSED)', '2 - HIGH CLEARANCE VEHICLES', ''])
    assert.ok(!AC.USFS_DRIVABLE_ML.test(ml), ml + ' should not be drivable');
});

test('classes: distances render in the units the rest of the app uses', () => {
  assert.equal(AC.accessDistance(-1), null);
  assert.equal(AC.accessDistance(null), null);
  assert.match(AC.accessDistance(120), /ft$/);
  assert.match(AC.accessDistance(1600), /mi$/);
});

/* ===================== geometry ===================== */

/* stampWay works on {cells, nearest}: cells maps a cell index to its centre, nearest accumulates
   the closest way per category as {d, wid, arc}. */
const mkState = (centres) => {
  const cells = new Map();
  for (const [lat, lon] of centres) {
    const [i, j] = cellIndex(lat, lon);
    cells.set(i + ':' + j, [lat, lon]);
  }
  return { cells, nearest: new Map() };
};
const only = st => [...st.nearest.values()][0] || {};

test('geometry: a way through a cell records its distance, identity and position along it', () => {
  const [lat, lon] = cellCenter(3300, -5700);
  const st = mkState([[lat, lon]]);
  A.stampWay(st, [[lat, lon - 0.02], [lat, lon + 0.02]], 'road', 'w1');
  const rec = only(st);
  assert.ok(rec.road && rec.road.d < 60, 'expected a near-zero distance, got ' + (rec.road && rec.road.d));
  assert.equal(rec.road.wid, 'w1', 'the way that was nearest must be recorded, not just how far it was');
  assert.ok(rec.road.arc > 0, 'and how far along it, which is what a walk figure needs');
  assert.equal(rec.trail, undefined, 'other categories must stay untouched');
});

test('geometry: densification stops a long segment skipping past a cell', () => {
  /* Two endpoints far outside the cell, with the segment passing right through it. Recording only
     the vertices would miss it entirely, and the cell would read as unknown while a highway runs
     down the middle of it. */
  const [lat, lon] = cellCenter(3300, -5700);
  const st = mkState([[lat, lon]]);
  A.stampWay(st, [[lat, lon - 0.5], [lat, lon + 0.5]], 'road', 'w1');
  const rec = only(st);
  assert.ok(rec.road && rec.road.d < 60, 'long segment was not sampled through the cell');
});

test('geometry: a way beyond the cap leaves the cell unknown', () => {
  const [lat, lon] = cellCenter(3300, -5700);
  const st = mkState([[lat, lon]]);
  A.stampWay(st, [[lat + 0.5, lon], [lat + 0.5, lon + 0.01]], 'road', 'w1');
  assert.equal(st.nearest.size, 0, 'nothing within the cap must leave no record at all');
});

test('geometry: the nearest way wins, and its identity comes with it', () => {
  const [lat, lon] = cellCenter(3300, -5700);
  const st = mkState([[lat, lon]]);
  A.stampWay(st, [[lat + 0.01, lon], [lat + 0.01, lon + 0.001]], 'trail', 'far');
  const far = only(st).trail.d;
  A.stampWay(st, [[lat + 0.001, lon], [lat + 0.001, lon + 0.001]], 'trail', 'near');
  const rec = only(st);
  assert.ok(rec.trail.d < far, 'a closer way must replace a further one');
  assert.equal(rec.trail.wid, 'near', 'and the recorded identity must follow the distance');
});

test('geometry: nearestOnWay reports both distance and position along the line', () => {
  const line = [[47.5, -121.5], [47.5, -121.4]];
  const mid = A.nearestOnWay(line, 47.5, -121.45);
  assert.ok(mid.d < 5, 'a point on the line should be ~0 m away');
  const end = A.nearestOnWay(line, 47.5, -121.5);
  assert.ok(mid.arc > end.arc, 'a point halfway along must have a larger arc than the start');
});

/* ===================== tiling ===================== */

test('tiles: only areas that contain cells are queried', () => {
  const cells = [{ lat: 47.5, lon: -121.5 }, { lat: 47.51, lon: -121.49 }, { lat: 48.9, lon: -117.5 }];
  const tiles = A.tilesFor(cells, { lat0: 45, lat1: 49, lon0: -125, lon1: -116 });
  assert.equal(tiles.length, 2, 'two clusters, two tiles — not a full grid over the state');
  for (const t of tiles) assert.ok(t.n_cells > 0);
});

test('tiles: each tile is padded so a way just outside still reaches cells inside', () => {
  const cells = [{ lat: 47.5, lon: -121.5 }];
  const [t] = A.tilesFor(cells, { lat0: 45, lat1: 49, lon0: -125, lon1: -116 });
  assert.ok(t.s < 47.5 && t.n > 47.5 && t.w < -121.5 && t.e > -121.5);
  assert.ok((t.n - t.s) * 111000 > 2 * AC.CAP * 0.9,
    'the pad must be at least the distance cap, or an edge cell misses ways just outside');
});

test('tiles: a region bake only queries that region', () => {
  const cells = [{ lat: 47.5, lon: -121.5 }, { lat: 46.0, lon: -124.0 }];
  const tiles = A.tilesFor(cells, { lat0: 47.0, lat1: 48.0, lon0: -122.0, lon1: -121.0 });
  assert.equal(tiles.length, 1);
});

/* ===================== the bake, end to end, offline ===================== */

function fakeDeps(counts = {}) {
  counts.osm = 0; counts.arc = 0;
  return {
    /* A named trail across the northern half, a drivable road along the southern edge that the trail
       ends on (so a trailhead is inferred), and an unnamed track. Checkable by hand rather than by
       whatever the fixture happens to produce. */
    overpass: async (s, w, n, e, cb) => {
      counts.osm++;
      const mid = (s + n) / 2;
      cb({ type: 'way', id: 101, tags: { highway: 'residential', name: 'River Road' },
           geometry: [{ lat: s + 0.005, lon: w }, { lat: s + 0.005, lon: e }] });
      // starts on River Road, runs north: its south end is within TH_SNAP of the road
      cb({ type: 'way', id: 102, tags: { highway: 'path', name: 'Bear Creek Trail' },
           geometry: [{ lat: s + 0.005, lon: (w + e) / 2 }, { lat: mid + 0.01, lon: (w + e) / 2 }] });
      /* This one deliberately runs half a degree past the eastern edge of the cells. Only its
         western end is near anything, so the clip that used to trim a way to the stretch within
         2.6 km of a referencing cell would cut most of it off. */
      cb({ type: 'way', id: 103, tags: { highway: 'track' },
           geometry: [{ lat: n - 0.01, lon: w }, { lat: n - 0.01, lon: e },
                      { lat: n - 0.01, lon: e + 0.5 }] });
      cb({ type: 'way', id: 104, tags: { highway: 'footway' },
           geometry: [{ lat: mid, lon: w }, { lat: mid, lon: e }] });
    },
    arcgis: async () => { counts.arc++; return { features: [] }; },
    /* A synthetic Terrarium tile that rises 4 m per pixel eastward, so a route running east climbs
       steadily and the gain arithmetic has real bytes to work from rather than a stub. */
    tileFetch: async () => {
      counts.tiles = (counts.tiles || 0) + 1;
      const W = 256, px = new Uint8Array(W * W * 3);   // real tile size: elevationProfile indexes to 255
      for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
        const v = Math.round((500 + x * 4 + 32768) * 256);
        const i = (y * W + x) * 3;
        px[i] = (v >> 16) & 255; px[i + 1] = (v >> 8) & 255; px[i + 2] = v & 255;
      }
      const buf = encodePNG(W, W, 3, px);
      return { ok: true, status: 200, arrayBuffer: async () => buf };
    },
  };
}

/* Minimal PNG encoder, filter 0 — enough to feed the real decoder real bytes. */
function encodePNG(width, height, channels, pixels) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = { 1: 0, 2: 4, 3: 2, 4: 6 }[channels]; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < stride; x++) raw[y * (stride + 1) + 1 + x] = pixels[y * stride + x] & 255;
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const cellsFixture = (dir) => {
  const rows = [];
  for (let i = 3300; i < 3306; i++) for (let j = -5700; j < -5694; j++) {
    const [lat, lon] = cellCenter(i, j);
    rows.push([lat, lon, 900, 5, 180, null]);
  }
  const f = path.join(dir, 'cells.json');
  fs.writeFileSync(f, JSON.stringify({ version: 2, generated: '2026-01-01T00:00:00.000Z', names: [], rows }));
  return { file: f, rows };
};

test('bake: produces at most one row per cell, keyed by cell index', async () => {
  const dir = tmpdir();
  const { rows } = cellsFixture(dir);
  const out = path.join(dir, 'access.json');
  const opts = A.parseArgs([`--cells=${path.join(dir, 'cells.json')}`, `--out=${out}`,
    '--bbox=47,-123,49,-121', '--skip-usfs']);
  const r = await A.build(opts, fakeDeps());
  /* A cell with nothing mapped within the cap gets NO ROW, deliberately: the app reads a missing row
     as unknown, which is the same answer and costs nothing to store. So rows <= cells, and the ones
     left out are exactly the ones the fixture's ways do not reach. */
  assert.ok(r.rows.length > 0 && r.rows.length <= rows.length,
    `${r.rows.length} rows for ${rows.length} cells`);
  for (const row of r.rows) assert.equal(row.length, AC.ROW_WIDTH,
    'rows are [i, j], then distance/way/walk/gain per category, then the mode columns');
  for (const row of r.rows) {
    const d = AC.decodeRow(row), m = AC.decodeModes(row);
    assert.ok(AC.CATS.some(c => d[c] >= 0) || m.hike || m.worst,
      'a row exists only when something was found — a nearby way, or a route over the network');
  }
  const keys = new Set(r.rows.map(x => x[0] + ':' + x[1]));
  assert.equal(keys.size, r.rows.length, 'cell indices must be unique — one row per cell, no repeats');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bake: the synthetic trail and road land in the right cells', async () => {
  const dir = tmpdir();
  cellsFixture(dir);
  const out = path.join(dir, 'access.json');
  const opts = A.parseArgs([`--cells=${path.join(dir, 'cells.json')}`, `--out=${out}`,
    '--bbox=47,-123,49,-121', '--skip-usfs']);
  const r = await A.build(opts, fakeDeps());
  const classes = {};
  for (const row of r.rows) {
    const c = AC.classifyAccess(AC.decodeRow(row));
    classes[c] = (classes[c] || 0) + 1;
  }
  assert.ok(classes.trail > 0, 'the path should produce trail cells');
  assert.ok((classes.road || 0) + (classes.near || 0) + (classes.rough || 0) > 0,
    'the road and track should register too');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bake: records provenance including both sources and the cells file it matched', async () => {
  const dir = tmpdir();
  cellsFixture(dir);
  const opts = A.parseArgs([`--cells=${path.join(dir, 'cells.json')}`, `--out=${path.join(dir, 'a.json')}`,
    '--bbox=47,-123,49,-121', '--skip-usfs']);
  const r = await A.build(opts, fakeDeps());
  const p = r.provenance;
  assert.equal(p.generator, 'scripts/build-access.mjs');
  assert.ok(p.sources.osm && p.sources.usfs_roads && p.sources.usfs_trails, 'both sources must be named');
  assert.equal(p.sources.osm.licence, 'ODbL', 'OSM attribution is a licence condition, not a nicety');
  assert.equal(p.cells_generated, '2026-01-01T00:00:00.000Z',
    'the cells.json it was baked against must be recorded, so a mismatch is detectable');
  assert.equal(r.cap_m, AC.CAP);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bake: a regional re-bake replaces its own cells and carries the rest through', () => {
  /* Way indices are local to a file, so merging has to concatenate the two tables, re-point the
     carried-over rows, and drop any way nothing references any more — otherwise a few regional
     bakes would leave the file full of dead geometry. */
  const g = n => AC.encodeGeom([[47 + n / 100, -121], [47 + n / 100, -120.99]]);
  /* v5: 2 + 3 categories x ROW_STRIDE 5 = 17 numbers, [d, wayIndex, onWalk, onGain, offGain] per
     category in CATS order (road, trail, rough). The literals are spelled out rather than generated
     so that a stride change breaks this fixture loudly instead of quietly re-slicing it. */
  const prev = { version: 5, generated: 'old', cap_m: 2000, provenance: { counts: {} },
    ways: [['Old Road', null, 'unclassified', 0, 0, null, 1], ['Dead Way', null, 'track', 2, 0, null, 1]],
    rows: [[10, 20, 100, 0, -1, -1, -1,  -1, -1, -1, -1, -1,  -1, -1, -1, -1, -1],
           [10, 21, -1, -1, -1, -1, -1,  -1, -1, -1, -1, -1,  700, 1, -1, -1, -1]] };
  const prevGeom = [g(1), g(2)];
  const fresh = { version: 5, generated: 'new', cap_m: 2000, provenance: { counts: {} },
    ways: [['New Trail', null, 'path', 1, 2, 555, 1]],
    rows: [[10, 21, -1, -1, -1, -1, -1,  42, 0, 17, 120, 35,  -1, -1, -1, -1, -1]] };
  const freshGeom = [g(3)];
  const { merged: m, geom: mg } = A.mergeInto(prev, fresh, prevGeom, freshGeom);
  assert.equal(m.rows.length, 2, 'no cell may be lost');
  const byKey = Object.fromEntries(m.rows.map(r => [r[0] + ':' + r[1], r]));
  const nameOf = (row, cat) => {
    const d = AC.decodeRow(row);
    const wi = d[cat + 'Way'];
    return wi >= 0 ? AC.wayLabel(AC.decodeWay(m.ways[wi])) : null;
  };
  assert.equal(nameOf(byKey['10:21'], 'trail'), 'New Trail', 'the rebaked cell takes the fresh way');
  assert.equal(AC.decodeRow(byKey['10:21']).trail, 42, 'and the fresh distance');
  assert.equal(AC.decodeRow(byKey['10:21']).trailOffGain, 35, 'including the off-trail climb column');
  assert.equal(nameOf(byKey['10:20'], 'road'), 'Old Road', 'an untouched cell keeps pointing at its own way');
  assert.ok(!m.ways.some(w => w[0] === 'Dead Way'), 'a way nothing references any more must be dropped');
  assert.equal(m.provenance.counts.carried_over, 1);
  /* The two files have to move in lockstep, or the app draws the wrong line for a cell. */
  assert.equal(mg.length, m.ways.length, 'geometry must be dropped and reindexed with the ways');
  const trailIdx = AC.decodeRow(byKey['10:21']).trailWay;
  assert.deepEqual(AC.decodeGeom(mg[trailIdx]), AC.decodeGeom(freshGeom[0]),
    'the surviving way must still be paired with its own geometry');
});

test('bake: the Overpass query asks for the ways that matter and skips the ones that do not', () => {
  const q = A.overpassQuery(47, -122, 48, -121);
  for (const kind of ['track', 'path', 'unclassified', 'bridleway'])
    assert.ok(q.includes(kind), `the query must ask for ${kind}`);
  assert.ok(/abandoned:highway/.test(q) && /disused:highway/.test(q) && /razed:highway/.test(q),
    'decommissioned spurs are the point, not an extra');
  assert.ok(/service.*forestry/.test(q), 'forestry spurs must be requested explicitly');
  assert.ok(!/\bfootway\b/.test(q.split('service')[0]),
    'sidewalks would dominate the urban tiles and are not trails');
});

/* ===================== way identity ===================== */

test('identity: the nearest way is named, not just classified', async () => {
  const dir = tmpdir();
  cellsFixture(dir);
  const opts = A.parseArgs([`--cells=${path.join(dir, 'cells.json')}`,
    `--out=${path.join(dir, 'a.json')}`, '--bbox=47,-123,49,-121', '--skip-usfs']);
  const r = await A.build(opts, fakeDeps());
  const names = new Set();
  for (const row of r.rows) {
    const det = AC.accessDetail(AC.decodeRow(row), r.ways);
    if (det.wayName) names.add(det.wayName);
  }
  assert.ok(names.has('Bear Creek Trail'), 'the trail should be named: got ' + [...names].join(', '));
  assert.ok([...names].some(n => /River Road|unnamed track/.test(n)), 'other ways should be named too');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('identity: an unnamed way says so rather than going blank', () => {
  // An unnamed track is often exactly the thing that reaches cut-over timber. "unnamed track" and
  // "nothing here" are different answers and must not collapse into each other.
  assert.equal(AC.wayLabel({ name: null, ref: null, type: 'track' }), 'unnamed track');
  assert.equal(AC.wayLabel({ name: null, ref: null, type: 'unclassified' }), 'unnamed road');
  assert.equal(AC.wayLabel(null), null, 'and no way at all is null, not "unnamed"');
});

test('identity: USFS road numbers and shouted trail names read properly', () => {
  assert.equal(AC.wayLabel({ name: null, ref: '2703', type: 'nfsr' }), 'Forest Road 2703');
  assert.equal(AC.wayLabel({ name: 'SETTLER', ref: '1060020', type: 'nfsr' }), 'Forest Road 1060020 (Settler)');
  assert.equal(AC.wayLabel({ name: 'SHUKSAN LAKE', ref: null, type: 'nfst' }), 'Shuksan Lake Trail');
  assert.equal(AC.wayLabel({ name: 'Wonderland Trail', ref: null, type: 'path' }), 'Wonderland Trail',
    'an already-cased OSM name must not be re-cased');
  assert.equal(AC.tidyName('PCT'), 'PCT', 'an acronym must survive tidying');
});

/* ===================== geometry ===================== */

test('geometry: delta encoding round-trips to within a metre', () => {
  const g = [[47.5, -121.5], [47.5123, -121.4987], [47.52, -121.47]];
  const back = AC.decodeGeom(AC.encodeGeom(g));
  assert.equal(back.length, g.length);
  for (let i = 0; i < g.length; i++) {
    const dy = (g[i][0] - back[i][0]) * 111320, dx = (g[i][1] - back[i][1]) * 75000;
    assert.ok(Math.hypot(dx, dy) < 1.5, 'point ' + i + ' moved ' + Math.hypot(dx, dy).toFixed(2) + ' m');
  }
});

test('geometry: it is shared by way, not duplicated per cell', async () => {
  /* This is the whole reason the file is 8 MB and not 47 MB — both measured, see docs/access.md.
     Many cells reference the same way, so the ways table must be far smaller than the row count. */
  const dir = tmpdir();
  const { rows } = cellsFixture(dir);
  const opts = A.parseArgs([`--cells=${path.join(dir, 'cells.json')}`,
    `--out=${path.join(dir, 'a.json')}`, '--bbox=47,-123,49,-121', '--skip-usfs']);
  const r = await A.build(opts, fakeDeps());
  assert.ok(r.ways.length < rows.length / 4,
    `${r.ways.length} ways for ${rows.length} cells — geometry is being duplicated`);
  // every way index in a row must resolve
  for (const row of r.rows) for (const n of [3, 3 + AC.ROW_STRIDE, 3 + 2 * AC.ROW_STRIDE]) {
    if (row[n] >= 0) assert.ok(r.ways[row[n]], 'row points at way ' + row[n] + ' which does not exist');
  }
  for (const w of r.ways) assert.equal(w.length, 7,
    'a way entry carries name, ref, type, category, trailhead kind, OSM id and segment count');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('geometry: simplification keeps the shape and drops the redundant points', () => {
  const straight = [];
  for (let i = 0; i <= 50; i++) straight.push([47.5 + i * 0.0002, -121.5]);
  const s2 = A.simplify(straight, 25);
  assert.ok(s2.length < 5, 'a straight line needs two points, got ' + s2.length);
  assert.deepEqual(s2[0], straight[0]);
  assert.deepEqual(s2[s2.length - 1], straight[straight.length - 1], 'the ends must survive');

  const zigzag = [];
  for (let i = 0; i <= 20; i++) zigzag.push([47.5 + i * 0.002, -121.5 + (i % 2 ? 0.004 : 0)]);
  assert.ok(A.simplify(zigzag, 25).length > 10, 'real corners must be kept');
});

test('geometry: full length is stored, because clipping truncated every tapped trail', async () => {
  /* There used to be a clip here keeping only the stretch within 2.6 km of a referencing cell. It
     removed 3.7% of points statewide — 621,072 to 598,127 — and truncated any tapped trail whose far
     end ran past the cells, so it was costing the feature and buying almost nothing. The fixture's
     track runs half a degree past the cells on purpose: with the clip back, this fails. */
  const dir = tmpdir();
  cellsFixture(dir);
  const opts = A.parseArgs([`--cells=${path.join(dir, 'cells.json')}`,
    `--out=${path.join(dir, 'a.json')}`, '--bbox=47,-123,49,-121', '--skip-usfs', '--skip-elevation']);
  const r = await A.build(opts, fakeDeps());
  assert.equal(r.provenance.geometry.clipped, false, 'the output must record that it is unclipped');
  const g = JSON.parse(fs.readFileSync(path.join(dir, 'a-geom.json'), 'utf8')).geom;
  let widest = 0;
  for (const flat of g) {
    const lons = AC.decodeGeom(flat).map(p => p[1]);
    widest = Math.max(widest, Math.max(...lons) - Math.min(...lons));
  }
  assert.ok(widest > 0.4,
    'the track running past the cells was shortened — is the clip back? widest span ' + widest.toFixed(3));
  assert.equal(A.clipToCells, undefined, 'and the clip itself must be gone, not merely unused');
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ===================== the walk ===================== */

test('walk: a trail ending on a road gets an inferred trailhead and a distance along it', async () => {
  /* There is no USFS trailheads dataset and OSM's highway=trailhead tag is sparse — 13 nodes across
     six sample tiles — so the walk figure would be almost never available without this inference. */
  const dir = tmpdir();
  cellsFixture(dir);
  const opts = A.parseArgs([`--cells=${path.join(dir, 'cells.json')}`,
    `--out=${path.join(dir, 'a.json')}`, '--bbox=47,-123,49,-121', '--skip-usfs']);
  const r = await A.build(opts, fakeDeps());
  const trailWays = r.ways.filter(w => w[2] === 'path');
  assert.ok(trailWays.length, 'the fixture has a path');
  assert.ok(trailWays.some(w => w[4] === AC.TRAILHEAD_INFERRED),
    'a trail whose end sits on a road should get an inferred trailhead');

  let walks = 0;
  for (const row of r.rows) {
    const det = AC.accessDetail(AC.decodeRow(row), r.ways);
    if (det.walk != null) { walks++; assert.ok(det.walk >= 0); assert.match(det.trailheadNote, /road|trailhead/); }
  }
  assert.ok(walks > 0, 'some cells should have a walk figure');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('walk: without a trailhead the answer is a straight line, and says so', () => {
  const d = { trail: 300, trailWay: 0, trailWalk: -1, road: -1, roadWay: -1, roadWalk: -1,
              rough: -1, roughWay: -1, roughWalk: -1 };
  const ways = [[null, null, 'path', 1, AC.TRAILHEAD_NONE]];
  const geoms = [AC.encodeGeom([[47.5, -121.5], [47.51, -121.5]])];
  const det = AC.accessDetail(d, ways, geoms);
  assert.equal(det.walk, null, 'no walk figure without a trailhead');
  assert.equal(det.straight, 300, 'the straight-line distance is still reported');
  assert.equal(det.trailheadNote, null);
});

test('walk: a mapped trailhead is distinguished from an inferred one', () => {
  assert.match(AC.TRAILHEAD_NOTE[AC.TRAILHEAD_MAPPED], /mapped trailhead/);
  assert.match(AC.TRAILHEAD_NOTE[AC.TRAILHEAD_INFERRED], /meets a drivable road/);
  assert.notEqual(AC.TRAILHEAD_NOTE[AC.TRAILHEAD_MAPPED], AC.TRAILHEAD_NOTE[AC.TRAILHEAD_INFERRED],
    'an inference must not be presented as a surveyed point');
});

/* ===================== naming does not weaken the framing ===================== */

test('honesty: naming a way does not turn "mapped" into "passable"', () => {
  const d = { trail: 200, trailWay: 0, trailWalk: 500, road: -1, roadWay: -1, roadWalk: -1,
              rough: -1, roughWay: -1, roughWalk: -1 };
  const ways = [['Bear Creek Trail', null, 'path', 1, AC.TRAILHEAD_INFERRED]];
  const det = AC.accessDetail(d, ways, [AC.encodeGeom([[47.5, -121.5], [47.51, -121.5]])]);
  assert.equal(det.wayName, 'Bear Creek Trail');
  assert.match(det.blurb, /mapped/i, 'the blurb must still say "mapped" even when the way has a name');
  assert.ok(!/passable|open|maintained|confirmed/i.test(det.blurb),
    'and must not imply the way is passable');
});

test('honesty: primaryCat picks the category the class was decided on', () => {
  // So the line drawn on the map is the way the label is talking about, not a different one.
  assert.equal(AC.primaryCat({ trail: 100, road: 50, rough: -1 }), 'trail',
    'trail outranks road even when the road is closer, matching the class precedence');
  assert.equal(AC.primaryCat({ trail: -1, road: 50, rough: 10 }), 'road');
  assert.equal(AC.primaryCat({ trail: 1900, road: -1, rough: -1 }), 'trail', 'the nearby case still names a way');
  assert.equal(AC.primaryCat({ trail: -1, road: -1, rough: -1 }), null);
});

/* ===================== the two files ===================== */

test('split: geometry is written separately and stays index-aligned', async () => {
  /* The whole point of the split is that the up-front download drops from 9.5 MB to 4.1 MB. It only
     works if the two files agree about indices, so a drift here draws the wrong line for a cell. */
  const dir = tmpdir();
  cellsFixture(dir);
  const out = path.join(dir, 'access.json');
  const opts = A.parseArgs([`--cells=${path.join(dir, 'cells.json')}`, `--out=${out}`,
    '--bbox=47,-123,49,-121', '--skip-usfs']);
  const r = await A.build(opts, fakeDeps());
  const geomPath = path.join(dir, 'access-geom.json');
  assert.ok(fs.existsSync(geomPath), 'a geometry file must be written alongside');
  const g = JSON.parse(fs.readFileSync(geomPath, 'utf8'));
  assert.equal(g.geom.length, r.ways.length, 'one geometry per way, same order');
  assert.equal(g.generated, r.generated, 'the two files must be stamped from the same run');
  for (let i = 0; i < r.ways.length; i++) {
    const w = AC.decodeWay(r.ways[i], g.geom[i]);
    assert.ok(w.geom && w.geom.length >= 1, 'way ' + i + ' has no geometry');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('split: a way can be named without its geometry being loaded', () => {
  // This is what the tap sheet does before anyone asks to see a line.
  const w = AC.decodeWay(['Bear Creek Trail', null, 'path', 1, AC.TRAILHEAD_INFERRED]);
  assert.equal(AC.wayLabel(w), 'Bear Creek Trail');
  assert.equal(w.geom, null, 'geometry stays null until the second file arrives');
  const det = AC.accessDetail({ trail: 200, trailWay: 0, trailWalk: 100,
    road: -1, roadWay: -1, roadWalk: -1, rough: -1, roughWay: -1, roughWalk: -1 },
    [['Bear Creek Trail', null, 'path', 1, AC.TRAILHEAD_INFERRED]]);
  assert.equal(det.wayName, 'Bear Creek Trail', 'the name is available with no geometry at all');
  assert.equal(det.wayIndex, 0, 'and the index, so the line can be fetched on demand');
  assert.equal(det.way.geom, null);
});

/* ===================== joining fragmented routes =====================

   OSM splits a named way at every tag change and junction, so 14% of named routes in Washington
   arrive as several separate ways — the PCT as 68 of them, US 101 as 71. Drawing only the segment
   nearest a cell looks like a fragment of a trail because it is one, which is what "trails draw
   truncated" actually was for long routes. */

const seg = (id, name, geom, th = 0) => ({ wid: 'o' + id, name, ref: null, type: 'path',
  cat: 'trail', th, osmId: id, segments: 1, geom });

test('join: segments of one named route are chained into a single way', () => {
  const j = A.joinRoutes([
    seg(1, 'Bear Creek Trail', [[47.50, -121.5], [47.51, -121.5]], AC.TRAILHEAD_INFERRED),
    seg(2, 'Bear Creek Trail', [[47.51, -121.5], [47.52, -121.5]]),
    seg(3, 'Bear Creek Trail', [[47.52, -121.5], [47.53, -121.5]]),
  ]);
  assert.equal(j.length, 1, 'three chained segments are one route');
  assert.equal(j[0].geom.length, 4, 'and one polyline with no doubled points at the joins');
  assert.equal(j[0].segments, 3, 'the count is kept so the sheet can disclose the join');
  assert.equal(j[0].th, AC.TRAILHEAD_INFERRED, 'a trailhead on any member belongs to the whole route');
});

test('join: the order and direction of the source segments do not matter', () => {
  /* OSM hands them over in whatever order the query returns and in either direction. A join that
     only works for pre-sorted, consistently-wound segments would fix almost nothing. */
  const j = A.joinRoutes([
    seg(21, 'Long Trail', [[47.52, -121.5], [47.53, -121.5]]),
    seg(22, 'Long Trail', [[47.51, -121.5], [47.50, -121.5]]),      // wound the other way
    seg(23, 'Long Trail', [[47.51, -121.5], [47.52, -121.5]]),
  ]);
  assert.equal(j.length, 1);
  assert.equal(j[0].geom.length, 4, 'a doubled or dropped point means the reversal is inverted, got '
    + j[0].geom.length);
  const lats = j[0].geom.map(p => +p[0].toFixed(3));
  const up = lats.every((v, i) => i === 0 || v > lats[i - 1]);
  const down = lats.every((v, i) => i === 0 || v < lats[i - 1]);
  assert.ok(up || down, 'the joined line must run in one direction: ' + lats.join(','));
});

test('join: a junction is not chained through', () => {
  /* Guessing a path through a fork would invent a route nobody can walk. This is why the decision is
     endpoint DEGREE over the whole group: asking "is exactly one candidate left?" as segments are
     consumed gets the first seed right and then joins the fork anyway on the second. */
  const j = A.joinRoutes([
    seg(11, 'Fork Rd', [[47.50, -121.50], [47.51, -121.50]]),
    seg(12, 'Fork Rd', [[47.51, -121.50], [47.52, -121.49]]),
    seg(13, 'Fork Rd', [[47.51, -121.50], [47.52, -121.51]]),
  ]);
  assert.equal(j.length, 3, 'a three-way junction must leave all three pieces separate');
});

test('join: unnamed ways are never merged with each other', () => {
  // There is nothing to group them by, so merging two adjacent tracks would fabricate a route.
  const j = A.joinRoutes([
    seg(31, null, [[47.50, -121.5], [47.51, -121.5]]),
    seg(32, null, [[47.51, -121.5], [47.52, -121.5]]),
  ]);
  assert.equal(j.length, 2);
  for (const e of j) assert.equal(e.segments, 1);
});

test('join: the same name in two different places stays two routes', () => {
  const j = A.joinRoutes([
    seg(41, 'Forest Road 23', [[47.50, -121.5], [47.51, -121.5]]),
    seg(42, 'Forest Road 23', [[48.50, -119.0], [48.51, -119.0]]),
  ]);
  assert.equal(j.length, 2, 'a name shared across the state is not one route');
});

/* ===================== distance and climb to the spot ===================== */

test('elevation: gain is cumulative climb, not the difference between endpoints', () => {
  /* A rolling approach that climbs 300 m in four rises and gives most of it back is still a 300 m
     climb to walk. Endpoint subtraction would call it nearly flat, which is the whole reason the
     profile is sampled along the geometry rather than read at the two ends. */
  const geom = [[47.500, -121.5], [47.501, -121.5], [47.502, -121.5], [47.503, -121.5], [47.504, -121.5]];
  const elev = [100, 150, 120, 200, 180];
  assert.equal(A.gainBetween(geom, elev, 0, 1e6), 130, 'the two rises are 50 and 80');
  assert.notEqual(A.gainBetween(geom, elev, 0, 1e6), 80, 'endpoint difference would say 80');
});

test('elevation: a missing profile reports unavailable, not zero', () => {
  const geom = [[47.5, -121.5], [47.51, -121.5]];
  assert.equal(A.gainBetween(geom, null, 0, 1e6), -1);
  assert.equal(A.gainBetween(geom, [100], 0, 1e6), -1, 'a profile of the wrong length is unusable');
  assert.equal(AC.gainLabel(-1), null, 'and -1 must render as nothing rather than as "0 ft"');
  assert.equal(AC.gainLabel(null), null);
});

test('elevation: only the stretch between the trailhead and the cell counts', () => {
  const geom = [];
  for (let i = 0; i < 11; i++) geom.push([47.5 + i * 0.001, -121.5]);
  const elev = geom.map((_, i) => 100 + i * 10);            // a steady 10 m per vertex
  const whole = A.gainBetween(geom, elev, 0, 1e6);
  const part = A.gainBetween(geom, elev, 0, 300);
  assert.ok(part > 0 && part < whole, 'a shorter stretch must climb less: ' + part + ' vs ' + whole);
});

test('elevation: the profile is sampled from the terrain tiles, at every vertex', async () => {
  /* Same Terrarium tiles and same zoom the cell bake reads, so the climb figure and the elevation in
     the sheet come from one source. The fake tile rises eastward, so an eastward route must gain. */
  const deps = fakeDeps();
  const geom = [];
  for (let i = 0; i < 8; i++) geom.push([47.5, -121.5 + i * 0.002]);
  const prof = await A.elevationProfile(geom, deps.tileFetch);
  assert.equal(prof.length, geom.length, 'one elevation per vertex');
  for (const v of prof) assert.ok(Number.isFinite(v), 'every sample must decode to a real height');
  assert.ok(A.gainBetween(geom, prof, 0, 1e6) > 0, 'an eastward route on a rising tile must gain');
});

test('elevation: the label is rounded to the precision the data supports', () => {
  /* The tiles are ~76 m per pixel at z10 and the geometry is simplified to 25 m, so a figure to the
     nearest foot would be false precision. */
  assert.equal(AC.gainLabel(0), 'negligible climb');
  assert.equal(AC.gainLabel(10), 'negligible climb', '33 ft is not worth reporting as a climb');
  assert.match(AC.gainLabel(300), /1,?000 ft of climb|950 ft of climb/);
  assert.match(AC.gainLabel(300), /ft of climb$/);
});

/* ===================== the external link ===================== */

test('links: AllTrails is deliberately absent, and the file says why', () => {
  /* Checked, not assumed: a trail page, the explore map with bounds, the explore map with a centre
     and their search all answer HTTP 403 to a programmatic request. None of it can be verified to
     work, and their per-trail URLs need a slug this data does not contain — so linking their search
     with a trail name would be exactly the "may land on the wrong trail" case to avoid. */
  const src = fs.readFileSync(fileURLToPath(new URL('../src/access.mjs', import.meta.url)), 'utf8');
  for (const w of [{ osmId: 123 }, { osmId: null }]) {
    for (const l of AC.externalLinks(w, 47.5, -121.5)) {
      assert.ok(!/alltrails/i.test(l.url), 'no AllTrails link may be emitted: ' + l.url);
    }
  }
  assert.match(src, /AllTrails/, 'and the reason must be written down where the links are built');
  assert.match(src, /403/, 'including the evidence');
});

test('links: an OSM way gets its own page; everything gets a topo map', () => {
  const withOsm = AC.externalLinks({ osmId: 174583494 }, 47.5, -121.5);
  assert.ok(withOsm.some(l => l.url === 'https://www.openstreetmap.org/way/174583494'),
    'the exact way the sheet just named must be the thing linked, not a search for its name');
  assert.ok(withOsm.some(l => /caltopo\.com/.test(l.url)));
  // USFS features carry no OSM id, so they get the coordinate link only
  const usfs = AC.externalLinks({ osmId: null }, 47.5, -121.5);
  assert.equal(usfs.length, 1);
  assert.match(usfs[0].url, /caltopo\.com.*47\.50000,-121\.50000/);
  for (const l of usfs.concat(withOsm)) {
    assert.match(l.url, /^https:\/\//, 'every link must be https');
    assert.ok(l.label && l.note, 'and must say what it is and what it shows');
  }
});

/* ===================== honesty, for the new figures ===================== */

test('honesty: no trailhead means the figures are unavailable, not invented', () => {
  /* Measuring from an arbitrary end of the way would produce a number that looks like an answer. */
  const d = { trail: 400, trailWay: 0, trailWalk: -1, trailGain: -1,
              road: -1, roadWay: -1, roadWalk: -1, roadGain: -1,
              rough: -1, roughWay: -1, roughWalk: -1, roughGain: -1 };
  const det = AC.accessDetail(d, [['Some Trail', null, 'path', 1, AC.TRAILHEAD_NONE, null, 1]]);
  assert.equal(det.walk, null, 'no walk figure');
  assert.equal(det.gain, null, 'and no climb figure');
  assert.equal(det.straight, 400, 'only the straight line, which the sheet labels as such');
  assert.match(AC.NO_TRAILHEAD_NOTE, /nowhere to measure a walk from/);
  assert.match(AC.NO_TRAILHEAD_NOTE, /straight line/);
});

test('honesty: a climb figure never appears without a walk figure', () => {
  // Both are measured from the trailhead, so a climb with no start point would mean nothing.
  const d = { trail: 400, trailWay: 0, trailWalk: -1, trailGain: 250,
              road: -1, roadWay: -1, roadWalk: -1, roadGain: -1,
              rough: -1, roughWay: -1, roughWalk: -1, roughGain: -1 };
  const det = AC.accessDetail(d, [['Some Trail', null, 'path', 1, AC.TRAILHEAD_INFERRED, null, 1]]);
  assert.equal(det.walk, null, 'the walk is unavailable here');
  assert.equal(det.gain, null, 'so a stray gain value must not surface on its own');
});

test('honesty: an inferred trailhead still says it was inferred', () => {
  const d = { trail: 400, trailWay: 0, trailWalk: 1200, trailGain: 180,
              road: -1, roadWay: -1, roadWalk: -1, roadGain: -1,
              rough: -1, roughWay: -1, roughWalk: -1, roughGain: -1 };
  const det = AC.accessDetail(d, [['Some Trail', null, 'path', 1, AC.TRAILHEAD_INFERRED, null, 1]]);
  assert.equal(det.walk, 1200);
  assert.equal(det.gain, 180);
  assert.match(det.trailheadNote, /meets a drivable road/,
    'the walk is only as good as the trailhead it was measured from');
});

test('honesty: a joined route discloses how many mapped segments it came from', () => {
  const w = AC.decodeWay(['Pacific Crest Trail', null, 'path', 1, 1, 12345, 68]);
  assert.equal(w.segments, 68, 'so the sheet can say the line is 68 mapped pieces joined');
  assert.equal(AC.decodeWay(['X', null, 'path', 1, 0, null, undefined]).segments, 1,
    'a way with no count recorded is one segment, not zero');
  assert.equal(AC.decodeWay(['X', null, 'path', 1, 0, 0, 1]).osmId, null,
    'a USFS feature has no OSM id and must not pretend to have way 0');
});

test('format: the bake stamps the version the app reads, from one constant', async () => {
  /* The row stride and the way-entry width have each changed once. A file from the other side of
     that change does not fail to parse — it decodes into confident nonsense, because a v4 reader
     takes a v3 row's trail distance as a road gain and its way index as a distance. So the writer
     and the reader take the version from the same constant, and the app refuses anything else. */
  const dir = tmpdir();
  cellsFixture(dir);
  const opts = A.parseArgs([`--cells=${path.join(dir, 'cells.json')}`,
    `--out=${path.join(dir, 'a.json')}`, '--bbox=47,-123,49,-121', '--skip-usfs', '--skip-elevation']);
  await A.build(opts, fakeDeps());
  const out = JSON.parse(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'));
  const geom = JSON.parse(fs.readFileSync(path.join(dir, 'a-geom.json'), 'utf8'));
  assert.equal(out.version, AC.ACCESS_FORMAT, 'the bake must stamp the shared constant');
  assert.equal(geom.version, AC.ACCESS_FORMAT, 'both files, or the geometry outlives its rows');

  const app = fs.readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  assert.match(app, /j\.version!==ACCESS_FORMAT/,
    'the app must refuse a version it does not know rather than misdecoding it');
  assert.equal((app.match(/j\.version!==ACCESS_FORMAT/g) || []).length, 3,
    'access.json, access-geom.json and access-routes.json all need the check — a stale geometry or routes file draws a wrong line');

  /* And the width really does depend on the stride, so a future change cannot forget to bump it. */
  assert.equal(out.rows[0].length, AC.ROW_WIDTH);
  assert.equal(AC.ROW_WIDTH, 2 + AC.CATS.length * AC.ROW_STRIDE + AC.HIKE_STRIDE + 4 + 4 + AC.DRIVE_STRIDE,
    'the categories, then hike (7), worst case (4), direct (4) and the drive (11)');
  assert.equal(out.ways[0].length, 7);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('honesty: with no access data the sheet says nothing, rather than "nothing is mapped"', () => {
  /* "Nothing is mapped within about a mile" is a claim about a lookup. With no file — or one this
     build cannot read — no lookup happened, so the section is omitted entirely. The unknown CLASS
     is for a cell the bake really did examine and find nothing near. */
  const app = fs.readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  const at = app.indexOf('<div class="sec">Getting there</div>');
  assert.ok(at > 0, 'the Getting there section must still exist');
  const before = app.slice(0, at);
  const guard = before.lastIndexOf('if(STATIC.access){');
  assert.ok(guard > 0, 'no if(STATIC.access) guard precedes the section at all');
  const between = before.slice(guard);
  /* Does the guard still ENCLOSE the section? This used to be a byte budget, which was a proxy for
     the same question and broke the first time a comment was added inside the guard while the
     invariant held perfectly. So: strip comments and template literals — `${t}` braces live in
     those — and assert the block has not closed before the section is emitted. */
  const code = between
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  assert.ok(!code.includes('}'),
    'the if(STATIC.access) block closes before the section — it renders a claim with no data behind it');
  assert.ok(!between.includes('<div class="sec">'),
    'and no other section may be emitted between the guard and this one');
  assert.match(AC.CLASSES.unknown.blurb, /may mean no way exists, or simply that nobody has mapped one/,
    'and the unknown class keeps saying which of the two it cannot distinguish');
});

/* ===================== mirrors ===================== */

test('mirrors: a saturated mirror is dropped, even though it answers /status', async () => {
  /* This is what stalled a statewide run. /status is a static string a queue-saturated server still
     serves: one mirror answered it in 16 s and then timed out at 90 s on a query returning six ways.
     A /status probe kept it as "up", so every tile paid two long timeouts before rotating off it, and
     tiny sub-areas were abandoned. The probe is a real query for that reason. */
  const seen = [];
  const fake = async (url, opts) => {
    seen.push({url, method: opts && opts.method});
    if (url.includes('saturated')) throw new Error('The operation was aborted due to timeout');
    if (url.includes('dead')) { const e = new Error('connect'); e.cause = {code: 'UND_ERR_CONNECT_TIMEOUT'}; throw e; }
    if (url.includes('proxy')) return { ok: true, text: async () => '<html>not overpass</html>' };
    return { ok: true, text: async () => JSON.stringify({elements: []}) };
  };
  const alive = await A.pickMirrors([
    'https://dead.example/api/interpreter',
    'https://saturated.example/api/interpreter',
    'https://proxy.example/api/interpreter',
    'https://good.example/api/interpreter',
  ], fake);
  assert.deepEqual(alive, ['https://good.example/api/interpreter'],
    'only a mirror that actually answered a query may survive the probe');
  for (const c of seen) {
    assert.equal(c.method, 'POST', 'the probe must be a real query, not a GET of /status');
    assert.ok(!c.url.includes('/status'), 'probing /status is what let a saturated mirror through');
  }
});

test('mirrors: the survivors keep their declared order, and there are four of them', () => {
  /* Ranking by how fast a mirror answered put the flaky one first and produced tile times between
     8 s and 179 s unrelated to how much data the tile held. The probe is a gate, not a ranking. */
  const order = ['https://a/api/interpreter', 'https://b/api/interpreter', 'https://c/api/interpreter'];
  const slowThenFast = async (url) => {
    await new Promise(r => setTimeout(r, url.includes('//a/') ? 30 : 1));
    return { ok: true, text: async () => JSON.stringify({elements: []}) };
  };
  return A.pickMirrors(order, slowThenFast).then(alive => {
    assert.deepEqual(alive, order, 'the slowest responder must still come first if it was declared first');
  });
});

test('mirrors: three was not enough redundancy', () => {
  /* All three original mirrors were unusable simultaneously during one run. That is the reason for
     the fourth, and dropping back to three would reintroduce a stall with no fallback. */
  assert.ok(A.OVERPASS_MIRRORS.length >= 4,
    'at least four mirrors: the first three have all been down at the same time');
  assert.equal(new Set(A.OVERPASS_MIRRORS).size, A.OVERPASS_MIRRORS.length, 'no duplicates');
  for (const m of A.OVERPASS_MIRRORS) assert.match(m, /^https:\/\/.*\/interpreter$/,
    'every mirror must be an https interpreter endpoint: ' + m);
});

/* ===================== the DEM is not clean ===================== */

test('elevation: an isolated garbage pixel does not become thousands of feet of climb', () => {
  /* Real values from Terrarium tile 10/164/363, Mount St Helens blast zone, where the terrain is
     around 900 m. The browser's own PNG decoder returns the identical bytes, so this is what the
     source data says rather than a decoding fault. Cumulative gain adds every spurious rise and
     subtracts none, so this one pixel pair contributed 2,719 m of a 4,608 m total on USFS trail 211
     -- 59% of the figure, shown as "15,100 ft of climb" on a 12 mi trail. */
  const geom = [];
  for (let i = 0; i < 8; i++) geom.push([46.305 + i * 0.0015, -122.24]);   // ~165 m apart
  const dirty = [920, 953, 1143, 618, 101, 2820, 770, 822];
  // what a plain cumulative sum would have produced, which is the figure that shipped nowhere
  let raw = 0;
  for (let i = 1; i < dirty.length; i++) if (dirty[i] > dirty[i - 1]) raw += dirty[i] - dirty[i - 1];
  const clean = A.gainBetween(geom, A.despike(dirty), 0, 1e6);
  assert.ok(raw > 2500, 'the unfiltered total should be dominated by the spike, got ' + raw);
  assert.ok(A.gainBetween(geom, dirty, 0, 1e6) < 400,
    'the gradient gate alone should already reject the impossible steps');
  assert.ok(clean < 400, 'after filtering the climb must be plausible for 1 km of trail, got ' + clean);
});

test('elevation: a spike too small for the gradient gate is still removed', () => {
  /* The two filters cover different failures and neither is redundant. A garbage pixel does not have
     to be absurd to matter: 400 m over a 165 m step is a 242% gradient, under MAX_GRADE, so the gate
     passes it and a plain cumulative sum adds 400 m of climb that is not there. Only the median
     removes it. Without this case, disabling the median entirely leaves every test still passing. */
  const geom = [];
  for (let i = 0; i < 6; i++) geom.push([46.305 + i * 0.0015, -122.24]);      // ~165 m apart
  const dirty = [900, 910, 1310, 915, 925, 935];                              // one pixel 400 m high
  const gated = A.gainBetween(geom, dirty, 0, 1e6);
  const clean = A.gainBetween(geom, A.despike(dirty), 0, 1e6);
  assert.ok(gated > 380, 'the gate should NOT catch this one -- that is the point, got ' + gated);
  assert.ok(clean < 60, 'the median must remove it, got ' + clean);
});

test('elevation: the median leaves a genuine slope alone', () => {
  /* The filter must not flatten real climbing -- that would trade one wrong number for another.
     The median of three monotone samples is the middle one, so a steady ascent is untouched. */
  const geom = [];
  for (let i = 0; i < 10; i++) geom.push([47.5 + i * 0.002, -121.5]);
  const climb = [100, 140, 180, 220, 260, 300, 340, 380, 420, 460];
  assert.deepEqual(A.despike(climb), climb, 'a monotone profile must pass through unchanged');
  assert.equal(A.gainBetween(geom, A.despike(climb), 0, 1e6), 360);
  // and a real dip is a real dip, not a spike: a broad feature survives
  const rolling = [100, 200, 300, 300, 200, 100, 100, 200, 300, 400];
  assert.deepEqual(A.despike(rolling), rolling, 'a dip two samples wide is terrain, not noise');
});

test('elevation: a physically impossible step is skipped, not clamped', () => {
  /* The backstop for two bad pixels in a row, which a three-point median cannot fix. The threshold
     is physical, not tuned: over 4,159 steps sampled from 333 real routes the steepest implied
     gradient was 141%, and MAX_GRADE is 300% -- 72 degrees, which is neither walkable ground nor a
     real DEM slope. Skipping rather than clamping means a spike adds nothing on the way up and no
     spurious rise on the way back down. */
  assert.ok(A.MAX_GRADE >= 1.5, 'the gate must sit well above real terrain (141% was measured)');
  const geom = [[47.500, -121.5], [47.5009, -121.5], [47.5018, -121.5]];   // ~100 m steps
  // 100 m horizontal, 900 m up: 900% grade, impossible
  assert.equal(A.gainBetween(geom, [500, 1400, 520], 0, 1e6), 0,
    'neither the impossible rise nor the impossible fall may contribute');
  // a steep but real step must still count: 100 m horizontal, 60 m up is a 60% grade
  assert.equal(A.gainBetween(geom, [500, 560, 620], 0, 1e6), 120,
    'steep real terrain must not be filtered out with the garbage');
});

test('elevation: the filtering is recorded in provenance, not applied invisibly', () => {
  const dir = tmpdir();
  cellsFixture(dir);
  const opts = A.parseArgs([`--cells=${path.join(dir, 'cells.json')}`,
    `--out=${path.join(dir, 'a.json')}`, '--bbox=47,-123,49,-121', '--skip-usfs']);
  return A.build(opts, fakeDeps()).then(r => {
    assert.equal(r.provenance.elevation.despike, '3-point median',
      'a reader has to be able to tell the profile was filtered');
    assert.equal(r.provenance.elevation.max_grade, A.MAX_GRADE);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test('cache: the geometry URL is stamped, or a re-bake never reaches a returning viewer', () => {
  /* force-cache means "use the cached copy whatever its age". That is right for a 5.5 MB file that
     never changes at a given URL and wrong for one that is re-baked: on the first v4 deploy the
     server served access.json v4 while access-geom.json came back v3 from the disk cache -- 53,200
     entries against 50,614 -- and it would have stayed that way indefinitely. The format check
     turned that into "Could not load the line" rather than wrong lines drawn silently, but the
     feature was still broken. The fix is to key the URL on the bake stamp. */
  const app = fs.readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  const at = app.indexOf("'data/access-geom.json");
  assert.ok(at > 0, 'the geometry fetch must still exist');
  const line = app.slice(at, at + 160);
  if (/force-cache/.test(line)) {
    assert.match(line, /access-geom\.json\?g='\+encodeURIComponent\(accessAsOf/,
      'force-cache is only safe on a URL that changes with the bake: ' + line.split('\n')[0]);
  }
  // and the stamp has to come from the file that is always revalidated
  const acc = app.indexOf("fetch('data/access.json'");
  assert.match(app.slice(acc, acc + 80), /cache:'no-cache'/,
    'access.json must be fetched no-cache, or the stamp keying the geometry URL is itself stale');
});

/* ===================== an implausibly long walk =====================
   The walk figure is unbounded by design: it says what is mapped. Past a point that stops being a
   useful reading of the ground and becomes a statement about the data, and the sheet has to say so
   without capping the number or hiding it. */

const longWalkRow = (walkM, others) => ({
  // trail: 400 is the OFF-TRAIL leg since v5 — the straight line from the route to the cell centre
  trail: 400, trailWay: 0, trailWalk: walkM, trailGain: 900, trailOffGain: 40,
  road: others ? 1200 : -1, roadWay: others ? 1 : -1, roadWalk: -1, roadGain: -1, roadOffGain: -1,
  rough: -1, roughWay: -1, roughWalk: -1, roughGain: -1, roughOffGain: -1,
});
const longWalkWays = [['Pacific Crest Trail', null, 'path', 1, AC.TRAILHEAD_MAPPED, 12345, 4],
                      ['Forest Road 24', null, 'track', 2, AC.TRAILHEAD_NONE, null, 1]];

test('walk: an implausibly long walk keeps its number and gets labelled', () => {
  const det = AC.accessDetail(longWalkRow(110000, true), longWalkWays);
  assert.equal(det.walk, 110000, 'the measured number survives intact — no cap, no rounding away');
  assert.equal(det.gain, 900, 'and the climb with it');
  assert.ok(det.walkDoubt, 'a 68 mi walk must carry a caveat');
  assert.match(det.walkDoubt, /not the real approach/i, 'say plainly what it probably is not');
  assert.match(det.walkDoubt, /unmapped|without a trailhead/i, 'and why the data looks like this');
  assert.match(det.walkDoubt, /Also nearby/, 'point at the alternative, since there is one here');
});

test('walk: a normal walk gets no caveat, and the threshold is on the TOTAL', () => {
  /* The median shown walk is 1.3 mi. If the caveat appeared on those it would be noise, and the
     honest notes on this sheet only work while every one of them means something.

     Since v5 the caveat is judged on the total approach, not on the on-trail leg alone. That is the
     point of the split: 3 mi of trail plus a mile of bushwhacking is the same problem as a 4 mi
     trail walk, and flagging only the trail part would let the worst cases through — a cell with a
     0 m on-trail leg and 1.9 km off-trail used to be flagged by nothing at all. longWalkRow puts
     400 m in the off-trail column, so the totals below are the on-trail value plus 400. */
  for (const m of [0, 500, 3000, 12000, AC.WALK_DOUBT - 401]) {
    const det = AC.accessDetail(longWalkRow(m, true), longWalkWays);
    assert.equal(det.parts.total, m + 400, 'the total is the two legs added');
    assert.equal(det.walkDoubt, null, 'a total of ' + (m + 400) + ' m must not be flagged');
  }
  const det = AC.accessDetail(longWalkRow(AC.WALK_DOUBT - 400, true), longWalkWays);
  assert.equal(det.parts.total, AC.WALK_DOUBT);
  assert.ok(det.walkDoubt, 'the threshold itself is flagged');
  /* The off-trail leg cannot trip the threshold by itself: a way is only recorded within CAP
     (2 km) of the cell centre, so the off-trail leg is at most 2 km and the 10 mi threshold is out
     of its reach. What it CAN do is carry a total over the line that the on-trail leg alone would
     not, which is the whole reason the threshold moved to the total. */
  const justUnder = AC.WALK_DOUBT - 200;                       // on-trail alone: not flagged
  assert.equal(AC.accessDetail({ ...longWalkRow(justUnder, true), trail: 100 }, longWalkWays).walkDoubt,
    null, 'a 100 m off-trail leg leaves the total under the threshold');
  const over = AC.accessDetail({ ...longWalkRow(justUnder, true), trail: 900 }, longWalkWays);
  assert.equal(over.parts.total, justUnder + 900);
  assert.ok(over.walkDoubt, 'a 900 m off-trail leg carries the same trail walk over it');
  /* and a zero on-trail leg keeps its off-trail number, which is the case v4 reported as 0 */
  const zero = AC.accessDetail(longWalkRow(0, true), longWalkWays);
  assert.equal(zero.parts.onTrail, 0, 'nothing to walk on the trail');
  assert.equal(zero.parts.offTrail, 400, 'but 400 m to get to the cell from it');
  assert.equal(zero.parts.total, 400, 'and the total says so rather than reading as no walk at all');
});

test('walk: the caveat does not point at "Also nearby" when nothing is nearby', () => {
  /* A third of the flagged cells have no other category within reach. Telling those readers to
     check a list that is not on the page would be a small lie in a note whose whole job is to be
     straight with them. */
  const det = AC.accessDetail(longWalkRow(110000, false), longWalkWays);
  assert.ok(det.walkDoubt, 'still flagged');
  assert.equal(det.others.length, 0, 'nothing else is mapped in reach');
  assert.ok(!/Also nearby/.test(det.walkDoubt), 'so do not send them to a section that is empty');
});

test('walk: the caveat is a label, never a filter', () => {
  /* Guards the decision, not the wording: suppressing or capping the figure would both be easier to
     write than this and both would be less honest. */
  const long = AC.accessDetail(longWalkRow(110000, true), longWalkWays);
  const short = AC.accessDetail(longWalkRow(2000, true), longWalkWays);
  assert.equal(long.walk, 110000);
  assert.equal(long.wayName, short.wayName, 'the way is still named');
  assert.equal(long.wayIndex, short.wayIndex, 'the line can still be drawn');
  assert.equal(long.trailheadNote, short.trailheadNote, 'and it still says where it measured from');
  assert.ok(AC.accessDistance(long.walk).length > 0, 'and the distance still formats');
  assert.ok(AC.WALK_DOUBT > 0 && Number.isFinite(AC.WALK_DOUBT), 'the threshold is a real distance');
});

test('walk: the sheet renders the caveat where the figure is', () => {
  const app = fs.readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  /* Renamed in v5: the block is the approach in two legs, not a single walk. */
  const at = app.indexOf('<dt>Getting in</dt>');
  assert.ok(at > 0, 'the approach block must still exist');
  const block = app.slice(at, at + 1400);
  assert.match(block, /ac\.walkDoubt/, 'the caveat has to be rendered, not just computed');
  assert.match(block, /P\.total|P\.offTrail/, 'and the figures stay on the lines above it');
  assert.match(app, /\.caveat\{/, 'with a style of its own, so it reads as a caveat');
});

/* ===================== a tap and Top spots are the same cell =====================
   The invariant that was missing. Access is per lattice cell, so the two paths into the sheet have
   to produce the same answer for the same cell -- and for a long time they did not: the lookup lived
   inline in the baked-cell loader, so an exact point (any tap that cannot resolve to a scored baked
   cell, which is 32% of in-state taps) got no access at all and read as "No mapped access, nothing
   is mapped within about a mile". The row was in the index the whole time. A false negative wearing
   the honest answer's clothes is worse than a blank. */

const parityIndex = () => {
  const [i, j] = cellIndex(47.5, -121.5);
  /* one real row: a trail 200 m out, way 0, a 3 km walk with 400 m of climb */
  const row = [i, j, 200, 0, 3000, 400, -1, -1, -1, -1, -1, -1, -1, -1];
  const byCell = new Map([[i + ':' + j, AC.decodeRow(row)]]);
  const ways = [['Cold Creek Trail', null, 'path', 1, AC.TRAILHEAD_MAPPED, 987, 2]];
  return { i, j, byCell, ways };
};

test('parity: a tap anywhere in a cell and that cell from Top spots give identical access', () => {
  const { i, j, byCell, ways } = parityIndex();
  const [clat, clon] = cellCenter(i, j);

  // Top spots hands showPoint the baked cell itself, so its access is the cell-centre lookup.
  const fromTop = AC.accessAt(byCell, clat, clon);
  assert.ok(fromTop, 'the fixture cell must resolve, or this test proves nothing');
  const expected = AC.accessDetail(fromTop, ways);
  assert.equal(expected.wayName, 'Cold Creek Trail');

  /* A tap lands wherever the finger lands. Every one of these is inside the same cell -- the cell
     is 0.0145 x 0.0214 degrees, so half-widths are 0.00725 and 0.0107 -- and they run close to each
     edge without touching it. Close matters: exactPoint rounds the tap to 4 dp before building the
     entry, which can shift it by up to 0.00005 degrees, about 5 m. A tap within 5 m of a cell edge
     can therefore be attributed to the neighbour, and the containment assertion below is what caught
     that while I was writing the fixture. On a 1.6 km cell it is the right trade: the sheet then
     describes the cell it actually resolved, and says that it is describing a cell. */
  const offsets = [[0, 0], [0.004, 0.006], [-0.004, -0.006], [0.0070, 0.0104], [-0.0070, -0.0104],
                   [0.0001, -0.0103], [-0.0069, 0.0002]];
  for (const [dla, dlo] of offsets) {
    const tapLat = +(clat + dla).toFixed(4), tapLon = +(clon + dlo).toFixed(4);
    assert.deepEqual(cellIndex(tapLat, tapLon), [i, j], `${tapLat},${tapLon} left the cell — bad fixture`);
    const tapped = AC.accessAt(byCell, tapLat, tapLon);
    assert.deepEqual(AC.accessDetail(tapped, ways), expected,
      `a tap at ${tapLat},${tapLon} must show the same access as the cell from Top spots`);
  }
});

test('parity: the next cell over is genuinely different, so the test above is not vacuous', () => {
  const { i, j, byCell, ways } = parityIndex();
  const [nlat, nlon] = cellCenter(i, j + 1);
  const neighbour = AC.accessAt(byCell, nlat, nlon);
  assert.equal(neighbour, undefined, 'the fixture only holds one cell');
  assert.notDeepEqual(AC.accessDetail(neighbour, ways),
    AC.accessDetail(AC.accessAt(byCell, ...cellCenter(i, j)), ways),
    'if every point resolved the same way the parity test would pass on a broken lookup');
});

test('parity: a missing row is unknown, but a missing lookup must not be', () => {
  /* Both read as the unknown class, which is exactly why the bug was invisible. The distinction the
     app has to preserve: undefined because the bake found nothing near this cell (honest), never
     undefined because nobody asked (a false negative). */
  const { byCell, ways } = parityIndex();
  assert.equal(AC.accessAt(null, 47.5, -121.5), undefined, 'no index at all is unknown');
  assert.equal(AC.accessAt(byCell, 46.0, -120.0), undefined, 'a cell with no row is unknown');
  assert.equal(AC.classifyAccess(AC.accessAt(byCell, 46.0, -120.0)), 'unknown');
  // and the guard against a NaN coordinate silently keying "NaN:NaN"
  assert.equal(AC.accessAt(byCell, NaN, -121.5), undefined);
  assert.equal(AC.accessAt(byCell, 47.5, undefined), undefined);
});

test('parity: every path that builds an entry attaches access', () => {
  /* The structural half of the invariant, and the one that would have caught the original bug.
     There are four makeEntry call sites in the app -- baked cells, the sub-mile refine, a live block
     score, and an exact point -- and only the first attached access. makeEntry itself cannot do it:
     it lives in src/model/, which may not know how reachable a cell is. So the wrapper is the seam,
     and every call site has to go through it. */
  const app = fs.readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  const lines = app.split('\n');
  const sites = lines.filter(l => /makeEntry\(/.test(l) && !/^\s*(\/\/|\*|import )/.test(l));
  assert.ok(sites.length >= 4, `expected at least 4 makeEntry call sites, found ${sites.length}`);
  for (const l of sites) {
    assert.match(l, /withAccess\(makeEntry\(/,
      'a makeEntry call that is not wrapped in withAccess builds an entry whose access reads as '
      + '"nothing is mapped": ' + l.trim().slice(0, 120));
  }
  // and the wrapper must actually do the lookup, keyed on the entry's own coordinates
  assert.match(app, /const withAccess=e=>\{[^\n]*accessAt\(STATIC\.access&&STATIC\.access\.byCell,e\.lat,e\.lon\)/,
    'withAccess must resolve access from the containing cell of the entry it is given');
});

test('parity: an exact point says whose access it is showing', () => {
  /* A point sheet shows distances measured from the cell centre, up to about half a mile from the
     tap. Showing them without saying so would be a different overclaim from the one above. */
  assert.match(AC.CELL_SCOPE_NOTE, /square-mile cell containing this point/);
  assert.match(AC.CELL_SCOPE_NOTE, /not for the exact coordinate/);
  assert.match(AC.CELL_SCOPE_NOTE, /cell centre/);
  const app = fs.readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  const at = app.indexOf('<div class="sec">Getting there</div>');
  const block = app.slice(at - 700, at + 400);
  assert.match(block, /CELL_SCOPE_NOTE/, 'the note has to be rendered on the point sheet');
  assert.match(block, /e\.exact\|\|\(e\.size&&e\.size<DLAT\)/,
    'and on a sub-mile refine cell too, which is smaller than the cell access describes');
});

test('honesty: a cell the bake never examined is not told that nothing is mapped', () => {
  /* The second half of the tap bug, and a distinct overclaim. The bake walks the cells in
     cells.json and writes a row where it found something, so a missing row means either "examined,
     found nothing" (honest unknown, 1,659 cells) or "never examined" — and 31.5% of taps that land
     inside the state land outside the baked set, where roads are everywhere. Saying "nothing is
     mapped within about a mile" there is a claim about a lookup that never happened.

     The distinction is app-side because it is about coverage, not about a row, so this checks the
     vocabulary and that the sheet branches on it. */
  assert.match(AC.NOT_EXAMINED_NOTE, /not the same as nothing being mapped/);
  assert.ok(!/nothing is mapped within/i.test(AC.NOT_EXAMINED_NOTE),
    'the not-examined note must not borrow the unknown class blurb');
  assert.ok(!/trailless|roadless|no way exists/i.test(AC.NOT_EXAMINED_LABEL + AC.NOT_EXAMINED_NOTE),
    'and must not assert tracklessness either');

  const app = fs.readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  assert.match(app, /const accessExamined=\(lat,lon\)=>[^\n]*examined\.has\(cellKey\(lat,lon\)\)/,
    'coverage has to be decided by the containing cell, the same key access itself uses');
  assert.match(app, /STATIC\.access\.examined=new Set\(STATIC\.cells\.rows\.map\(r=>cellKey\(r\[0\],r\[1\]\)\)\)/,
    'the examined set is the cells.json cell set — what the bake actually walked');
  const at = app.indexOf('<div class="sec">Getting there</div>');
  const block = app.slice(at, at + 1400);
  assert.match(block, /if\(!e\.access&&!accessExamined\(e\.lat,e\.lon\)\)/,
    'the sheet must branch on coverage before rendering the unknown class');
  assert.match(block, /NOT_EXAMINED_LABEL/, 'and say so in the Access row');
  /* Fall back to the old behaviour when there is no examined set, rather than telling every cell it
     was not examined — an older access.json or a missing cells.json must not turn the whole map
     into "not checked". */
  assert.match(app, /!STATIC\.access\.examined\|\|STATIC\.access\.examined\.has/,
    'with no examined set, assume examined');
});

/* ===================== the approach has two legs =====================

   The bug this format exists to fix: v4's "walk" was the distance along the way from its trailhead
   to the point on the way NEAREST THE CELL, and it stopped there. 924 cells reported exactly 0 —
   the point nearest the cell was the trailhead itself, on a route that runs away from the cell — and
   for 2,460 of 10,604 displayed walks the omitted leg was longer than the reported one. */

const partsRow = (over) => ({
  road: -1, roadWay: -1, roadWalk: -1, roadGain: -1, roadOffGain: -1,
  trail: 1900, trailWay: 0, trailWalk: 0, trailGain: 0, trailOffGain: 470,
  rough: -1, roughWay: -1, roughWalk: -1, roughGain: -1, roughOffGain: -1,
  ...over,
});
const partsWays = [['Cold Creek Trail', null, 'path', 1, AC.TRAILHEAD_INFERRED, 987, 1],
                   ['Forest Road 24', null, 'track', 2, AC.TRAILHEAD_MAPPED, 654, 1]];

test('parts: a zero on-trail leg still reports the distance that is actually left', () => {
  /* This is the reported symptom, as data: 0 m along the trail, 1,900 m from the trail to the cell.
     v4 showed "0 ft". The number was true and it read as "no walk at all". */
  const det = AC.accessDetail(partsRow(), partsWays);
  assert.equal(det.parts.onTrail, 0, 'nothing to walk along the trail');
  assert.equal(det.parts.offTrail, 1900, 'but 1.9 km to get from the trail to the cell');
  assert.equal(det.parts.total, 1900, 'and the total says so');
  assert.equal(det.parts.offGain, 470, 'with its own climb');
  assert.equal(det.parts.totalGain, 470);
  assert.ok(accessDistanceIsNonZero(det.parts.total), 'the headline figure must not read as zero');
});
const accessDistanceIsNonZero = m => !/^0\b/.test(AC.accessDistance(m));

test('parts: the two legs add up, and the climbs add up with them', () => {
  const det = AC.accessDetail(partsRow({ trailWalk: 3200, trailGain: 250, trail: 600, trailOffGain: 120 }), partsWays);
  assert.equal(det.parts.onTrail, 3200);
  assert.equal(det.parts.offTrail, 600);
  assert.equal(det.parts.total, 3800, 'the total is the sum, not the larger, not the on-trail leg');
  assert.equal(det.parts.onGain, 250);
  assert.equal(det.parts.offGain, 120);
  assert.equal(det.parts.totalGain, 370);
});

test('parts: a total climb needs both halves, or it is not reported', () => {
  /* Adding a known leg to an unknown one and calling the sum "the climb" is the same overclaim as
     measuring a walk from a trailhead that does not exist. */
  const noOff = AC.accessDetail(partsRow({ trailWalk: 3200, trailGain: 250, trailOffGain: -1 }), partsWays);
  assert.equal(noOff.parts.onGain, 250);
  assert.equal(noOff.parts.offGain, null);
  assert.equal(noOff.parts.totalGain, null, 'no total climb when the off-trail half is unmeasured');
  assert.equal(noOff.parts.total, 3200 + 1900, 'but the distances still add up');

  const noOn = AC.accessDetail(partsRow({ trailWalk: 3200, trailGain: -1, trailOffGain: 120 }), partsWays);
  assert.equal(noOn.parts.onGain, null);
  assert.equal(noOn.parts.totalGain, null, 'nor when the on-trail half is');
});

test('parts: with no trailhead there is no on-trail leg, but the off-trail leg is real', () => {
  /* The honesty invariant, refined. There is still nowhere to measure a walk FROM, so the on-trail
     leg is unavailable — but the distance from the route to the cell does not depend on a trailhead,
     and reporting it is strictly more than the straight-line-only answer v4 gave. */
  const det = AC.accessDetail(partsRow({ trailWalk: -1, trailGain: -1 }),
    [['Cold Creek Trail', null, 'path', 1, AC.TRAILHEAD_NONE, 987, 1], partsWays[1]]);
  assert.equal(det.parts.onTrail, null, 'no trailhead, no on-trail figure');
  assert.equal(det.parts.onGain, null);
  assert.equal(det.parts.offTrail, 1900, 'the off-trail leg stands on its own');
  assert.equal(det.parts.total, null, 'and there is no total to state');
  assert.equal(det.walk, null, 'the old single figure stays unavailable too');
});

test('parts: the off-trail leg is labelled as a straight line over unknown ground', () => {
  assert.match(AC.OFF_TRAIL_NOTE, /straight line/i);
  assert.match(AC.OFF_TRAIL_NOTE, /cell centre/i);
  assert.match(AC.OFF_TRAIL_NOTE, /terrain|brush|blowdown|water/i);
  assert.match(AC.OFF_TRAIL_NOTE, /no trail/i, 'it has to say there is no trail');
  assert.ok(!/\bpath\b|\broute\b/i.test(AC.OFF_TRAIL_NOTE),
    'and must not borrow a word implying someone has been through: ' + AC.OFF_TRAIL_NOTE);
  const app = fs.readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  const at = app.indexOf('<dt>Getting in</dt>');
  assert.ok(at > 0, 'the sheet must render the approach in parts');
  const block = app.slice(at - 800, at + 1200);
  assert.match(block, /OFF_TRAIL_NOTE/, 'and always alongside the off-trail note');
  assert.match(block, /P\.offTrail/, 'showing the off-trail leg');
  assert.match(block, /P\.total/, 'and the total');
});

test('parts: every category carries its own approach, not just the named one', () => {
  /* 16,091 cells hold an approach for a category the sheet does not name. The primary category is
     chosen by class precedence, so the nearest TRAIL gets named even when it has no trailhead, while
     the road beside it has a perfectly good figure — and all of it was invisible. */
  /* A trail within NEAR (800 m) is what makes the class 'trail'; at 1,900 m the class is 'near'
     and the nearest category wins instead. */
  const d = partsRow({ trail: 600, trailWalk: -1, trailGain: -1,
                       road: 1200, roadWay: 1, roadWalk: 800, roadGain: 60, roadOffGain: 25 });
  const det = AC.accessDetail(d, partsWays);
  assert.equal(det.cat, 'trail', 'the class still names the trail');
  assert.equal(det.parts.onTrail, null, 'which has no on-trail figure');
  const road = det.others.find(o => o.cat === 'road');
  assert.ok(road, 'the road must appear as an alternative');
  assert.equal(road.parts.onTrail, 800, 'with its own on-trail leg');
  assert.equal(road.parts.offTrail, 1200);
  assert.equal(road.parts.total, 2000, 'and its own total');
  assert.ok(road.trailheadNote, 'and where it measured from');
  const app = fs.readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  const at = app.indexOf('<dt>Also nearby</dt>');
  assert.match(app.slice(at, at + 500), /o\.parts/, 'the sheet has to render those figures');
});

test('parts: naming still follows the class, which is a deliberate choice', () => {
  /* Switching the named route to whichever one carries a walk would rename 16,091 cells, 12,331 of
     them from a road to a rough track — from the road you would drive to a logging spur. Measured on
     the statewide file. This test pins the decision so it is not quietly reversed. */
  const d = partsRow({ trail: 600, trailWalk: -1, trailGain: -1,
                       rough: 300, roughWay: 1, roughWalk: 500, roughGain: 20, roughOffGain: 5 });
  const det = AC.accessDetail(d, partsWays);
  assert.equal(det.cat, 'trail',
    'a trail within NEAR is named even though the rough track is nearer AND carries the walk');
  assert.equal(AC.primaryCat(d), 'trail');
});

/* ===================== the trailhead is a place, not a flag =====================

   The walk used to be measured from arc 0 of the stored route whenever the trailhead was inferred,
   without recording WHICH end had met the road. On a sample of 25 inferred-trailhead routes, 5 had
   only their far end at a drivable road — checked against OSM and the USFS road layer — so their
   walk was measured backwards. Tyler Peak Trail's arc 0 sits 1,971 m from the nearest road of any
   kind. And 60% of cells on a joined route were pinned to arc 0 of the whole chain, which can be a
   different member entirely, since joinRoutes reverses and reorders members as it builds one.

   The fixture below is the minimal version: a trail whose ROAD END IS ITS LAST VERTEX. */
function reversedTrailDeps(counts = {}) {
  const d = fakeDeps(counts);
  const inner = d.overpass;
  d.overpass = async (s, w, n, e, cb) => {
    await inner(s, w, n, e, (el) => {
      if (el.id === 102) {
        /* Same trail, same road contact, geometry written south-last. Every coordinate is identical
           to the fixture's; only the order changed. Nothing about the ground is different, so any
           difference in the walk figure is the bug. */
        cb({ ...el, geometry: el.geometry.slice().reverse() });
      } else cb(el);
    });
  };
  return d;
}

const routeLength = geom => {
  let m = 0;
  for (let i = 1; i < geom.length; i++) {
    const [aLa, aLn] = geom[i - 1], [bLa, bLn] = geom[i];
    m += Math.hypot((bLn - aLn) * 111320 * Math.cos(aLa * Math.PI / 180), (bLa - aLa) * 111132);
  }
  return m;
};

async function bakeTrail(deps) {
  const dir = tmpdir();
  cellsFixture(dir);
  const opts = A.parseArgs([`--cells=${path.join(dir, 'cells.json')}`,
    `--out=${path.join(dir, 'a.json')}`, '--bbox=47,-123,49,-121', '--skip-usfs']);
  const r = await A.build(opts, deps);
  const geom = JSON.parse(fs.readFileSync(path.join(dir, 'a-geom.json'), 'utf8')).geom;
  const n = r.ways.findIndex(w => w[0] === 'Bear Creek Trail');
  assert.ok(n >= 0, 'the fixture trail must be stored');
  const g = AC.decodeGeom(geom[n]);
  /* the cell whose trail walk is longest — i.e. the far end of the route from its trailhead */
  let far = null;
  for (const row of r.rows) {
    const dd = AC.decodeRow(row);
    if (dd.trailWay !== n || dd.trailWalk < 0) continue;
    if (!far || dd.trailWalk > far.trailWalk) far = dd;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { ways: r.ways, rows: r.rows, n, g, len: routeLength(g), far, th: r.ways[n][4] };
}

test('trailhead: the walk is measured from the end that meets the road, whichever end that is', async () => {
  const forward = await bakeTrail(fakeDeps());
  const reversed = await bakeTrail(reversedTrailDeps());

  assert.equal(forward.th, AC.TRAILHEAD_INFERRED, 'the forward fixture infers a trailhead');
  assert.equal(reversed.th, AC.TRAILHEAD_INFERRED, 'and so does the reversed one');
  assert.ok(Math.abs(forward.len - reversed.len) < 5, 'the two routes are the same length');

  assert.ok(forward.far && reversed.far, 'both must produce a walk figure');
  /* The far end of the route is most of a route length from the trailhead, in BOTH orderings. Under
     the old arc-0 pinning the reversed fixture reported near zero here, because arc 0 was the far
     end rather than the road end. */
  const want = forward.len * 0.5;
  assert.ok(forward.far.trailWalk > want,
    `forward: the far cell should be well up the trail, got ${forward.far.trailWalk} m of ${forward.len.toFixed(0)} m`);
  assert.ok(reversed.far.trailWalk > want,
    `reversed: same trail, same road end, so the same answer — got ${reversed.far.trailWalk} m of ${reversed.len.toFixed(0)} m`);
  /* and the two orderings agree with each other, which is the real invariant */
  assert.ok(Math.abs(forward.far.trailWalk - reversed.far.trailWalk) < 60,
    `the walk must not depend on the order the vertices were written: ${forward.far.trailWalk} vs ${reversed.far.trailWalk}`);
});

test('trailhead: a route whose trailhead cannot be placed reports no walk at all', async () => {
  /* Rather than measuring from an assumed end. This is the same rule as "no trailhead, no walk" —
     if we do not know where you would leave the car, the figure is unavailable. */
  const src = fs.readFileSync(fileURLToPath(new URL('./build-access.mjs', import.meta.url)), 'utf8');
  assert.match(src, /if \(!j\.thPt\) \{ thUnplaced\+\+; continue; \}/,
    'a trailhead with no recorded point must leave thArc at -1');
  assert.ok(!/thArc\[n\] = 0/.test(src),
    'and nothing may pin an arc to zero as a fallback: ' + (src.match(/thArc\[n\][^\n]*/g) || []).join(' | '));
  assert.match(src, /thArc\[n\] = nearestOnWay\(j\.geom, j\.thPt\[0\], j\.thPt\[1\]\)\.arc/,
    'the arc comes from projecting the recorded point onto the finished route');
  /* and the provenance says how many could not be placed, so a regression is visible in the file */
  assert.match(src, /trailheads_unplaced: thUnplaced/);
});

test('trailhead: joining carries the point of the member that had it', async () => {
  /* A flag cannot express "the trailhead is at the far end of the third member, which was reversed
     on the way into the chain". A coordinate can. */
  const src = fs.readFileSync(fileURLToPath(new URL('./build-access.mjs', import.meta.url)), 'utf8');
  assert.match(src, /thPt: thMember \? thMember\.thPt : null/, 'joinRoutes must carry a trailhead point');
  assert.match(src, /thPt: w\.thPt \|\| null/, 'and the join input must include it in the first place');
  const joined = A.joinRoutes([
    { wid: 'a', name: 'X', ref: null, type: 'path', cat: 'trail', th: AC.TRAILHEAD_INFERRED,
      thPt: [47.02, -122.0], segments: 1, geom: [[47.0, -122.0], [47.02, -122.0]] },
    { wid: 'b', name: 'X', ref: null, type: 'path', cat: 'trail', th: AC.TRAILHEAD_NONE,
      thPt: null, segments: 1, geom: [[47.02, -122.0], [47.04, -122.0]] },
  ]);
  assert.equal(joined.length, 1, 'the two segments chain');
  assert.equal(joined[0].th, AC.TRAILHEAD_INFERRED, 'and keep the trailhead');
  assert.deepEqual(joined[0].thPt, [47.02, -122.0], 'and the point it was at');
});

test('honesty: the no-trailhead note matches where it sits on the sheet', () => {
  /* NO_TRAILHEAD_NOTE points at "the figure above", which is true in the straight-line row and false
     in the approach block, where the unavailable leg is printed first. Two notes, each used where
     its own wording is true. A note that points at the wrong line is a small lie in a section whose
     entire job is not telling them. */
  assert.match(AC.NO_TRAILHEAD_NOTE, /figure above/);
  assert.ok(!/above/.test(AC.NO_ON_TRAIL_NOTE), 'the approach-block note must not point upward');
  assert.match(AC.NO_ON_TRAIL_NOTE, /below/, 'it points at the off-trail leg that follows it');
  assert.match(AC.NO_ON_TRAIL_NOTE, /nowhere to measure a walk/, 'and still says why');
  const app = fs.readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  const at = app.indexOf('<dt>Getting in</dt>');
  /* Cut at the straight-line branch: that row legitimately uses the other note, and a slice wide
     enough to include it would make this assertion meaningless. */
  const end = app.indexOf('} else if(ac.straight', at);
  assert.ok(end > at, 'the approach block and the straight-line row must both still exist');
  const block = app.slice(at, end);
  assert.match(block, /NO_ON_TRAIL_NOTE/, 'the approach block uses the downward-pointing one');
  assert.ok(!/NO_TRAILHEAD_NOTE/.test(block), 'and not the upward-pointing one');
  const straight = app.slice(app.indexOf('<dt>Distance</dt>'), app.indexOf('<dt>Distance</dt>') + 300);
  assert.match(straight, /NO_TRAILHEAD_NOTE/, 'while the straight-line row keeps it');
});

test('parts: the on-route leg is called what it actually is', () => {
  /* "4.8 mi on the trail" about Moses Stool Road is wrong, and it is the kind of small wrongness
     that makes a reader discount the numbers beside it. The off-trail leg keeps its own name in
     every case: it names the leg, not the way, and there is no way there at all. */
  assert.equal(AC.onRouteLabel('road'), 'on the road');
  assert.equal(AC.onRouteLabel('trail'), 'on the trail');
  assert.equal(AC.onRouteLabel('rough'), 'on the track');
  assert.equal(AC.onRouteLabel(undefined), 'along the way', 'and never guesses at a category it has no word for');
  const app = fs.readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  const at = app.indexOf('<dt>Getting in</dt>');
  const block = app.slice(at, app.indexOf('} else if(ac.straight', at));
  assert.match(block, /onRouteLabel\(ac\.cat\)/, 'the named route labels its leg by its own category');
  assert.ok(!/'on the trail'/.test(block), 'and nothing hard-codes "on the trail"');
  const also = app.slice(app.indexOf('<dt>Also nearby</dt>'), app.indexOf('<dt>Also nearby</dt>') + 600);
  assert.match(also, /onRouteLabel\(o\.cat\)/, 'and so does each alternative');
});
