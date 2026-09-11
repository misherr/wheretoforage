/* Where OSM and USFS both map a road, and what the bake decides about it.
   Run: node --test scripts/access-rules.test.mjs   (npm run test:data globs it)

   Three fixes, each of which changed the figures of real cells:
     - over-snow routes are not trails;
     - where both sources map a road, USFS's maintenance level decides its category, except where OSM
       DESCRIBES the road — paved, or 4wd-only / closed to motor vehicles / impassable;
     - a USFS record in several pieces is several ways, not one line drawn across the gaps.
   And the consequence that matters most: a trailhead is inferred after all of that, so a trail that
   ended only at a road USFS calls high-clearance no longer gets a walk measured from it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as A from './build-access.mjs';
import * as AC from '../src/access.mjs';

/* A road along a line of latitude, and a copy of it `off` metres to the north. */
const M_LAT = 111320;
const line = (lat, lon0, lon1, n = 12) => Array.from({ length: n + 1 }, (_, k) => [lat, lon0 + (lon1 - lon0) * k / n]);
const shifted = (g, off) => g.map(([la, lo]) => [la + off / M_LAT, lo]);
const way = (o) => ({ name: null, ref: null, th: AC.TRAILHEAD_NONE, ...o });
const LAT = 47.5, W0 = -121.60, W1 = -121.58;          // ~1.5 km of road
const road = line(LAT, W0, W1);

/* ===================== the vocabulary ===================== */

test('describing tags: 4wd-only, closed to motor vehicles and impassable all mean rough', () => {
  for (const tags of [{ '4wd_only': 'yes' }, { motor_vehicle: 'no' }, { smoothness: 'impassable' },
                      { smoothness: 'very_horrible' }]) {
    assert.ok(AC.osmRoughReason(tags), JSON.stringify(tags) + ' describes a road a car cannot use');
    assert.equal(AC.osmCategory({ highway: 'unclassified', ...tags }), 'rough',
      'and an OSM-only road tagged that way is rough, whatever highway= says');
  }
  for (const tags of [{ smoothness: 'bad' }, { motor_vehicle: 'yes' }, { '4wd_only': 'no' }, {}])
    assert.equal(AC.osmRoughReason(tags), null, JSON.stringify(tags) + ' says nothing of the kind');
  assert.equal(AC.osmCategory({ highway: 'unclassified' }), 'road');
});

test('describing tags: on a motorway, motor_vehicle=no is a managed lane, not a closed road', () => {
  for (const highway of ['motorway', 'motorway_link', 'trunk', 'trunk_link']) {
    assert.equal(AC.osmRoughReason({ highway, motor_vehicle: 'no' }), null, highway);
    assert.equal(AC.osmCategory({ highway, motor_vehicle: 'no' }), 'road', highway + ' stays a road');
  }
  assert.equal(AC.osmCategory({ highway: 'secondary', motor_vehicle: 'no' }), 'rough',
    'a closed stretch of an ordinary highway — Spirit Lake Highway — is still rough');
  /* and a checkpoint that stored the reason before this rule existed is guarded at assembly */
  const m = new Map([['o1', way({ type: 'motorway_link', cat: 'road', rd: 'motor_vehicle=no', geom: road })]]);
  A.applyRules(m);
  assert.equal(m.get('o1').cat, 'road');
});

test('describing tags: paved means a paved surface, not merely a hard one', () => {
  for (const s of ['paved', 'asphalt', 'concrete', 'chipseal']) assert.ok(AC.osmPaved({ surface: s }), s);
  for (const s of ['gravel', 'compacted', 'dirt', 'unpaved', undefined]) assert.ok(!AC.osmPaved({ surface: s }), String(s));
});

/* ===================== snow ===================== */

test('snow: an over-snow USFS route is not a trail, and a summer one still is', () => {
  const ways = new Map([
    ['unfst1', way({ type: 'nfst', cat: 'trail', tt: 'SNOW', geom: road })],
    ['unfst2', way({ type: 'nfst', cat: 'trail', tt: 'TERRA', geom: shifted(road, 500) })],
  ]);
  const st = A.applyRules(ways);
  assert.ok(!ways.has('unfst1'), 'the snowmobile route is gone before anything is stamped from it');
  assert.ok(ways.has('unfst2'), 'a TERRA trail is untouched');
  assert.equal(st.snow_routes.ways, 1);
  assert.ok(st.snow_routes.km > 1, 'and its length is recorded in provenance');
});

