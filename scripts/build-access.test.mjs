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

const mkDist = (cells) => {
  const d = new Map();
  for (const [lat, lon] of cells) {
    const [i, j] = cellIndex(lat, lon);
    d.set(i + ':' + j, { c: [lat, lon], i, j, road: -1, trail: -1, rough: -1 });
  }
  return d;
};

test('geometry: a way through a cell records a short distance to that cell', () => {
  const [lat, lon] = cellCenter(3300, -5700);
  const d = mkDist([[lat, lon]]);
  A.stampWay(d, [[lat, lon - 0.02], [lat, lon + 0.02]], 'road');   // straight through the centre
  const cell = [...d.values()][0];
  assert.ok(cell.road >= 0 && cell.road < 60, `expected a near-zero distance, got ${cell.road}`);
  assert.equal(cell.trail, -1, 'other categories must stay untouched');
});

test('geometry: densification stops a long segment skipping past a cell', () => {
  /* Two endpoints far outside the cell, with the segment passing right through it. Recording only
     the vertices would miss it entirely, and the cell would read as unknown while a highway runs
     down the middle of it. */
  const [lat, lon] = cellCenter(3300, -5700);
  const d = mkDist([[lat, lon]]);
  A.stampWay(d, [[lat, lon - 0.5], [lat, lon + 0.5]], 'road');
  const cell = [...d.values()][0];
  assert.ok(cell.road >= 0 && cell.road < 60, `long segment was not sampled through the cell (got ${cell.road})`);
});

test('geometry: a way beyond the cap leaves the cell unknown', () => {
  const [lat, lon] = cellCenter(3300, -5700);
  const d = mkDist([[lat, lon]]);
  A.stampWay(d, [[lat + 0.5, lon], [lat + 0.5, lon + 0.01]], 'road');   // ~55 km north
  assert.equal([...d.values()][0].road, -1, 'nothing within the cap must stay -1, not a large number');
});

test('geometry: the nearest way wins when several are stamped', () => {
  const [lat, lon] = cellCenter(3300, -5700);
  const d = mkDist([[lat, lon]]);
  A.stampWay(d, [[lat + 0.01, lon], [lat + 0.01, lon + 0.001]], 'trail');
  const far = [...d.values()][0].trail;
  A.stampWay(d, [[lat + 0.001, lon], [lat + 0.001, lon + 0.001]], 'trail');
  const near = [...d.values()][0].trail;
  assert.ok(near < far, 'a closer way must replace a further one');
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
    /* One trail through the northern half of the area and one drivable road along its southern edge,
       so the result is checkable by hand rather than by whatever the fixture happens to produce. */
    overpass: async (s, w, n, e, cb) => {
      counts.osm++;
      const mid = (s + n) / 2;
      cb({ type: 'way', tags: { highway: 'path' }, geometry: [{ lat: mid + 0.01, lon: w }, { lat: mid + 0.01, lon: e }] });
      cb({ type: 'way', tags: { highway: 'residential' }, geometry: [{ lat: s + 0.005, lon: w }, { lat: s + 0.005, lon: e }] });
      cb({ type: 'way', tags: { highway: 'footway' }, geometry: [{ lat: mid, lon: w }, { lat: mid, lon: e }] });
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

test('bake: produces one row per cell, keyed by cell index', async () => {
  const dir = tmpdir();
  const { rows } = cellsFixture(dir);
  const out = path.join(dir, 'access.json');
  const opts = A.parseArgs([`--cells=${path.join(dir, 'cells.json')}`, `--out=${out}`,
    '--bbox=47,-123,49,-121', '--skip-usfs']);
  const r = await A.build(opts, fakeDeps());
  assert.equal(r.rows.length, rows.length);
  for (const row of r.rows) assert.equal(row.length, 5, 'rows are [i, j, road, trail, rough]');
  const keys = new Set(r.rows.map(x => x[0] + ':' + x[1]));
  assert.equal(keys.size, rows.length, 'cell indices must be unique');
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
  for (const [, , road, trail, rough] of r.rows) {
    const c = AC.classifyAccess({ road, trail, rough });
    classes[c] = (classes[c] || 0) + 1;
  }
  assert.ok(classes.trail > 0, 'the path should produce trail cells');
  assert.ok((classes.road || 0) + (classes.near || 0) > 0, 'the residential road should register');
  assert.ok(!Object.keys(classes).includes('rough'), 'nothing rough was in the fixture');
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
  const prev = { version: 1, generated: 'old', cap_m: 2000, provenance: { counts: {} },
    rows: [[10, 20, 100, -1, -1], [10, 21, -1, -1, -1], [10, 22, 500, 500, 500]] };
  const fresh = { version: 1, generated: 'new', cap_m: 2000, provenance: { counts: {} },
    rows: [[10, 21, 42, 43, 44]] };
  const m = A.mergeInto(prev, fresh);
  assert.equal(m.rows.length, 3, 'no cell may be lost');
  const byKey = Object.fromEntries(m.rows.map(r => [r[0] + ':' + r[1], r]));
  assert.deepEqual(byKey['10:21'], [10, 21, 42, 43, 44], 'the rebaked cell takes the fresh values');
  assert.deepEqual(byKey['10:20'], [10, 20, 100, -1, -1], 'an untouched cell keeps its own');
  assert.equal(m.provenance.counts.carried_over, 2);
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
