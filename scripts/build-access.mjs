#!/usr/bin/env node
/* Bake data/access.json: how you would physically reach each cell.
 *
 * A separate axis from suitability, and a separate FILE from cells.json on purpose. Access must never
 * filter or modify a score, and keeping it out of the scored dataset makes that structural rather
 * than a rule someone has to remember. It also means access can be re-baked on its own — the road
 * network changes on a completely different cadence from LANDFIRE vegetation.
 *
 * Sources, both of which matter and neither of which is sufficient alone:
 *   - OpenStreetMap via Overpass. The only source that covers PRIVATE timberland, which is where the
 *     unnamed tracks, skid roads and decommissioned spurs are — the ways that actually reach cut-over
 *     ground, and the ones most apps hide.
 *   - USFS EDW. Authoritative on national forest: system roads carry an operational maintenance
 *     level that separates passenger-car roads from high-clearance and closed ones, and there is a
 *     whole layer of roads closed to motorized use.
 *
 * Output rows are keyed by cell index [i, j] rather than by position in cells.json, so a re-bake of
 * cells.json cannot silently shift the association.
 *
 *   node scripts/build-access.mjs                     # the whole state
 *   node scripts/build-access.mjs --region=coast      # merged into the existing file
 *   node scripts/build-access.mjs --resume            # continue after a timeout
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DLAT, DLON, cellIndex, cellCenter } from '../src/grid.mjs';
import { osmCategory, USFS_DRIVABLE_ML, CAP, OSM_DRIVE, OSM_TRAIL, OSM_ROUGH } from '../src/access.mjs';
import { REGIONS, parseArgs as parseCellArgs } from './build-cells.mjs';

export const GENERATOR = 'scripts/build-access.mjs';
export const GENERATOR_VERSION = '1.0.0';

const UA = 'king-bolete-forecast/1.0 (github.com/misherr/wheretoforage)';

/* Several Overpass mirrors, tried in order, because one of them going away mid-bake is the normal
   case rather than the exceptional one. The main instance stopped answering entirely partway through
   the first statewide run — not a 429, a connect timeout — and a single hard-coded endpoint turns
   that into a dead job rather than a slower one. kumi.systems is explicitly provisioned for heavy
   use, which is what a 316-tile bake is. OVERPASS_URL overrides the list entirely. */
export const OVERPASS_MIRRORS = process.env.OVERPASS_URL ? [process.env.OVERPASS_URL] : [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];
const OVERPASS = OVERPASS_MIRRORS[0];   // recorded in provenance; the live choice is `mirror`, below
const USFS_ROADS = 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RoadBasic_01/MapServer';
const USFS_TRAILS = 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0';

const TILE = 0.25;            // degrees; small enough that a metro tile still answers
const PAD = 0.025;            // ~2.5 km, so a way just outside a tile still reaches cells inside it
const STEP_M = 40;            // polyline densification; a cell is ~1600 m across
const MIRROR_TRIES = 3;       // per area, across mirrors, before asking for a smaller area instead
const MAX_SPLIT_DEPTH = 4;    // a 0.3 deg tile can become 256 pieces; metro tiles need about 16
const ATTEMPTS = 6;           // USFS only — its endpoints are stable and do not need subdividing
const REQ_TIMEOUT = 180000;
const POLITE_MS = Number(process.env.OVERPASS_PAUSE || 1200);
const TILE_WORKERS = Number(process.env.ACCESS_WORKERS || 4);   // concurrent tiles; see the pool below
const CHECKPOINT_EVERY = Number(process.env.CHECKPOINT_EVERY || 5);