test('snow: the rule can be switched off, which is how its effect is measured', () => {
  const ways = new Map([['unfst1', way({ type: 'nfst', cat: 'trail', tt: 'SNOW', geom: road })]]);
  A.applyRules(ways, { snow: false, described: false, usfs: false });
  assert.ok(ways.has('unfst1'));
});

/* ===================== USFS decides ===================== */

const pair = (osm, usfs, off = 7) => new Map([
  ['o1', way({ type: 'unclassified', cat: 'road', geom: road, ...osm })],
  ['unfsr1', way({ type: 'nfsr', cat: 'rough', ml: '2', geom: shifted(road, off), ...usfs })],
]);

test('usfs: an OSM road with a level-2 USFS twin is rough, and a track with a level-3 twin is a road', () => {
  const a = pair({}, {});
  A.applyRules(a);
  assert.equal(a.get('o1').cat, 'rough', 'OSM unclassified over a high-clearance USFS road');
  assert.equal(a.get('o1').catBy, 'usfs');
  const b = pair({ type: 'track', cat: 'rough' }, { cat: 'road', ml: '3' });
  A.applyRules(b);
  assert.equal(b.get('o1').cat, 'road', 'OSM track over a passenger-car USFS road');
});

test('usfs: a closed-layer twin makes the OSM copy rough', () => {
  const m = pair({}, { type: 'nfsr-closed', cat: 'rough' });
  m.set('unfsr-closed1', m.get('unfsr1')); m.delete('unfsr1');
  A.applyRules(m);
  assert.equal(m.get('o1').cat, 'rough');
});

test('usfs: paved beats a level-2 record, but not a closure', () => {
  const a = pair({ pv: 1 }, {});
  const st = A.applyRules(a).usfs;
  assert.equal(a.get('o1').cat, 'road', 'OSM says paved; USFS records lag');
  assert.equal(a.get('o1').catBy, 'paved');
  assert.equal(st.paved, 1);
  assert.equal(a.get('unfsr1').cat, 'road', 'the USFS copy it covers follows, or the cell holds the road twice');
  const closed = new Map([
    ['o1', way({ type: 'unclassified', cat: 'road', pv: 1, geom: road })],
    ['unfsr-closed1', way({ type: 'nfsr-closed', cat: 'rough', geom: shifted(road, 7) })],
  ]);
  A.applyRules(closed);
  assert.equal(closed.get('o1').cat, 'rough', 'paving says nothing about a gate');
});

test('usfs: a describing tag beats a level-3 record, and beats paved', () => {
  for (const rd of ['4wd_only=yes', 'motor_vehicle=no', 'smoothness=impassable', 'smoothness=very_horrible']) {
    const m = pair({ rd, pv: 1 }, { cat: 'road', ml: '3' });
    A.applyRules(m);
    assert.equal(m.get('o1').cat, 'rough', rd + ' over a passenger-car USFS road is still rough');
  }
});

test('usfs: two roads that merely meet or run apart are not twins', () => {
  // a USFS road 120 m away, parallel: a different road
  const far = pair({}, {}, 120);
  A.applyRules(far);
  assert.equal(far.get('o1').cat, 'road', 'OSM keeps its own category when no USFS record traces it');
  // a USFS road crossing at right angles
  const cross = new Map([
    ['o1', way({ type: 'unclassified', cat: 'road', geom: road })],
    ['unfsr1', way({ type: 'nfsr', cat: 'rough', geom: [[LAT - 0.01, -121.59], [LAT + 0.01, -121.59]] })],
  ]);
  A.applyRules(cross);
  assert.equal(cross.get('o1').cat, 'road', 'a crossing is not a copy');
  assert.equal(A.findTwins(cross).size, 0);
});

test('usfs: a short OSM piece lying along the USFS road takes its category too', () => {
  // 200 m of OSM road, entirely along a 1.5 km USFS record — a road split at a junction
  const piece = line(LAT, -121.595, -121.5923, 4);
  const m = new Map([
    ['o1', way({ type: 'unclassified', cat: 'road', geom: piece })],
    ['unfsr1', way({ type: 'nfsr', cat: 'rough', geom: shifted(road, 6) })],
  ]);
  A.applyRules(m);
  assert.equal(m.get('o1').cat, 'rough');
});

