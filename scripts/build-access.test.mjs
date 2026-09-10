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
      cb({ type: 'way', id: 103, tags: { highway: 'track' },
           geometry: [{ lat: n - 0.01, lon: w }, { lat: n - 0.01, lon: e }] });
      cb({ type: 'way', id: 104, tags: { highway: 'footway' },
           geometry: [{ lat: mid, lon: w }, { lat: mid, lon: e }] });
    },
    arcgis: async () => { counts.arc++; return { features: [] }; },
  };
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
  for (const row of r.rows) assert.equal(row.length, 11,
    'rows are [i, j] then distance/way/walk per category');
  for (const row of r.rows) {
    const d = AC.decodeRow(row);
    assert.ok(AC.CATS.some(c => d[c] >= 0), 'a row exists only when something was found');
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
  const prev = { version: 2, generated: 'old', cap_m: 2000, provenance: { counts: {} },
    ways: [['Old Road', null, 'unclassified', 0, 0, g(1)], ['Dead Way', null, 'track', 2, 0, g(2)]],
    rows: [[10, 20, 100, 0, -1, -1, -1, -1, -1, -1, -1],
           [10, 21, -1, -1, -1, 700, 1, -1, -1, -1, -1]] };
  const fresh = { version: 2, generated: 'new', cap_m: 2000, provenance: { counts: {} },
    ways: [['New Trail', null, 'path', 1, 2, g(3)]],
    rows: [[10, 21, -1, -1, -1, 42, 0, 17, -1, -1, -1]] };
  const m = A.mergeInto(prev, fresh);
  assert.equal(m.rows.length, 2, 'no cell may be lost');
  const byKey = Object.fromEntries(m.rows.map(r => [r[0] + ':' + r[1], r]));
  const nameOf = (row, cat) => {
    const d = AC.decodeRow(row);
    const wi = d[cat + 'Way'];
    return wi >= 0 ? AC.wayLabel(AC.decodeWay(m.ways[wi])) : null;
  };
  assert.equal(nameOf(byKey['10:21'], 'trail'), 'New Trail', 'the rebaked cell takes the fresh way');
  assert.equal(AC.decodeRow(byKey['10:21']).trail, 42, 'and the fresh distance');
  assert.equal(nameOf(byKey['10:20'], 'road'), 'Old Road', 'an untouched cell keeps pointing at its own way');
  assert.ok(!m.ways.some(w => w[0] === 'Dead Way'), 'a way nothing references any more must be dropped');
  assert.equal(m.provenance.counts.carried_over, 1);
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
  for (const row of r.rows) for (const n of [3, 6, 9]) {
    if (row[n] >= 0) assert.ok(r.ways[row[n]], 'row points at way ' + row[n] + ' which does not exist');
  }
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

test('geometry: clipping keeps the stretch near the cells and drops the rest', () => {
  // A way running far past the only cell that references it should not carry its whole length.
  const long = [];
  for (let i = 0; i < 200; i++) long.push([47.0 + i * 0.01, -121.5]);
  const clipped = A.clipToCells(long, [[47.5, -121.5]], 2600);
  assert.ok(clipped.length < long.length / 4, 'expected heavy clipping, kept ' + clipped.length);
  assert.ok(clipped.some(([la]) => Math.abs(la - 47.5) < 0.03), 'the stretch by the cell must survive');
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
  const ways = [[null, null, 'path', 1, AC.TRAILHEAD_NONE, AC.encodeGeom([[47.5, -121.5], [47.51, -121.5]])]];
  const det = AC.accessDetail(d, ways);
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
  const ways = [['Bear Creek Trail', null, 'path', 1, AC.TRAILHEAD_INFERRED,
                 AC.encodeGeom([[47.5, -121.5], [47.51, -121.5]])]];
  const det = AC.accessDetail(d, ways);
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