export const SOURCES = {
  osm: { name: 'OpenStreetMap via Overpass', endpoint: OVERPASS, licence: 'ODbL' },
  usfs_roads: { name: 'USFS National Forest System Roads (EDW)', endpoint: USFS_ROADS },
  usfs_trails: { name: 'USFS National Forest System Trails (EDW)', endpoint: USFS_TRAILS },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/* ===================== geometry ===================== */
const M_PER_DEG_LAT = 111320;
const mPerDegLon = lat => 111320 * Math.cos(lat * Math.PI / 180);

/* Distance from a point to every cell centre within CAP, done by walking the lattice neighbourhood
   rather than by searching: cells are a regular grid, so the candidates are a small fixed box. */
function stamp(dist, lat, lon, cat) {
  const dLat = CAP / M_PER_DEG_LAT, dLon = CAP / mPerDegLon(lat);
  const [i0] = cellIndex(lat - dLat, lon - dLon), [i1] = cellIndex(lat + dLat, lon + dLon);
  const j0 = cellIndex(lat - dLat, lon - dLon)[1], j1 = cellIndex(lat + dLat, lon + dLon)[1];
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const k = i + ':' + j;
      const cell = dist.get(k);
      if (!cell) continue;                    // not a scored cell; nothing to record
      const [cLat, cLon] = cell.c;
      const dy = (lat - cLat) * M_PER_DEG_LAT, dx = (lon - cLon) * mPerDegLon(cLat);
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > CAP) continue;
      if (cell[cat] < 0 || d < cell[cat]) cell[cat] = d;
    }
  }
}

/* Walk a polyline, stamping every STEP_M so a long straight segment cannot skip past a cell. */
export function stampWay(dist, coords, cat) {
  if (!coords || coords.length === 0) return;
  stamp(dist, coords[0][0], coords[0][1], cat);
  for (let n = 1; n < coords.length; n++) {
    const [aLat, aLon] = coords[n - 1], [bLat, bLon] = coords[n];
    const dy = (bLat - aLat) * M_PER_DEG_LAT, dx = (bLon - aLon) * mPerDegLon(aLat);
    const len = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.max(1, Math.ceil(len / STEP_M));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      stamp(dist, aLat + (bLat - aLat) * t, aLon + (bLon - aLon) * t, cat);
    }
  }
}

/* ===================== sources ===================== */
const KINDS = [...OSM_DRIVE, ...OSM_TRAIL, ...OSM_ROUGH].join('|');
export const overpassQuery = (s, w, n, e) => `[out:json][timeout:180];
(
  way["highway"~"^(${KINDS})$"]["area"!="yes"](${s},${w},${n},${e});
  way["highway"="service"]["service"~"^(forestry|forest|logging)$"](${s},${w},${n},${e});
  way["abandoned:highway"](${s},${w},${n},${e});
  way["disused:highway"](${s},${w},${n},${e});
  way["razed:highway"](${s},${w},${n},${e});
);
out geom;`;

let osmRequests = 0, osmRetries = 0, usfsRequests = 0, usfsRetries = 0, osmBytes = 0, osmGaveUp = 0;

let mirror = 0;    // sticky: once a mirror answers, stay on it rather than round-robining
let mirrors = OVERPASS_MIRRORS;

/* Probe the mirrors once at startup and drop the ones that do not answer, KEEPING THE DECLARED
   ORDER. The first statewide run spent its time cycling onto an endpoint that had stopped resolving
   at all, so probing is worth three requests. But do not reorder by probe latency: /status is a
   static string and answering it quickly says nothing about how long the server will queue a real
   query. Sorting that way put the flaky mirror first and produced tile times between 4 s and 173 s
   with no relation to how much data the tile held. The declared order is a judgement about capacity
   — kumi.systems is explicitly provisioned for heavy use — and that beats a latency measurement of
   the wrong thing. */