test('usfs: a spur beside a small part of a long road does not decide the whole road', () => {
  /* The live check found State Route 410 demoted to rough because a 337 m level-2 spur ran beside 7%
     of a 3.3 km OSM way. The pair was a genuine twin by the duplicate test; USFS just does not get to
     speak for the 93% it does not run along. */
  const long = line(LAT, -121.62, -121.58, 40);                     // ~3 km
  const spur = shifted(line(LAT, -121.62, -121.6165, 4), 8);         // ~260 m beside its west end
  const m = new Map([
    ['o1', way({ type: 'unclassified', cat: 'road', geom: long })],
    ['unfsr1', way({ type: 'nfsr', cat: 'rough', ml: '2', geom: spur })],
  ]);
  assert.ok(A.findTwins(m).has('o1'), 'they are twins where they overlap');
  const st = A.applyRules(m).usfs;
  assert.equal(m.get('o1').cat, 'road', 'but the spur covers too little of the road to decide it');
  assert.equal(st.kept_partial, 1);
});

test('usfs: a state or federal highway is never recategorised by a USFS level', () => {
  for (const type of ['primary', 'secondary', 'trunk', 'motorway', 'primary_link']) {
    const m = pair({ type }, {});
    const st = A.applyRules(m).usfs;
    assert.equal(m.get('o1').cat, 'road', type + ' stays a road over a level-2 record');
    assert.equal(st.kept_highway, 1);
  }
  const t = pair({ type: 'tertiary' }, {});
  A.applyRules(t);
  assert.equal(t.get('o1').cat, 'rough', 'tertiary is often a forest road (FR 42 is), so USFS still decides it');
});

/* ===================== pieces ===================== */

test('pieces: a USFS record in two disjoint paths becomes two ways, with no line across the gap', () => {
  const f = { attributes: { objectid: 77, name: 'X', id: '2204', oper_maint_level: '2 - HIGH CLEARANCE VEHICLES' },
    geometry: { paths: [[[-121.60, 47.5], [-121.59, 47.5]], [[-121.55, 47.5], [-121.54, 47.5]]] } };
  const ws = A.usfsWays(f, 'nfsr');
  assert.equal(ws.length, 2, 'one way per path');
  assert.deepEqual(ws.map(([wid]) => wid), ['unfsr77.1', 'unfsr77.2']);
  for (const [, w] of ws) {
    const lons = w.geom.map(p => p[1]);
    assert.ok(Math.max(...lons) - Math.min(...lons) < 0.011, 'neither piece spans the 3 km gap');
    assert.equal(w.ref, '2204'); assert.equal(w.cat, 'rough'); assert.equal(w.ml, '2');
  }
  const one = A.usfsWays({ ...f, geometry: { paths: [f.geometry.paths[0]] } }, 'nfsr');
  assert.deepEqual(one.map(([wid]) => wid), ['unfsr77'], 'a single-path record keeps its plain id');
});

test('pieces: the bake never flattens paths again', () => {
  const src = fs.readFileSync(new URL('./build-access.mjs', import.meta.url), 'utf8');
  assert.ok(!/paths\.flat\(/.test(src), 'paths.flat() drew straight lines across every gap');
});

test('pieces: a trail keeps its trail_type, so the snow rule has something to read', () => {
  const [[, w]] = A.usfsWays({ attributes: { objectid: 5, trail_name: 'Y', trail_no: '1', trail_type: 'SNOW' },
    geometry: { paths: [[[-121.6, 47.5], [-121.59, 47.5]]] } }, 'nfst');
  assert.equal(w.tt, 'SNOW'); assert.equal(w.cat, 'trail');
});

/* ===================== trailheads, after the rules ===================== */

test('trailhead: a trail ending only on a road USFS calls high-clearance gets no trailhead', () => {
  const trail = line(LAT + 0.0001, -121.58, -121.56);        // starts at the road's east end
  const ways = new Map([
    ['o1', way({ type: 'unclassified', cat: 'road', geom: road })],
    ['unfsr1', way({ type: 'nfsr', cat: 'rough', ml: '2', geom: shifted(road, 7) })],
    ['o2', way({ type: 'path', cat: 'trail', geom: trail })],
  ]);
  const before = new Map([...ways].map(([k, v]) => [k, { ...v }]));
  A.inferTrailheads(before);
  assert.equal(before.get('o2').th, AC.TRAILHEAD_INFERRED, 'without the rule, the OSM road made a trailhead');
  A.applyRules(ways);
  A.inferTrailheads(ways);
  assert.equal(ways.get('o2').th, AC.TRAILHEAD_NONE, 'with USFS deciding, there is nowhere a car can park');
  assert.equal(ways.get('o2').thPt, undefined);
});

test('trailhead: if the other end meets a real road, the trailhead moves there', () => {
  const trail = line(LAT + 0.0001, -121.58, -121.56);
  const ways = new Map([
    ['o1', way({ type: 'unclassified', cat: 'road', geom: road })],
    ['unfsr1', way({ type: 'nfsr', cat: 'rough', ml: '2', geom: shifted(road, 7) })],
    ['o2', way({ type: 'path', cat: 'trail', geom: trail })],
    ['o3', way({ type: 'secondary', cat: 'road', geom: [[LAT - 0.01, -121.56], [LAT + 0.01, -121.56]] })],
  ]);
  A.applyRules(ways);
  A.inferTrailheads(ways);
  assert.equal(ways.get('o2').th, AC.TRAILHEAD_INFERRED);
  assert.deepEqual(ways.get('o2').thPt, trail[trail.length - 1], 'the far end, at the secondary road');
});

test('trailhead: a mapped node still outranks an inferred end', () => {
  const trail = line(LAT + 0.0001, -121.58, -121.56);
  const ways = new Map([
    ['o3', way({ type: 'secondary', cat: 'road', geom: [[LAT - 0.01, -121.58], [LAT + 0.01, -121.58]] })],
    ['o2', way({ type: 'path', cat: 'trail', geom: trail })],
  ]);
  const node = [LAT + 0.0005, -121.57];
  const st = A.inferTrailheads(ways, [node]);
  assert.equal(ways.get('o2').th, AC.TRAILHEAD_MAPPED);
  assert.deepEqual(ways.get('o2').thPt, node);
  assert.deepEqual(st, { inferred: 0, mapped: 1 });
});

test('trailhead: inference is recomputed, never inherited from what a checkpoint said', () => {
  const ways = new Map([['o2', way({ type: 'path', cat: 'trail', geom: line(LAT, -121.58, -121.56),
                                       th: AC.TRAILHEAD_INFERRED, thPt: [LAT, -121.58] })]]);
  A.inferTrailheads(ways);
  assert.equal(ways.get('o2').th, AC.TRAILHEAD_NONE, 'no road anywhere, so no trailhead — whatever it was before');
});

/* ===================== the bake, end to end ===================== */

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'access-rules-'));
function cellsFile(dir) {
  const rows = [];
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) rows.push([47.48 + i * 0.0145, -121.62 + j * 0.0214, 900, 5, 180, null]);
  const f = path.join(dir, 'cells.json');
  fs.writeFileSync(f, JSON.stringify({ version: 2, generated: 'g', names: [], rows }));
  return f;
}
/* OSM: an unclassified road, and a trail starting on it. USFS: the same road at level 2, a snow route
   across the cells, and a two-piece closed road. */
function deps(pages = []) {
  return {
    overpass: async (s, w, n, e, cb) => {
      cb({ type: 'way', id: 1, tags: { highway: 'unclassified', name: 'FR 2204' },
           geometry: road.map(([lat, lon]) => ({ lat, lon })) });
      cb({ type: 'way', id: 2, tags: { highway: 'path', name: 'Ridge Trail' },
           geometry: line(LAT + 0.0001, -121.58, -121.56).map(([lat, lon]) => ({ lat, lon })) });
    },
    arcgis: async (url, s, w, n, e, fields, page) => {
      pages.push({ url, offset: page && page.offset, fatal: page && page.fatal });
      const toPath = g => g.map(([la, lo]) => [lo, la]);
      if (/RoadBasic_01\/MapServer\/0$/.test(url)) return { features: [
        { attributes: { objectid: 10, name: 'FR 2204', id: '2204', oper_maint_level: '2 - HIGH CLEARANCE VEHICLES' },
          geometry: { paths: [toPath(shifted(road, 7))] } }] };
      if (/RoadBasic_01\/MapServer\/1$/.test(url)) return { features: [
        { attributes: { objectid: 11, name: 'SPUR', id: '2204100' },
          geometry: { paths: [toPath(line(LAT + 0.02, -121.62, -121.61, 3)), toPath(line(LAT + 0.02, -121.57, -121.56, 3))] } }] };
      if (/Trail/.test(url)) return { features: [
        { attributes: { objectid: 12, trail_name: 'SNO-PARK LOOP', trail_no: '9', trail_type: 'SNOW' },
          geometry: { paths: [toPath(line(LAT + 0.03, -121.62, -121.54))] } }] };
      return { features: [] };
    },
  };
}