export async function pickMirrors(list = OVERPASS_MIRRORS, fetchImpl = fetch) {
  const alive = [];
  for (const url of list) {
    try {
      const r = await fetchImpl(url.replace('/interpreter', '/status'),
        { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
      if (r.ok) { await r.text(); alive.push(url); }
    } catch { /* unreachable; leave it out */ }
  }
  return alive;
}

/* One request, retried across mirrors. Fails rather than persisting forever, because the caller's
   answer to a persistent failure is to ask for a smaller area, not to keep asking for the same one. */
async function overpassOnce(s, w, n, e) {
  let lastErr = '';
  for (let a = 0; a < MIRROR_TRIES; a++) {
    const url = mirrors[mirror % mirrors.length];
    try {
      const r = await fetch(url, {
        method: 'POST', body: 'data=' + encodeURIComponent(overpassQuery(s, w, n, e)),
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
        signal: AbortSignal.timeout(REQ_TIMEOUT),
      });
      if (!r.ok) { await r.text().catch(() => {}); throw new Error('HTTP ' + r.status); }
      const text = await r.text();
      osmRequests++; osmBytes += text.length;
      return JSON.parse(text);
    } catch (err) {
      lastErr = (err.cause && err.cause.code) || err.message || err.name;
      osmRetries++;
      // Only move off a mirror after it has failed twice running: a single timeout on the fastest
      // healthy server is not a reason to fall back to a slower one for the rest of the bake.
      const rateLimited = /429/.test(lastErr);
      if (!rateLimited && a >= 1 && mirrors.length > 1) mirror++;
      await sleep(rateLimited ? Math.min(60000, 5000 * Math.pow(1.8, a)) : 2500);
    }
  }
  throw new Error(lastErr);
}

/* Ask for an area; if the servers cannot answer, ask for quarters of it instead.
 *
 * Overpass fails on an expensive query with a 504 rather than a partial answer, and "expensive"
 * tracks way density, so the Puget and Portland metro tiles fail on every mirror while a forest tile
 * answers in two seconds. Subdividing adapts to that automatically — a dense tile ends up as sixteen
 * cheap queries and a forest tile stays one — which is better than hard-coding a list of cities or
 * dropping the urban classes from the query and losing real access data with them.
 *
 * Ways are handed to a callback as each piece arrives rather than accumulated, so a metro area does
 * not have to fit in memory all at once. A way spanning a split line is returned by both halves; the
 * distance stamp is a min, so seeing it twice costs a little time and changes no answer. */
async function forEachWay(s, w, n, e, cb, depth = 0) {
  let j = null;
  try { j = await overpassOnce(s, w, n, e); }
  catch (err) {
    if (depth >= MAX_SPLIT_DEPTH) { log('    giving up on ' + bboxStr(s, w, n, e) + ': ' + err.message); osmGaveUp++; return; }
    const mLat = (s + n) / 2, mLon = (w + e) / 2;
    if (depth === 0) log('    ' + err.message + ' — splitting ' + bboxStr(s, w, n, e) + ' into quarters');
    for (const [qs, qw, qn, qe] of [[s, w, mLat, mLon], [s, mLon, mLat, e], [mLat, w, n, mLon], [mLat, mLon, n, e]]) {
      await forEachWay(qs, qw, qn, qe, cb, depth + 1);
      await sleep(POLITE_MS);
    }
    return;
  }
  for (const el of (j.elements || [])) if (el.type === 'way' && el.geometry) cb(el);
}
const bboxStr = (s, w, n, e) => s.toFixed(2) + ',' + w.toFixed(2) + ',' + n.toFixed(2) + ',' + e.toFixed(2);

async function arcgis(base, s, w, n, e, extra = '') {
  const u = base + '/query?f=json&where=1%3D1&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326'
    + '&geometry=' + encodeURIComponent([w, s, e, n].join(','))
    + '&spatialRel=esriSpatialRelIntersects&returnGeometry=true&outFields=' + (extra || 'objectid');
  let lastErr = '';
  for (let a = 0; a < ATTEMPTS; a++) {
    try {
      const r = await fetch(u, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(REQ_TIMEOUT) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 120));
      usfsRequests++;
      return j;
    } catch (err) {
      lastErr = (err.cause && err.cause.code) || err.message || err.name;
      usfsRetries++;
      if (a === ATTEMPTS - 1) { log('    USFS gave up: ' + lastErr); return { features: [] }; }
      await sleep(Math.min(30000, 3000 * (a + 1)));
    }
  }
}

/* ===================== the bake ===================== */
export function parseArgs(argv) {
  const o = { region: 'state', bbox: null, out: 'data/access.json', cells: 'data/cells.json',
              checkpoint: null, resume: false, dryRun: false, skipUsfs: false };
  for (const a of argv) {
    let m;
    if ((m = /^--region=(.+)$/.exec(a))) o.region = m[1];
    else if ((m = /^--bbox=(.+)$/.exec(a))) {
      const v = m[1].split(',').map(Number);
      if (v.length !== 4 || v.some(isNaN)) throw new Error('--bbox needs lat0,lon0,lat1,lon1');
      o.bbox = { lat0: Math.min(v[0], v[2]), lat1: Math.max(v[0], v[2]),
                 lon0: Math.min(v[1], v[3]), lon1: Math.max(v[1], v[3]) };
    }
    else if ((m = /^--out=(.+)$/.exec(a))) o.out = m[1];
    else if ((m = /^--cells=(.+)$/.exec(a))) o.cells = m[1];
    else if ((m = /^--checkpoint=(.+)$/.exec(a))) o.checkpoint = m[1];
    else if (a === '--resume') o.resume = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--skip-usfs') o.skipUsfs = true;
    else throw new Error('unknown argument ' + a);
  }
  if (!o.bbox) {
    if (!REGIONS[o.region]) throw new Error('unknown region "' + o.region + '" - one of: ' + Object.keys(REGIONS).join(', '));
    o.bbox = REGIONS[o.region];
  } else o.region = 'bbox';
  o.checkpoint = o.checkpoint || o.out + '.checkpoint.json';
  return o;
}

const inBbox = (lat, lon, b) => lat >= b.lat0 && lat <= b.lat1 && lon >= b.lon0 && lon <= b.lon1;

/* Tiles are cut to the cells they actually contain, not to the lattice. The habitat gate leaves the
   Puget metro represented only by its forested fringes, so querying the cells' own bounding box
   instead of the whole tile is the difference between downloading downtown Seattle and not. */
export function tilesFor(cells, bbox) {
  const byTile = new Map();
  for (const c of cells) {
    if (!inBbox(c.lat, c.lon, bbox)) continue;
    const k = Math.floor(c.lat / TILE) + ':' + Math.floor(c.lon / TILE);
    let t = byTile.get(k);
    if (!t) byTile.set(k, t = { k, s: c.lat, n: c.lat, w: c.lon, e: c.lon, n_cells: 0 });
    t.s = Math.min(t.s, c.lat); t.n = Math.max(t.n, c.lat);
    t.w = Math.min(t.w, c.lon); t.e = Math.max(t.e, c.lon);
    t.n_cells++;
  }
  return [...byTile.values()]
    .map(t => ({ ...t, s: t.s - PAD, n: t.n + PAD, w: t.w - PAD, e: t.e + PAD }))
    .sort((a, b) => a.s - b.s || a.w - b.w);
}

function atomicWrite(file, body, opts) {
  const fatal = !opts || opts.fatal !== false;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = file + '.tmp';
  for (let a = 0; a < 4; a++) {
    try { fs.writeFileSync(tmp, body); fs.renameSync(tmp, file); return true; }
    catch (err) {
      if (a === 3) { if (fatal) throw err; console.warn('  checkpoint write failed: ' + (err.code || err.message)); return false; }
    }
  }
}

export async function build(opts, deps = {}) {
  const t0 = Date.now();
  const fetchOsm = deps.overpass || forEachWay;
  const fetchArc = deps.arcgis || arcgis;

  if (!deps.overpass) {
    mirrors = await pickMirrors();
    if (!mirrors.length) throw new Error('no Overpass mirror answered — check connectivity');
    log('  Overpass mirrors up: ' + mirrors.map(u => new URL(u).host).join(', '));
  }
  const cellsFile = JSON.parse(fs.readFileSync(opts.cells, 'utf8'));
  const cells = cellsFile.rows.map(r => ({ lat: r[0], lon: r[1] }));
  log('build-access ' + GENERATOR_VERSION + ' - region ' + opts.region + ', ' + cells.length.toLocaleString() + ' cells');

  // dist: cellKey -> { c:[lat,lon], road, trail, rough }  (-1 = nothing found within CAP)
  const dist = new Map();
  for (const c of cells) {
    const [i, j] = cellIndex(c.lat, c.lon);
    dist.set(i + ':' + j, { c: [c.lat, c.lon], i, j, road: -1, trail: -1, rough: -1 });
  }

  const tiles = tilesFor(cells, opts.bbox);
  log('  ' + tiles.length + ' tiles to query (cut to the cells they contain, padded ' + (PAD * 111).toFixed(1) + ' km)');

  /* Tiles are fetched by a small pool rather than one at a time. The work is entirely I/O — a tile
     takes 8 s or 180 s depending on how busy the server is, not on how much data it holds — so
     serialising it wasted hours waiting. Four is deliberate restraint: enough to hide the latency,
     few enough to stay a well-behaved client of a free service. Stamping is synchronous, so the
     shared distance map needs no locking; only the fetches overlap.

     The checkpoint records WHICH tiles finished, not how many, because with a pool they finish out
     of order and a count would silently skip the stragglers on resume. */
  const doneTiles = new Set();
  let ck = null;
  if (opts.resume && fs.existsSync(opts.checkpoint)) {
    ck = JSON.parse(fs.readFileSync(opts.checkpoint, 'utf8'));
    if (ck.generator_version === GENERATOR_VERSION && ck.region === opts.region) {
      for (const [k, v] of Object.entries(ck.dist)) {
        const cell = dist.get(k);
        if (cell) { cell.road = v[0]; cell.trail = v[1]; cell.rough = v[2]; }
      }
      for (const k of (ck.doneTiles || [])) doneTiles.add(k);
      log('  resuming with ' + doneTiles.size + ' tiles already done');
    } else { log('  checkpoint is from a different run — ignoring'); ck = null; }
  }

  const saveCk = () => atomicWrite(opts.checkpoint, JSON.stringify({
    generator_version: GENERATOR_VERSION, region: opts.region, doneTiles: [...doneTiles],
    dist: Object.fromEntries([...dist].map(([k, v]) => [k, [rnd(v.road), rnd(v.trail), rnd(v.rough)]])),
  }), { fatal: false });

  const pending = tiles.filter(t => !doneTiles.has(t.k));
  const queue = pending.slice();
  let finished = 0, sinceWrite = 0;

  async function worker() {
    while (queue.length) {
      const t = queue.shift();
      let ways = 0, feats = 0;

      await fetchOsm(t.s, t.w, t.n, t.e, el => {
        const cat = osmCategory(el.tags);
        if (!cat) return;
        stampWay(dist, el.geometry.map(p => [p.lat, p.lon]), cat);
        ways++;
      });

      if (!opts.skipUsfs) {
        // Three independent endpoints on a fast server; no reason to wait for each in turn.
        const [roads, closed, trails] = await Promise.all([
          // NFS roads: maintenance level splits drivable from high-clearance and closed.
          fetchArc(USFS_ROADS + '/0', t.s, t.w, t.n, t.e, 'objectid,oper_maint_level'),
          // Layer 1 is roads closed to motorized use — decommissioned spurs, still walkable.
          fetchArc(USFS_ROADS + '/1', t.s, t.w, t.n, t.e, 'objectid'),
          fetchArc(USFS_TRAILS, t.s, t.w, t.n, t.e, 'objectid'),
        ]);
        for (const f of (roads.features || [])) {
          const ml = String(f.attributes?.oper_maint_level || '');
          const cat = USFS_DRIVABLE_ML.test(ml) ? 'road' : 'rough';
          for (const pth of (f.geometry?.paths || [])) { stampWay(dist, pth.map(p => [p[1], p[0]]), cat); feats++; }
        }
        for (const f of (closed.features || [])) {
          for (const pth of (f.geometry?.paths || [])) { stampWay(dist, pth.map(p => [p[1], p[0]]), 'rough'); feats++; }
        }
        for (const f of (trails.features || [])) {
          for (const pth of (f.geometry?.paths || [])) { stampWay(dist, pth.map(p => [p[1], p[0]]), 'trail'); feats++; }
        }
      }

      doneTiles.add(t.k);
      finished++;
      const secs = Math.round((Date.now() - t0) / 1000);
      const eta = finished ? Math.round(secs / finished * (pending.length - finished) / 60) : 0;
      log('  tile ' + finished + '/' + pending.length + '  ' + t.n_cells + ' cells, ' + ways
        + ' OSM ways, ' + feats + ' USFS features  (' + secs + 's, ~' + eta + ' min left)');
      if (++sinceWrite >= CHECKPOINT_EVERY) { sinceWrite = 0; saveCk(); }
      if (queue.length) await sleep(POLITE_MS);
    }
  }
  await Promise.all(Array.from({ length: Math.min(TILE_WORKERS, Math.max(1, queue.length)) }, worker));
  saveCk();

  const rows = [...dist.values()]
    .filter(v => inBbox(v.c[0], v.c[1], opts.bbox))
    .map(v => [v.i, v.j, rnd(v.road), rnd(v.trail), rnd(v.rough)])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  let out = {
    version: 1,
    generated: new Date().toISOString(),
    cap_m: CAP,
    provenance: {
      generator: GENERATOR, generator_version: GENERATOR_VERSION,
      region: opts.region, bbox: opts.bbox,
      sources: SOURCES, tiles: tiles.length,
      cells_generated: cellsFile.generated,
      requests: { overpass: osmRequests, overpass_retries: osmRetries, overpass_mb: +(osmBytes / 1e6).toFixed(1),
                  usfs: usfsRequests, usfs_retries: usfsRetries, areas_abandoned: osmGaveUp },
      seconds: Math.round((Date.now() - t0) / 1000),
      counts: { cells: rows.length },
    },
    rows,
  };

  if (opts.region !== 'state' && fs.existsSync(opts.out)) {
    const prev = JSON.parse(fs.readFileSync(opts.out, 'utf8'));
    out = mergeInto(prev, out);
    log('merge      ' + out.provenance.counts.replaced.toLocaleString() + ' rebaked, '
      + out.provenance.counts.carried_over.toLocaleString() + ' carried over');
  }

  if (opts.dryRun) log('dry run - not writing');
  else {
    atomicWrite(opts.out, JSON.stringify(out));
    log('wrote ' + opts.out + ' - ' + out.rows.length.toLocaleString() + ' cells, '
      + (fs.statSync(opts.out).size / 1e6).toFixed(2) + ' MB');
    if (fs.existsSync(opts.checkpoint)) fs.unlinkSync(opts.checkpoint);
  }
  log('done in ' + Math.round((Date.now() - t0) / 1000) + 's - ' + osmRequests + ' Overpass requests ('
    + osmRetries + ' retries, ' + (osmBytes / 1e6).toFixed(0) + ' MB), ' + usfsRequests + ' USFS requests'
    + (osmGaveUp ? ', ' + osmGaveUp + ' areas abandoned' : ''));
  return out;
}

const rnd = v => v < 0 ? -1 : Math.round(v);

export function mergeInto(prev, fresh) {
  const mine = new Set(fresh.rows.map(r => r[0] + ':' + r[1]));
  const carried = prev.rows.filter(r => !mine.has(r[0] + ':' + r[1]));
  const rows = [...carried, ...fresh.rows].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { ...fresh, rows,
    provenance: { ...fresh.provenance,
      counts: { cells: rows.length, replaced: fresh.rows.length, carried_over: carried.length } } };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  build(parseArgs(process.argv.slice(2))).catch(err => { console.error(err); process.exit(1); });
}