test('bake: USFS is paged for the region, every page fatal on failure', async () => {
  const dir = tmpdir(), pages = [];
  const opts = A.parseArgs([`--cells=${cellsFile(dir)}`, `--out=${path.join(dir, 'a.json')}`,
    '--bbox=47.4,-121.7,47.6,-121.5', '--skip-elevation']);
  const r = await A.build(opts, deps(pages));
  assert.equal(pages.length, 3, 'one page per layer here, not three requests per tile');
  assert.ok(pages.every(p => p.offset === 0 && p.fatal === true), 'paged, and a failed page throws');
  const u = r.provenance.usfs_fetch;
  assert.equal(u.multi_path, 1); assert.equal(u.pieces, 4, 'road, two closed pieces, snow route');
  const ck = JSON.parse(fs.readFileSync(opts.checkpoint, 'utf8'));
  assert.equal(ck.schema, A.CHECKPOINT_SCHEMA);
  assert.ok(ck.ways['unfsr-closed11.1'] && ck.ways['unfsr-closed11.2'], 'the pieces are stored as pieces');
  assert.equal(ck.ways.unfst12.tt, 'SNOW', 'the checkpoint keeps what the source said');
  assert.equal(ck.ways.o1.cat, 'road', 'and not what a rule derived: OSM called it a road');
  assert.equal(ck.nearest, undefined, 'per-cell results are assembly, not source data');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bake: the rules reach the rows — no snow trail, the OSM road rough, and no walk from it', async () => {
  const dir = tmpdir();
  const opts = A.parseArgs([`--cells=${cellsFile(dir)}`, `--out=${path.join(dir, 'a.json')}`,
    '--bbox=47.4,-121.7,47.6,-121.5', '--skip-elevation']);
  const r = await A.build(opts, deps());
  const names = r.ways.map(w => w[0]);
  assert.ok(!names.includes('SNO-PARK LOOP'), 'no cell names the snow route');
  const fr = r.ways.findIndex(w => w[0] === 'FR 2204' && w[2] === 'unclassified');
  assert.ok(fr < 0 || r.ways[fr][3] === AC.CATS.indexOf('rough'), 'the OSM copy is stored as rough if at all');
  assert.ok(!r.ways.some(w => w[0] === 'FR 2204' && w[3] === AC.CATS.indexOf('road')), 'nothing calls FR 2204 drivable');
  const t = r.ways.findIndex(w => w[0] === 'Ridge Trail');
  assert.ok(t >= 0, 'the trail is still there');
  assert.equal(r.ways[t][4], AC.TRAILHEAD_NONE, 'but it has no trailhead: its only road is high-clearance');
  for (const row of r.rows) {
    const d = AC.decodeRow(row);
    if (d.trailWay === t) assert.equal(d.trailWalk, -1, 'so no cell shows a walk along it');
  }
  assert.equal(r.provenance.rules.snow_routes.ways, 1);
  assert.equal(r.provenance.rules.usfs.to_rough, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('checkpoint: a schema-1 checkpoint is upgraded in place, never re-fetched', async () => {
  const dir = tmpdir(), pages = [], queries = [];
  const cells = cellsFile(dir), out = path.join(dir, 'a.json'), ckf = out + '.checkpoint.json';
  const tiles = A.tilesFor(JSON.parse(fs.readFileSync(cells, 'utf8')).rows.map(r => ({ lat: r[0], lon: r[1] })),
    { lat0: 47.4, lat1: 47.6, lon0: -121.7, lon1: -121.5 });
  /* what the old bake wrote: flattened USFS, no trail_type, no describing tags, per-cell results */
  fs.writeFileSync(ckf, JSON.stringify({ generator_version: '4.0.0', region: 'bbox', doneTiles: tiles.map(t => t.k),
    trailheads: [], nearest: { '1:1': [5, 'o1', 0, -1, -1, -1, -1, -1, -1] },
    ways: { o1: way({ type: 'unclassified', cat: 'road', geom: road }),
            'unfsr-closed11': way({ type: 'nfsr-closed', cat: 'rough', geom: [...line(LAT + 0.02, -121.62, -121.61, 3), ...line(LAT + 0.02, -121.57, -121.56, 3)] }) } }));
  const d = deps(pages);
  d.overpass = async () => { throw new Error('the OSM tiles must not be fetched again'); };
  d.overpassRaw = async q => { queries.push(q); return { elements: /4wd_only/.test(q) ? [{ id: 1, tags: { highway: 'unclassified', motor_vehicle: 'no' } }] : [] }; };
  const opts = A.parseArgs([`--cells=${cells}`, `--out=${out}`, '--bbox=47.4,-121.7,47.6,-121.5', '--resume', '--skip-elevation']);
  const r = await A.build(opts, d);
  const ck = JSON.parse(fs.readFileSync(ckf, 'utf8'));
  assert.equal(ck.schema, A.CHECKPOINT_SCHEMA, 'upgraded');
  assert.ok(!ck.ways['unfsr-closed11'], 'the flattened record is replaced');
  assert.ok(ck.ways['unfsr-closed11.1'], 'by its pieces');
  assert.equal(ck.ways.o1.rd, 'motor_vehicle=no', 'the describing tag was backfilled');
  assert.equal(pages.length, 3, 'USFS by page');
  assert.ok(queries.length >= 1 && queries.length <= 6,
    'and a handful of Overpass tag queries — describing tags, then gates, restricted roads and paved: ' + queries.length);
  assert.equal(r.provenance.checkpoint_schema, A.CHECKPOINT_SCHEMA);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('checkpoint: a tag query too big for Overpass is split, not skipped', async () => {
  /* The statewide describing-tag query timed out with a 504 on every mirror on the first real upgrade.
     The answer is the tile fetch's: ask for quarters. A skipped area would leave its 4wd-only roads
     reading as drivable, with nothing to say so. */
  const dir = tmpdir(), queries = [];
  const cells = cellsFile(dir), out = path.join(dir, 'a.json'), ckf = out + '.checkpoint.json';
  const tiles = A.tilesFor(JSON.parse(fs.readFileSync(cells, 'utf8')).rows.map(r => ({ lat: r[0], lon: r[1] })),
    { lat0: 47.4, lat1: 47.6, lon0: -121.7, lon1: -121.5 });
  fs.writeFileSync(ckf, JSON.stringify({ generator_version: '4.0.0', region: 'bbox', doneTiles: tiles.map(t => t.k),
    trailheads: [], ways: { o1: way({ type: 'unclassified', cat: 'road', geom: road }) } }));
  const d = deps();
  d.overpass = async () => { throw new Error('the OSM tiles must not be fetched again'); };
  d.overpassRaw = async q => {
    queries.push(q);
    if (/4wd_only/.test(q) && queries.filter(x => /4wd_only/.test(x)).length === 1) throw new Error('HTTP 504');
    return { elements: /4wd_only/.test(q) ? [{ id: 1, tags: { highway: 'unclassified', '4wd_only': 'yes' } }] : [] };
  };
  const opts = A.parseArgs([`--cells=${cells}`, `--out=${out}`, '--bbox=47.4,-121.7,47.6,-121.5', '--resume', '--skip-elevation']);
  await A.build(opts, d);
  const tagQs = queries.filter(q => /4wd_only/.test(q));
  assert.equal(tagQs.length, 5, 'the whole area once, then its four quarters');
  assert.ok(!/\["highway"~/.test(tagQs[0]), 'by tag alone: the highway regex is what made it too expensive');
  assert.equal(JSON.parse(fs.readFileSync(ckf, 'utf8')).ways.o1.rd, '4wd_only=yes', 'and the tag still arrives');
  fs.rmSync(dir, { recursive: true, force: true });
});
