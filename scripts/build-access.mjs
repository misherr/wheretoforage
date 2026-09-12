#!/usr/bin/env node
/* Bake data/access.json: which way is mapped into each cell, what kind, how far, and enough
 * geometry to draw the approach.
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
 *     level that separates passenger-car roads from high-clearance and closed ones, plus a whole
 *     layer of roads closed to motorized use, and the NFS trails layer with names and numbers.
 *
 * Geometry is shared by way rather than duplicated per cell, which is the difference between an 8 MB
 * file and a 47 MB one — both measured, see docs/access.md. Stored geometry is simplified,
 * delta-encoded, and clipped to the stretch that is actually near a cell.
 *
 *   node scripts/build-access.mjs                     # the whole state
 *   node scripts/build-access.mjs --region=coast      # merged into the existing file
 *   node scripts/build-access.mjs --resume            # continue after a timeout
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cellIndex } from '../src/grid.mjs';
import { osmCategory, osmType, osmPaved, osmRoughReason, LIMITED_ACCESS, USFS_DRIVABLE_ML, CAP, CATS, encodeGeom,
         ROW_STRIDE, ACCESS_FORMAT,
         OSM_DRIVE, OSM_TRAIL, OSM_ROUGH, OSM_PAVED, carRestriction, blocksCars, CAR_BARRIERS, ROW_WIDTH,
         TRAILHEAD_NONE, TRAILHEAD_MAPPED, TRAILHEAD_INFERRED } from '../src/access.mjs';
import { REGIONS, decodePNG, terrariumMetres, tileXY, TERRAIN_SOURCE } from './build-cells.mjs';
import { computeModes, routesFile, modeColumns, mergeRoutes } from './access-modes.mjs';

export const GENERATOR = 'scripts/build-access.mjs';
export const GENERATOR_VERSION = '7.0.0';
/* What a checkpoint holds, which is not the same question as which generator wrote it. Schema 2 keeps
   what the sources SAY — USFS maintenance level and trail_type, one way per USFS path, the OSM tags
   that describe a road — and nothing the rules derive, because the rules now run at assembly. A
   schema-1 checkpoint is upgraded on --resume rather than refused; refusing it would mean hours of
   Overpass to change a rule that only assembly reads. */
/* Schema 3 adds what a car needs to know: barriers ON roads, and on every OSM way the tags that close it
   to the public by car (ac) or say it is paved (pv) — schema 2 kept pv only for USFS twins. */
export const CHECKPOINT_SCHEMA = 3;

const UA = 'king-bolete-forecast/1.0 (github.com/misherr/wheretoforage)';

/* Several Overpass mirrors, probed once at startup. One going away mid-bake is the normal case
   rather than the exceptional one: the main instance stopped answering entirely partway through the
   first statewide run — a connect timeout, not a 429 — and a single hard-coded endpoint turns that
   into a dead job rather than a slower one. OVERPASS_URL overrides the list. */
export const OVERPASS_MIRRORS = process.env.OVERPASS_URL ? [process.env.OVERPASS_URL] : [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  /* Added after a statewide run stalled with all three of the above unusable at once: two would not
     accept a connection and the third answered /status in 16 s and then timed out at 90 s on a
     six-way query. This one answered the identical query in 1.8 s. Three mirrors was not enough
     redundancy — the whole set can be down together. */
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const USFS_ROADS = 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RoadBasic_01/MapServer';
const USFS_TRAILS = 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0';

const TILE = 0.25;            // degrees
const PAD = 0.025;            // ~2.5 km, so a way just outside a tile still reaches cells inside it
const STEP_M = 40;            // polyline densification; a cell is ~1600 m across
const SIMPLIFY_M = 25;        // Douglas-Peucker tolerance for STORED geometry; ~2 px at zoom 14
const JOIN_SNAP_M = 40;       // two segments of one named route whose ends are this close are one way
const ELEV_Z = 10;            // same Terrarium zoom the cell bake uses, so the tiles are shared
const TH_SNAP_M = 60;         // a trail end this close to a drivable road counts as a trailhead
const TH_MAPPED_M = 150;      // a mapped trailhead node this close to a way belongs to it
const USFS_PAGE = 1000;       // USFS records per page; a 2,000-record trails page failed server-side
const TWIN_STEP_M = 25;       // sampling step when measuring how far two ways run together
const TWIN_TOL_M = 20;        // copies of one road sit a median 7 m apart, before 25 m simplification
const TWIN_MIN_M = 150;       // ...and must run together at least this far to be one road
const MIRROR_TRIES = 3;       // per area, across mirrors, before asking for a smaller area instead
const MAX_SPLIT_DEPTH = 4;    // a 0.3 deg tile can become 256 pieces; metro tiles need about 16
const ATTEMPTS = 6;           // USFS only — its endpoints are stable and do not need subdividing
const PROBE_TIMEOUT = 45000;  // a mirror that cannot answer a six-way query in 45 s is not usable for a tile
const REQ_TIMEOUT = 180000;
const POLITE_MS = Number(process.env.OVERPASS_PAUSE || 1200);
const TILE_WORKERS = Number(process.env.ACCESS_WORKERS || 4);
const CHECKPOINT_EVERY = Number(process.env.CHECKPOINT_EVERY || 5);

export const SOURCES = {
  osm: { name: 'OpenStreetMap via Overpass', endpoint: OVERPASS_MIRRORS[0], licence: 'ODbL' },
  usfs_roads: { name: 'USFS National Forest System Roads (EDW)', endpoint: USFS_ROADS },
  usfs_trails: { name: 'USFS National Forest System Trails (EDW)', endpoint: USFS_TRAILS },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/* ===================== geometry ===================== */
const M_LAT = 111320;
const mLon = lat => 111320 * Math.cos(lat * Math.PI / 180);

/* Douglas-Peucker, perpendicular distance in metres. Full geometry is used for the distance
   calculations; only the STORED copy is simplified, so simplification cannot move a cell's class. */
export function simplify(pts, tolM) {
  if (pts.length < 3) return pts.slice();
  const lat0 = pts[0][0], k = mLon(lat0);
  const P = pts.map(([la, lo]) => [lo * k, la * M_LAT]);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    let best = -1, bi = -1;
    const [x0, y0] = P[i0], [x1, y1] = P[i1];
    const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;
    for (let i = i0 + 1; i < i1; i++) {
      const [px, py] = P[i];
      let d;
      if (len2 === 0) d = Math.hypot(px - x0, py - y0);
      else {
        let t = ((px - x0) * dx + (py - y0) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        d = Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
      }
      if (d > best) { best = d; bi = i; }
    }
    if (best > tolM) { keep[bi] = 1; stack.push([i0, bi], [bi, i1]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/* The clip that used to live here is gone.
 *
 * It kept only the stretch of a way between the first and last vertex within 2.6 km of a referencing
 * cell, which truncated a tapped trail wherever cells stopped referencing it. Measured afterwards, it
 * removed 3.7% of points — 621,072 to 598,127 — so it was costing the feature and buying almost
 * nothing. Full geometry is stored for every way a cell references.
 *
 * Joining is what actually fixes a truncated-looking trail. OSM splits a named way at every tag
 * change and junction, so 14% of named routes in Washington arrive as several separate ways — the
 * PCT as 68 of them, US 101 as 71 — and drawing only the segment nearest a cell looks like a
 * fragment of a trail because it is one. Segments of the same name/ref/type whose ends meet are
 * chained into a single way here, so the drawn line, the walk and the climb all describe the route
 * rather than one piece of it. */
/* Arc length at each vertex, so a point partway along a segment becomes a distance along the way —
   which is what a walk from a trailhead actually is. */
function cumulative(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const [aLa, aLn] = pts[i - 1], [bLa, bLn] = pts[i];
    cum.push(cum[i - 1] + Math.hypot((bLn - aLn) * mLon(aLa), (bLa - aLa) * M_LAT));
  }
  return cum;
}

/* Nearest point on a polyline to a coordinate, as {d, arc, pt}. The point matters as much as the
   distance now: it is where the on-trail leg of an approach ends and the off-trail leg begins, and
   both legs have to meet at the same coordinate or the parts will not add up to the total. */
export function nearestOnWay(pts, lat, lon) {
  if (!pts || !pts.length) return { d: Infinity, arc: 0 };
  if (pts.length === 1) {
    return { d: Math.hypot((lon - pts[0][1]) * mLon(pts[0][0]), (lat - pts[0][0]) * M_LAT),
             arc: 0, pt: pts[0] };
  }
  const cum = cumulative(pts);
  let best = Infinity, arc = 0, pt = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const [aLa, aLn] = pts[i - 1], [bLa, bLn] = pts[i];
    const k = mLon(aLa);
    const ax = aLn * k, ay = aLa * M_LAT, bx = bLn * k, by = bLa * M_LAT;
    const px = lon * k, py = lat * M_LAT;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (d < best) {
      best = d; arc = cum[i - 1] + t * Math.sqrt(len2);
      pt = [aLa + (bLa - aLa) * t, aLn + (bLn - aLn) * t];
    }
  }
  return { d: best, arc, pt };
}

/* ===================== the query ===================== */
const KINDS = [...OSM_DRIVE, ...OSM_TRAIL, ...OSM_ROUGH].join('|');
/* Barriers that stop a car are asked for as nodes OF the ways fetched — node(w.ways) — so a gate in a
   field beside a road is never taken for a gate on it. */
export const overpassQuery = (s, w, n, e) => `[out:json][timeout:180];
(
  way["highway"~"^(${KINDS})$"]["area"!="yes"](${s},${w},${n},${e});
  way["highway"="service"]["service"~"^(forestry|forest|logging)$"](${s},${w},${n},${e});
  way["abandoned:highway"](${s},${w},${n},${e});
  way["disused:highway"](${s},${w},${n},${e});
  way["razed:highway"](${s},${w},${n},${e});
)->.ways;
(
  .ways;
  node(w.ways)["barrier"~"${CAR_BARRIERS.source}"];
  node["highway"="trailhead"](${s},${w},${n},${e});
);
out geom;`;

let osmRequests = 0, osmRetries = 0, usfsRequests = 0, usfsRetries = 0, osmBytes = 0, osmGaveUp = 0;
let mirror = 0, mirrors = OVERPASS_MIRRORS;

/* Probe the mirrors once and drop the ones that cannot answer, KEEPING THE DECLARED ORDER. Do not
   reorder by probe latency: sorting that way put the flaky mirror first and produced tile times
   between 8 s and 179 s unrelated to how much data the tile held.

   The probe is a REAL query, not /status. /status is a static string that a queue-saturated server
   still serves: during one stalled run a mirror answered it (in 16 s) and then timed out at 90 s on
   a query returning six ways, so it was kept as "up" while being useless, and the run spent every
   tile paying two long timeouts before rotating off it. A tiny bbox costs one cheap request per
   mirror per run and tests the thing we actually use. It is still a pass/fail liveness gate — the
   survivors keep their declared order and nothing is ranked by how fast it answered. */
const PROBE_QUERY = '[out:json][timeout:25];way["highway"="path"](48.70,-121.62,48.72,-121.60);out ids;';
export async function pickMirrors(list = OVERPASS_MIRRORS, fetchImpl = fetch) {
  const alive = [];
  for (const url of list) {
    try {
      const r = await fetchImpl(url, {
        method: 'POST', body: 'data=' + encodeURIComponent(PROBE_QUERY),
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
        signal: AbortSignal.timeout(PROBE_TIMEOUT),
      });
      if (!r.ok) { await r.text().catch(() => {}); continue; }
      JSON.parse(await r.text());        // a proxy that returns HTML for a query is not a mirror
      alive.push(url);
    } catch { /* unreachable, saturated, or not really an Overpass endpoint; leave it out */ }
  }
  return alive;
}

export async function overpassRaw(query, timeoutMs = REQ_TIMEOUT) {
  let lastErr = '';
  for (let a = 0; a < MIRROR_TRIES; a++) {
    const url = mirrors[mirror % mirrors.length];
    try {
      const r = await fetch(url, {
        method: 'POST', body: 'data=' + encodeURIComponent(query),
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) { await r.text().catch(() => {}); throw new Error('HTTP ' + r.status); }
      const text = await r.text();
      osmRequests++; osmBytes += text.length;
      return JSON.parse(text);
    } catch (err) {
      lastErr = (err.cause && err.cause.code) || err.message || err.name;
      osmRetries++;
      // Only move off a mirror after it has failed twice running.
      const rateLimited = /429/.test(lastErr);
      if (!rateLimited && a >= 1 && mirrors.length > 1) mirror++;
      await sleep(rateLimited ? Math.min(60000, 5000 * Math.pow(1.8, a)) : 2500);
    }
  }
  throw new Error(lastErr);
}
const overpassOnce = (s, w, n, e) => overpassRaw(overpassQuery(s, w, n, e));

const bboxStr = (s, w, n, e) => s.toFixed(2) + ',' + w.toFixed(2) + ',' + n.toFixed(2) + ',' + e.toFixed(2);

/* Ask for an area; if the servers cannot answer, ask for quarters of it instead.
 *
 * Overpass fails an over-expensive query with a 504 rather than a partial answer, and "expensive"
 * tracks way density, so metro tiles fail on every mirror while a forest tile answers in two
 * seconds. Subdividing adapts automatically, which beats hard-coding a list of cities or dropping
 * the urban classes and losing real access data with them.
 *
 * Elements are handed to a callback as each piece arrives rather than accumulated, so a metro area
 * never has to fit in memory at once. A way spanning a split line comes back from both halves; the
 * result is a per-cell minimum, so seeing it twice costs a little time and changes no answer. */
async function forEachElement(s, w, n, e, cb, depth = 0) {
  let j = null;
  try { j = await overpassOnce(s, w, n, e); }
  catch (err) {
    if (depth >= MAX_SPLIT_DEPTH) { log('    giving up on ' + bboxStr(s, w, n, e) + ': ' + err.message); osmGaveUp++; return; }
    const mLat = (s + n) / 2, mLo = (w + e) / 2;
    if (depth === 0) log('    ' + err.message + ' — splitting ' + bboxStr(s, w, n, e) + ' into quarters');
    for (const q of [[s, w, mLat, mLo], [s, mLo, mLat, e], [mLat, w, n, mLo], [mLat, mLo, n, e]]) {
      await forEachElement(q[0], q[1], q[2], q[3], cb, depth + 1);
      await sleep(POLITE_MS);
    }
    return;
  }
  for (const el of (j.elements || [])) cb(el);
}

async function arcgis(base, s, w, n, e, fields, page) {
  let u = base + '/query?f=json&where=1%3D1&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326'
    + '&geometry=' + encodeURIComponent([w, s, e, n].join(','))
    + '&spatialRel=esriSpatialRelIntersects&returnGeometry=true&outFields=' + fields;
  // Ordered by objectid, so a retried page is the same page.
  if (page) u += '&orderByFields=objectid&resultOffset=' + page.offset + '&resultRecordCount=' + USFS_PAGE;
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
      if (a === ATTEMPTS - 1) {
        if (page && page.fatal) throw new Error('USFS page at offset ' + page.offset + ' of ' + base + ' failed: ' + lastErr);
        log('    USFS gave up: ' + lastErr); return { features: [] };
      }
      await sleep(Math.min(30000, 3000 * (a + 1)));
    }
  }
}

/* ===================== enumeration ===================== */
export function parseArgs(argv) {
  const o = { region: 'state', bbox: null, out: 'data/access.json', cells: 'data/cells.json',
              checkpoint: null, resume: false, dryRun: false, skipUsfs: false, skipElevation: false, skipModes: false };
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
    else if (a === '--skip-elevation') o.skipElevation = true;
    else if (a === '--skip-modes') o.skipModes = true;
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

/* Tiles are cut to the cells they actually contain. The habitat gate leaves the Puget metro
   represented only by its forested fringes, so querying the cells' own bounding box instead of the
   whole tile is the difference between downloading downtown Seattle and not. */
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

/* ===================== stamping ===================== */

/* Walk a way, recording for every nearby cell how far it is, WHICH way it was, and how far along
   that way the nearest point sits. The arc position is what makes a walk-from-trailhead figure
   possible later — without it the only answer available is a straight line, which is not what
   determines the walk.

   Densification is not decoration: a single long segment between two distant vertices would skip
   straight past a cell it runs through, and that cell would read as unknown while a highway crosses
   the middle of it. */
export function stampWay(state, coords, cat, wid) {
  if (!coords || coords.length === 0) return;
  const { cells, nearest } = state;
  const visit = (lat, lon, arc) => {
    const dLat = CAP / M_LAT, dLon = CAP / mLon(lat);
    const [i0, j0] = cellIndex(lat - dLat, lon - dLon);
    const [i1, j1] = cellIndex(lat + dLat, lon + dLon);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = i + ':' + j;
      const c = cells.get(k);
      if (!c) continue;
      const dy = (lat - c[0]) * M_LAT, dx = (lon - c[1]) * mLon(c[0]);
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > CAP) continue;
      let rec = nearest.get(k);
      if (!rec) nearest.set(k, rec = {});
      const cur = rec[cat];
      if (!cur || d < cur.d) rec[cat] = { d, wid, arc };
    }
  };
  let arc = 0;
  visit(coords[0][0], coords[0][1], 0);
  for (let n = 1; n < coords.length; n++) {
    const [aLa, aLn] = coords[n - 1], [bLa, bLn] = coords[n];
    const seg = Math.hypot((bLn - aLn) * mLon(aLa), (bLa - aLa) * M_LAT);
    const steps = Math.max(1, Math.ceil(seg / STEP_M));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      visit(aLa + (bLa - aLa) * t, aLn + (bLn - aLn) * t, arc + t * seg);
    }
    arc += seg;
  }
}

/* ===================== joining fragmented routes =====================

   Chain segments of one named route end to end. Only unambiguous chains are joined: if an endpoint
   matches more than one other segment the route branches (a highway through a junction, a trail
   network) and the pieces are left alone, because guessing a path through a fork would invent a
   route nobody can walk. */
export function joinRoutes(entries, snapM = JOIN_SNAP_M) {
  const dist = (a, b) => Math.hypot((a[1] - b[1]) * mLon(a[0]), (a[0] - b[0]) * M_LAT);
  const out = [];
  const groups = new Map();
  for (const e of entries) {
    if (!e.name && !e.ref) { out.push(e); continue; }        // nothing to group an unnamed way by
    const key = e.cat + '|' + e.type + '|' + (e.name || '') + '|' + (e.ref || '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  for (const [, list] of groups) {
    if (list.length === 1) { out.push(list[0]); continue; }

    /* Endpoint DEGREE decides what may be chained, computed once over the whole group.
       Consuming segments as we go and then asking "is there exactly one match left?" is not the same
       question: at a three-way junction the first seed correctly refuses to join, but by the time the
       second seed looks, the first is already marked used and the fork looks unambiguous. Degree is a
       property of the group, not of how far the loop has got. A point where exactly two segment ends
       meet is a join; three or more is a junction and the pieces stay separate. */
    const ends = list.flatMap((e, k) => [
      { k, at: 0, pt: e.geom[0] },
      { k, at: 1, pt: e.geom[e.geom.length - 1] },
    ]);
    const degree = pt => ends.filter(x => dist(x.pt, pt) <= snapM).length;
    const matchAt = (pt, exclude) => {
      const hits = ends.filter(x => !exclude.has(x.k) && dist(x.pt, pt) <= snapM);
      return hits.length === 1 ? hits[0] : null;
    };

    const used = new Set();
    for (let i = 0; i < list.length; i++) {
      if (used.has(i)) continue;
      used.add(i);
      let chain = list[i].geom.slice();
      const members = [list[i]];
      let grew = true;
      while (grew) {
        grew = false;
        for (const end of ['tail', 'head']) {
          const pt = end === 'tail' ? chain[chain.length - 1] : chain[0];
          if (degree(pt) !== 2) continue;              // a junction, or a dead end
          const hit = matchAt(pt, new Set(members.map(m => list.indexOf(m))));
          if (!hit) continue;
          const seg = list[hit.k];
          /* The incoming segment has to run INTO the join, whichever end of the chain we are at:
             appending at the tail needs a segment that starts at the point, prepending at the head
             needs one that ends there. Reversing on hit.at alone is right for one case and backwards
             for the other, which silently produced a chain with a doubled point and a lost segment. */
          const flip = end === 'tail' ? hit.at === 1 : hit.at === 0;
          const g = flip ? seg.geom.slice().reverse() : seg.geom.slice();
          if (end === 'tail') chain = chain.concat(g.slice(1));
          else chain = g.slice(0, -1).concat(chain);
          used.add(hit.k); members.push(seg); grew = true;
          break;
        }
      }
      /* Keep the strongest trailhead found on any member, its POINT, and the longest constituent
         OSM id. Carrying the point is what makes the walk right on a joined route: the trailhead can
         be on any member and at either of its ends, and the chain may have reversed that member on
         the way in. A flag cannot express that; a coordinate projected back onto the finished chain
         can. */
      const th = members.reduce((a, m) => Math.max(a, m.th), TRAILHEAD_NONE);
      const thMember = members.filter(m => m.th === th && m.thPt)
                              .sort((a, b) => b.geom.length - a.geom.length)[0];
      const osm = members.filter(m => m.osmId).sort((a, b) => b.geom.length - a.geom.length)[0];
      out.push({ ...list[i], geom: chain, th, thPt: thMember ? thMember.thPt : null,
                 segments: members.length, osmId: osm ? osm.osmId : null });
    }
  }
  return out;
}

/* ===================== elevation along a way =====================

   Sampled from the same Terrarium tiles the cell bake reads, at every vertex of the stored geometry.
   Cumulative POSITIVE difference, not the difference between endpoints: a rolling approach that
   climbs 300 m in four rises and drops most of it again is a 300 m climb to walk, and endpoint
   subtraction would call it flat. */
const tileCache = new Map();
let elevTiles = 0, elevTileFails = 0;

async function terrainTile(z, x, y, loader) {
  const k = z + '/' + x + '/' + y;
  if (tileCache.has(k)) return tileCache.get(k);
  const p = (async () => {
    const url = TERRAIN_SOURCE.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    for (let a = 0; a < 5; a++) {
      try {
        const r = await (loader || fetch)(url, { signal: AbortSignal.timeout(REQ_TIMEOUT) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        elevTiles++;
        return decodePNG(Buffer.from(await r.arrayBuffer()));
      } catch { await sleep(1200 * (a + 1)); }
    }
    elevTileFails++;
    return null;
  })();
  tileCache.set(k, p);
  return p;
}

export async function elevationProfile(geom, loader) {
  const out = new Array(geom.length).fill(null);
  const byTile = new Map();
  geom.forEach(([la, ln], i) => {
    const t = tileXY(la, ln, ELEV_Z), tx = Math.floor(t.x), ty = Math.floor(t.y);
    const k = tx + ',' + ty;
    if (!byTile.has(k)) byTile.set(k, { tx, ty, pts: [] });
    byTile.get(k).pts.push({ i, px: Math.min(255, Math.floor((t.x - tx) * 256)),
                                py: Math.min(255, Math.floor((t.y - ty) * 256)) });
  });
  for (const t of byTile.values()) {
    const img = await terrainTile(ELEV_Z, t.tx, t.ty, loader);
    if (!img) continue;
    for (const q of t.pts) {
      const at = (q.py * img.width + q.px) * img.channels;
      out[q.i] = terrariumMetres(img.data[at], img.data[at + 1], img.data[at + 2]);
    }
  }
  return out;
}

/* ===================== the DEM is not clean, and cumulative gain amplifies that =====================

   Cumulative positive difference is the right measure for a rolling approach and the wrong measure
   for noisy data: every spurious upward step is added and none is ever subtracted back out.

   The Terrarium tiles contain patches of garbage. On tile 10/164/363, in the Mount St Helens blast
   zone, five adjacent pixels read 618, 101, 1295, 2820, 3087 where the terrain is around 900 m. That
   is not a decoding error — the browser's own PNG decoder returns the identical bytes, which is how
   it was ruled out — it is what the source data says. One such pixel pair contributed 2,719 m of the
   4,608 m total on USFS trail 211, 59% of the figure, and it would have been shown as "15,100 ft of
   climb" on a 12 mi trail.

   Two filters, in order:

   1. A three-point MEDIAN over the profile. These artefacts are isolated single pixels, and a median
      removes an isolated spike of any magnitude while leaving a genuine slope untouched — the median
      of three monotone samples is the middle one.
   2. A gradient gate as a backstop for two bad pixels in a row, which a 3-median cannot fix. The
      threshold is a physical one rather than a tuned one: over 4,159 steps sampled from 333 real
      routes the steepest implied gradient was 141%, and 300% is 72 degrees — not walkable ground and
      not a real DEM slope, so a step that implies it is bad data. The step is skipped rather than
      clamped, so a spike neither adds climb on the way up nor a spurious rise on the way back down.

   Both under-count across a bad patch instead of inventing metres, which is the right direction for
   a number presented as the climb to expect. */
export const MAX_GRADE = 3.0;

export function despike(elev) {
  if (!elev || elev.length < 3) return elev;
  const out = elev.slice();
  for (let i = 1; i < elev.length - 1; i++) {
    const a = elev[i - 1], b = elev[i], c = elev[i + 1];
    if (a == null || b == null || c == null) continue;
    out[i] = a < b ? (b < c ? b : (a < c ? c : a)) : (a < c ? a : (b < c ? c : b));   // median of three
  }
  return out;
}

/* The climb on the OFF-TRAIL leg: from the nearest point on the route straight to the cell centre.

   Same method as the on-trail figure — sampled from the same Terrarium tiles at the same zoom, run
   through the same 3-point median, accumulated as positive difference with the same gradient gate —
   because two numbers shown side by side and added together must not be measured two different
   ways. The only difference is the line: this one is a straight segment nobody has walked, which is
   what OFF_TRAIL_NOTE in src/access.mjs exists to say.

   Sampled every OFF_STEP_M so the profile follows the ground rather than jumping between endpoints;
   a 2 km leg is about 20 samples, and at z10 (103 m per pixel) that is roughly one sample per pixel,
   which is as much resolution as the data has. */
export const OFF_STEP_M = 100;

export async function offTrailGain(from, to, loader) {
  if (!from || !to) return -1;
  const dy = (to[0] - from[0]) * M_LAT, dx = (to[1] - from[1]) * mLon(from[0]);
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return 0;                       // the route runs through the cell centre
  const steps = Math.max(1, Math.round(len / OFF_STEP_M));
  const line = [];
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    line.push([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]);
  }
  const elev = despike(await elevationProfile(line, loader));
  return gainBetween(line, elev, 0, len);
}

/* Cumulative climb between two positions along a way, given its per-vertex elevations. */
export function gainBetween(geom, elev, arcA, arcB) {
  if (!elev || elev.length !== geom.length) return -1;
  const lo = Math.min(arcA, arcB), hi = Math.max(arcA, arcB);
  let arc = 0, gain = 0, prev = null, prevArc = 0, any = false;
  for (let i = 0; i < geom.length; i++) {
    if (i > 0) {
      const [aLa, aLn] = geom[i - 1], [bLa, bLn] = geom[i];
      arc += Math.hypot((bLn - aLn) * mLon(aLa), (bLa - aLa) * M_LAT);
    }
    if (arc < lo - 1 || arc > hi + 1) { prev = null; continue; }
    const e = elev[i];
    if (e == null || !Number.isFinite(e)) { prev = null; continue; }
    if (prev != null) {
      const run = arc - prevArc;
      // a step steeper than MAX_GRADE is bad data, not ground: skip it, do not clamp it
      if (run > 1 && Math.abs(e - prev) / run <= MAX_GRADE && e > prev) gain += e - prev;
    }
    prev = e; prevArc = arc; any = true;
  }
  return any ? Math.round(gain) : -1;
}

/* ===================== USFS, fetched by page ===================== */

/* The three USFS layers, paged for the whole region rather than asked for tile by tile: three
   requests per tile across 316 tiles became about 25, and the per-tile version returned a road once
   for every tile it crossed. */
export const USFS_LAYERS = [
  { url: USFS_ROADS + '/0', type: 'nfsr', fields: 'objectid,name,id,oper_maint_level' },
  { url: USFS_ROADS + '/1', type: 'nfsr-closed', fields: 'objectid,name,id' },
  { url: USFS_TRAILS, type: 'nfst', fields: 'objectid,trail_name,trail_no,trail_type' },
];

/* One way per PATH, not one per feature.

   An ArcGIS polyline is a list of paths, and an EDW road record is sometimes several disjoint pieces.
   Flattening them into one line, which the bake used to do, drew a straight segment across every gap
   — 383 m at the median in a Cascades sample, up to 6.2 km — and a walk measured along that segment
   crossed ground no road covers. Each piece is its own way now; joinRoutes chains the ones whose ends
   actually meet.

   Kept from the source rather than decided here: the maintenance level (`ml`) and, for trails,
   trail_type (`tt`). What they mean is decided at assembly, so changing a rule needs no re-fetch. */
export function usfsWays(f, type) {
  const a = (f && f.attributes) || {};
  const paths = ((f && f.geometry && f.geometry.paths) || []).filter(p => p && p.length);
  const name = (type === 'nfst' ? a.trail_name : a.name) || null;
  const rawRef = type === 'nfst' ? a.trail_no : a.id;
  const ref = rawRef == null || rawRef === '' ? null : String(rawRef);
  const cat = type === 'nfst' ? 'trail'
    : type === 'nfsr' && USFS_DRIVABLE_ML.test(String(a.oper_maint_level || '')) ? 'road' : 'rough';
  return paths.map((p, k) => {
    const w = { name, ref, type, cat, geom: simplify(p.map(q => [q[1], q[0]]), SIMPLIFY_M), th: TRAILHEAD_NONE };
    if (type === 'nfsr' && a.oper_maint_level) w.ml = String(a.oper_maint_level).charAt(0);
    if (type === 'nfst' && a.trail_type) w.tt = String(a.trail_type);
    return ['u' + type + a.objectid + (paths.length > 1 ? '.' + (k + 1) : ''), w];
  });
}

/* Is a point inside any queried tile's padded box — the area the per-tile fetch used to cover — so
   paging the region's bounding box does not quietly widen the bake into Oregon and British Columbia. */
function tileMembership(tiles) {
  const byKey = new Map(tiles.map(t => [t.k, t]));
  return (lat, lon) => {
    const ti = Math.floor(lat / TILE), tj = Math.floor(lon / TILE);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const t = byKey.get((ti + di) + ':' + (tj + dj));
      if (t && lat >= t.s && lat <= t.n && lon >= t.w && lon <= t.e) return true;
    }
    return false;
  };
}

export async function fetchUsfs(tiles, bbox, fetchArc, ways, logFn = log) {
  const inTiles = tileMembership(tiles);
  const st = { features: 0, kept: 0, multi_path: 0, pieces: 0 };
  const s = bbox.lat0 - PAD, n = bbox.lat1 + PAD, w = bbox.lon0 - PAD, e = bbox.lon1 + PAD;
  for (const L of USFS_LAYERS) {
    let got = 0, kept = 0;
    for (let offset = 0; ; offset += USFS_PAGE) {
      /* A page that fails is fatal, not empty: an empty page would delete up to a thousand roads from
         the bake and still mark the USFS fetch done. */
      const j = await fetchArc(L.url, s, w, n, e, L.fields, { offset, fatal: true });
      const feats = j.features || [];
      for (const f of feats) {
        const paths = (f.geometry && f.geometry.paths) || [];
        if (!paths.some(p => p.some(q => inTiles(q[1], q[0])))) continue;
        const pieces = usfsWays(f, L.type);
        if (pieces.length > 1) st.multi_path++;
        for (const [wid, way] of pieces) { ways.set(wid, way); st.pieces++; }
        kept++;
      }
      got += feats.length;
      if (!j.exceededTransferLimit || !feats.length) break;
    }
    st.features += got; st.kept += kept;
    logFn('  USFS ' + L.type + ': ' + got.toLocaleString() + ' features in the region, '
      + kept.toLocaleString() + ' near the cells');
  }
  return st;
}

/* ===================== geometry for comparing ways ===================== */
const lengthM = g => {
  let L = 0;
  for (let i = 1; i < g.length; i++) L += Math.hypot((g[i][1] - g[i - 1][1]) * mLon(g[i - 1][0]), (g[i][0] - g[i - 1][0]) * M_LAT);
  return L;
};
/* Metres from a point to a segment, in a local projection at the point. */
function segDistM(la, lo, a, b) {
  const k = mLon(la);
  const ax = (a[1] - lo) * k, ay = (a[0] - la) * M_LAT, bx = (b[1] - lo) * k, by = (b[0] - la) * M_LAT;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
function forEachSample(g, stepM, cb) {
  cb(g[0][0], g[0][1]);
  for (let i = 1; i < g.length; i++) {
    const [aLa, aLo] = g[i - 1], [bLa, bLo] = g[i];
    const n = Math.max(1, Math.ceil(Math.hypot((bLo - aLo) * mLon(aLa), (bLa - aLa) * M_LAT) / stepM));
    for (let q = 1; q <= n; q++) cb(aLa + (bLa - aLa) * q / n, aLo + (bLo - aLo) * q / n);
  }
}
/* A grid of ~220 m cells for "what passes near here". A segment is filed under every cell its box,
   padded by the search radius, touches — so a query reads only the one cell its point falls in. */
const GRID_LAT = 0.002, GRID_LON = 0.003;
const gridKey = (i, j) => i * 1e6 + (j + 500000);
const gcell = (lat, lon) => gridKey(Math.floor(lat / GRID_LAT), Math.floor(lon / GRID_LON));
function forCells(a, b, padM, cb) {
  const pLa = padM / M_LAT, pLo = padM / mLon(Math.max(a[0], b[0]));
  const i0 = Math.floor((Math.min(a[0], b[0]) - pLa) / GRID_LAT), i1 = Math.floor((Math.max(a[0], b[0]) + pLa) / GRID_LAT);
  const j0 = Math.floor((Math.min(a[1], b[1]) - pLo) / GRID_LON), j1 = Math.floor((Math.max(a[1], b[1]) + pLo) / GRID_LON);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) cb(gridKey(i, j));
}

/* ===================== one road, two sources ===================== */

/* Which OSM roads and tracks are the same road as a USFS road record.

   Where both sources map a forest road the bake kept both, each with its own category, and they
   disagree often: 1,018 OSM roads classed drivable run alongside a USFS record at maintenance level 2
   ("high clearance vehicles"), and 274 OSM tracks alongside a level-3 road ("suitable for passenger
   cars"), a median 7 m apart. A cell then read "drivable road mapped" off the OSM copy while its rough
   entry was the same road — 949 cells had exactly that.

   Twins run within TWIN_TOL_M of each other for at least TWIN_MIN_M and for at least half the shorter
   of the two, which is the test that separated a road mapped twice from two roads that meet or cross.
   An OSM piece of 100 m or more lying 80% along a USFS road is a twin too, so a road split at every
   junction does not leave its short pieces on the other source's category. Measured on the STORED
   geometry, simplified to 25 m — which is why the tolerance is 20 m, not the 7 m the copies usually
   sit apart. Returns OSM way id -> [{uwid, overlap}], largest overlap first. */
export function findTwins(ways, tolM = TWIN_TOL_M, minM = TWIN_MIN_M) {
  const U = [], grid = new Map();
  for (const [wid, w] of ways) {
    if ((w.type !== 'nfsr' && w.type !== 'nfsr-closed') || !w.geom || w.geom.length < 2) continue;
    const u = U.length;
    U.push({ wid, geom: w.geom, len: lengthM(w.geom) });
    for (let k = 1; k < w.geom.length; k++) forCells(w.geom[k - 1], w.geom[k], tolM, key => {
      let arr = grid.get(key); if (!arr) grid.set(key, arr = []); arr.push(u, k);
    });
  }
  const twins = new Map();
  if (!U.length) return twins;
  for (const [wid, w] of ways) {
    if (wid[0] !== 'o' || (w.cat !== 'road' && w.cat !== 'rough') || !w.geom || w.geom.length < 2) continue;
    const hits = new Map();
    forEachSample(w.geom, TWIN_STEP_M, (la, lo) => {
      const arr = grid.get(gcell(la, lo));
      if (!arr) return;
      let seen = null;
      for (let q = 0; q < arr.length; q += 2) {
        const u = arr[q];
        if (seen && seen.has(u)) continue;
        const g = U[u].geom, k = arr[q + 1];
        if (segDistM(la, lo, g[k - 1], g[k]) <= tolM) {
          (seen || (seen = new Set())).add(u);
          hits.set(u, (hits.get(u) || 0) + 1);
        }
      }
    });
    if (!hits.size) continue;
    const len = lengthM(w.geom), list = [];
    for (const [u, h] of hits) {
      const ov = Math.min(len, h * TWIN_STEP_M);
      if ((ov >= minM && ov >= 0.5 * Math.min(len, U[u].len)) || (len >= 4 * TWIN_STEP_M && ov >= 0.8 * len))
        list.push({ uwid: U[u].wid, overlap: Math.round(ov) });
    }
    if (list.length) twins.set(wid, list.sort((x, y) => y.overlap - x.overlap));
  }
  return twins;
}

/* ===================== the rules, applied at assembly =====================

   Everything the sources SAY is in the checkpoint; what it MEANS is decided here, so a rule can change
   without a re-fetch. Each rule can be switched off through opts.rules — not as a feature, but so its
   effect on the shipped figures can be measured on its own (docs/verification.md). */
export function applyRules(ways, rules = {}) {
  const st = { snow_routes: { ways: 0, km: 0 }, described_rough: {}, usfs: null };
  if (rules.snow !== false) {
    /* Over-snow routes are not trails in the season this app is for. 597 USFS "trails" were
       snowmobile and ski routes, 4,687 km — a quarter of the USFS trail length — one of them along
       SR 20. 1,155 cells said "a trail is mapped" because of one, and 1,105 showed a walk measured
       along it, from a trailhead inferred where it met a road: in practice, a sno-park. */
    for (const [wid, w] of ways) if (w.type === 'nfst' && w.tt === 'SNOW') {
      st.snow_routes.ways++; st.snow_routes.km += lengthM(w.geom) / 1000; ways.delete(wid);
    }
    st.snow_routes.km = Math.round(st.snow_routes.km);
  }
  if (rules.described !== false) {
    /* A tag that describes the road beats one that classifies it: 4wd_only=yes, motor_vehicle=no and
       smoothness=impassable|very_horrible each say a car cannot use it, whatever highway= says.
       osmCategory applies this during a fresh fetch; a schema-1 checkpoint's ways need it here. */
    for (const [, w] of ways) if (w.rd && w.cat === 'road' && !LIMITED_ACCESS.test(w.type)) {
      w.cat = 'rough'; w.catBy = 'described';
      const k = w.rd.replace(/=.*/, '');
      st.described_rough[k] = (st.described_rough[k] || 0) + 1;
    }
  }
  if (rules.usfs !== false) st.usfs = reconcileUsfs(ways);
  return st;
}

/* Where both sources map a road, the USFS maintenance level decides its category.

   The level is the only field in either source that directly answers "passenger car or high
   clearance". OSM's choice between track and unclassified on forest roads is inconsistent — 481
   named roads switch between the two from one mapped piece to the next. Two exceptions, where OSM
   overrides, because those tags describe the road rather than classify it:

     - paved (surface=paved, asphalt, concrete, chipseal) is drivable even at level 1-2. USFS records
       lag: Bogachiel Road is paved in OSM and gravel in USFS. Not over the closed-roads layer, though
       — a paved road can still be gated, and paving says nothing about that.
     - 4wd_only=yes, motor_vehicle=no, or smoothness=impassable|very_horrible is rough even at level
       3+. Where the exceptions collide, rough wins: optimism is the failure this project keeps
       rediscovering.

   The OSM copy keeps its geometry, which is connected to the rest of the network. The USFS copy stays
   too — it carries the road's number and covers whatever OSM lacks — and it takes its twin's category
   only when an exception flipped that twin and the flipped twins cover 80% of it. Otherwise the same
   road would sit in a cell twice again, drivable once and rough once. */
/* A USFS maintenance level describes a forest road. It says nothing about a state or federal highway,
   and it cannot speak for the parts of an OSM way it does not run along. The live check of this rule
   found State Route 410 — highway=primary — demoted to rough because a 337 m level-2 spur ran beside
   7% of a 3.3 km OSM way. Twins are still twins (the USFS copy may still follow an exception), but
   USFS only DECIDES where it covers at least half the OSM way, and never for these classes. */
const USFS_NEVER_DECIDES = /^(motorway|trunk|primary|secondary)(_link)?$/;
const USFS_MIN_COVER = 0.5;

export function reconcileUsfs(ways) {
  const twins = findTwins(ways);
  const st = { osm_ways_with_twin: twins.size, pairs: 0, to_rough: 0, to_road: 0, paved: 0, described: 0,
               conflicting_twins: 0, usfs_adopted: 0, usfs_still_disagreeing: 0,
               kept_highway: 0, kept_partial: 0, ml_carried: 0 };
  for (const [owid, list] of twins) {
    const o = ways.get(owid), top = ways.get(list[0].uwid);
    st.pairs += list.length;
    if (USFS_NEVER_DECIDES.test(o.type)) { st.kept_highway++; continue; }
    if (list[0].overlap < USFS_MIN_COVER * lengthM(o.geom)) { st.kept_partial++; continue; }
    if (new Set(list.map(t => ways.get(t.uwid).cat)).size > 1) st.conflicting_twins++;
    let cat = top.cat, by = 'usfs';
    if (cat === 'rough' && o.pv && top.type === 'nfsr') { cat = 'road'; by = 'paved'; }
    if (o.rd) { cat = 'rough'; by = 'described'; }
    if (by === 'paved') st.paved++;
    if (by === 'described' && top.cat === 'road') st.described++;
    if (o.cat !== cat) { if (cat === 'rough') st.to_rough++; else st.to_road++; }
    o.cat = cat; o.catBy = by; o.twin = list[0].uwid;
    /* The maintenance level comes with the category, because the drive times a road by it and the two
       copies of one road must be driven at one speed. Without this the OSM copy of a graded level-4
       road was timed as unrated gravel, and the drive took whichever copy the network happened to
       join — the same road at two speeds. */
    if (o.ml == null && top.ml != null) { o.ml = top.ml; st.ml_carried++; }
  }
  const byU = new Map();
  for (const [owid, list] of twins) for (const t of list) {
    if (!byU.has(t.uwid)) byU.set(t.uwid, []);
    byU.get(t.uwid).push({ o: ways.get(owid), overlap: t.overlap });
  }
  for (const [uwid, list] of byU) {
    const u = ways.get(uwid);
    const cats = new Set(list.map(x => x.o.cat));
    const byException = list.every(x => x.o.catBy === 'paved' || x.o.catBy === 'described');
    const cover = list.reduce((a, x) => a + x.overlap, 0);
    if (byException && cats.size === 1 && !cats.has(u.cat) && cover >= 0.8 * lengthM(u.geom)) {
      u.cat = [...cats][0]; u.catBy = 'twin'; st.usfs_adopted++;
    } else if (list.some(x => x.o.cat !== u.cat)) st.usfs_still_disagreeing++;
  }
  return st;
}

/* ===================== trailheads, decided after the categories =====================

   A trailhead is inferred where a non-road way ends within TH_SNAP_M of a DRIVABLE road, so it is
   downstream of every rule above. It used to be inferred during the fetch, tile by tile, against
   whatever each source alone called drivable, so a trail ending on an OSM "road" that USFS records
   as high-clearance got a trailhead there: 5,072 of 60,658 inferred trailheads (8.4%) had no other
   drivable road near them. Inferred here, after USFS has decided, such a way gets its trailhead at
   its other end if that end meets a real road, or no trailhead — and then no walk, because a walk
   from where a passenger car cannot go is exactly the optimism the rule exists to stop.

   Otherwise the rule is the one it was: the way's FIRST end is checked before its last, and the
   POINT is recorded, not a flag. A flag once let the walk be measured from whichever end the
   geometry started at — Tyler Peak Trail's arc 0 is 1,971 m from any road — and a point survives
   joinRoutes reversing and reordering members. Mapped trailhead nodes, within TH_MAPPED_M of any
   point on the way, still outrank inferred ones: a surveyed point beats a deduction. */
export function inferTrailheads(ways, trailheadNodes = [], snapM = TH_SNAP_M, mappedM = TH_MAPPED_M) {
  const E = [], ends = new Map();
  for (const [, w] of ways) {
    w.th = TRAILHEAD_NONE; delete w.thPt;
    if (w.cat === 'road' || !w.geom || !w.geom.length) continue;
    const e = { w, pts: [w.geom[0], w.geom[w.geom.length - 1]], hit: [false, false] }, idx = E.length;
    E.push(e);
    for (let k = 0; k < 2; k++) {
      const key = gcell(e.pts[k][0], e.pts[k][1]);
      let arr = ends.get(key); if (!arr) ends.set(key, arr = []); arr.push(idx, k);
    }
  }
  for (const [, w] of ways) {
    if (w.cat !== 'road' || !w.geom || !w.geom.length) continue;
    const g = w.geom;
    for (let k = g.length > 1 ? 1 : 0; k < g.length; k++) {
      const a = g[Math.max(0, k - 1)], b = g[k];
      forCells(a, b, snapM, key => {
        const arr = ends.get(key);
        if (!arr) return;
        for (let q = 0; q < arr.length; q += 2) {
          const e = E[arr[q]], which = arr[q + 1];
          if (!e.hit[which] && segDistM(e.pts[which][0], e.pts[which][1], a, b) <= snapM) e.hit[which] = true;
        }
      });
    }
  }
  let inferred = 0;
  for (const e of E) {
    const k = e.hit[0] ? 0 : e.hit[1] ? 1 : -1;
    if (k < 0) continue;
    e.w.th = TRAILHEAD_INFERRED; e.w.thPt = [e.pts[k][0], e.pts[k][1]]; inferred++;
  }
  /* Mapped nodes: per way, the nearest node within mappedM of any point on it. Ways are filed in a
     0.01-degree grid by their padded bounding box, so each node reads one cell. */
  const C = 0.01, wg = new Map(), best = new Map();
  E.forEach((e, idx) => {
    let s = 90, n = -90, west = 180, east = -180;
    for (const [la, lo] of e.w.geom) { if (la < s) s = la; if (la > n) n = la; if (lo < west) west = lo; if (lo > east) east = lo; }
    const pLa = mappedM / M_LAT, pLo = mappedM / mLon(n);
    for (let i = Math.floor((s - pLa) / C); i <= Math.floor((n + pLa) / C); i++)
      for (let j = Math.floor((west - pLo) / C); j <= Math.floor((east + pLo) / C); j++) {
        const key = gridKey(i, j); let arr = wg.get(key); if (!arr) wg.set(key, arr = []); arr.push(idx);
      }
  });
  for (const [tLa, tLn] of trailheadNodes) {
    for (const idx of wg.get(gridKey(Math.floor(tLa / C), Math.floor(tLn / C))) || []) {
      const d = nearestOnWay(E[idx].w.geom, tLa, tLn).d;
      if (d <= mappedM) { const b = best.get(idx); if (!b || d < b.d) best.set(idx, { d, pt: [tLa, tLn] }); }
    }
  }
  for (const [idx, b] of best) {
    const w = E[idx].w;
    if (w.th === TRAILHEAD_INFERRED) inferred--;
    w.th = TRAILHEAD_MAPPED; w.thPt = b.pt;
  }
  return { inferred, mapped: best.size };
}

/* Every way onto every cell within CAP, after the rules — which is why it happens here now rather than
   during the fetch: a category decided at assembly has to be the category the cell records. Measured on
   the stored geometry, which is also what every distance below is re-projected onto. */
export function stampAll(state, ways) {
  for (const [wid, w] of ways) if (w.geom && w.geom.length) stampWay(state, w.geom, w.cat, wid);
}

/* One-off, for a schema-1 checkpoint: the OSM tags that describe a road, which the old fetch read and
   then threw away. Asked for rather than re-fetched: statewide, only the ways tagged 4wd-only, closed
   to motor vehicles or impassable; and by id, the surface of the OSM roads that have a USFS twin —
   the only roads for which "paved" changes anything. */
async function backfillOsmDescriptors(ways, bbox, query, logFn = log) {
  const st = { described: {}, paved: 0, twins_looked_up: 0, requests: 0 };
  const take = el => {
    const w = ways.get('o' + el.id);
    if (!w) return;
    const rd = osmRoughReason(el.tags);
    if (rd && !w.rd) { w.rd = rd; const k = rd.replace(/=.*/, ''); st.described[k] = (st.described[k] || 0) + 1; }
    if (osmPaved(el.tags) && !w.pv) { w.pv = 1; st.paved++; }
  };
  /* By tag alone. Adding ["highway"~...] made the planner scan every highway in the state and the
     statewide query timed out (504) on every mirror; the tag filters are index-backed and selective, and
     take() already ignores any way the checkpoint does not hold. An area that still fails is split
     into quarters, as the tile fetch does, and one that fails three splits down is fatal — a silent
     gap here would leave some roads drivable that are tagged 4wd-only. */
  const tagQuery = (a, b, c, d) => '[out:json][timeout:300];('
    + ['["4wd_only"="yes"]', '["motor_vehicle"="no"]', '["smoothness"~"^(impassable|very_horrible)$"]']
      .map(f => 'way' + f + '(' + [a, b, c, d].map(v => v.toFixed(3)).join(',') + ');').join('')
    + ');out tags;';
  /* Logged per area, success or split: a statewide query that retries a 504 three times can sit
     silent for fifteen minutes, and silence cannot tell a slow mirror from a wedged one. */
  const box = (a, b, c, d) => [a, b, c, d].map(v => v.toFixed(2)).join(',');
  const area = async (a, b, c, d, depth) => {
    try {
      const els = (await query(tagQuery(a, b, c, d), 330000)).elements || [];
      for (const el of els) take(el);
      st.requests++;
      logFn('upgrade    tags ' + box(a, b, c, d) + ': ' + els.length.toLocaleString() + ' ways');
    } catch (err) {
      if (depth >= 3) throw err;
      logFn('upgrade    tags ' + box(a, b, c, d) + ': ' + err.message + ' — splitting into quarters');
      const mLa = (a + c) / 2, mLo = (b + d) / 2;
      for (const q of [[a, b, mLa, mLo], [a, mLo, mLa, d], [mLa, b, c, mLo], [mLa, mLo, c, d]]) {
        await area(q[0], q[1], q[2], q[3], depth + 1);
        await sleep(POLITE_MS);
      }
    }
  };
  await area(bbox.lat0 - PAD, bbox.lon0 - PAD, bbox.lat1 + PAD, bbox.lon1 + PAD, 0);
  const ids = [...findTwins(ways).keys()].map(wid => wid.slice(1));
  st.twins_looked_up = ids.length;
  logFn('upgrade    surface of the ' + ids.length.toLocaleString() + ' OSM roads with a USFS twin, '
    + Math.ceil(ids.length / 400) + ' requests');
  for (let c = 0; c < ids.length; c += 400) {
    const q = '[out:json][timeout:180];way(id:' + ids.slice(c, c + 400).join(',') + ');out tags;';
    for (const el of ((await query(q)).elements || [])) take(el);
    st.requests++;
    if (c + 400 < ids.length) await sleep(POLITE_MS);
  }
  logFn('upgrade    OSM descriptors: ' + JSON.stringify(st));
  return st;
}

/* Ask Overpass for an area, and for its quarters if it will not answer — the tile fetch's rule, for the
   by-tag queries a checkpoint upgrade makes. Logged per area, success or split: a query retrying a 504
   can sit silent for minutes, and silence cannot tell a slow mirror from a wedged one. */
async function overpassByArea(queryFor, box, onElements, query, logFn, label, depth = 0) {
  const [a, b, c, d] = box;
  const where = box.map(v => v.toFixed(2)).join(',');
  try {
    const els = (await query(queryFor(a, b, c, d), 330000)).elements || [];
    onElements(els);
    logFn('upgrade    ' + label + ' ' + where + ': ' + els.length.toLocaleString());
    return 1;
  } catch (err) {
    if (depth >= 3) throw err;
    logFn('upgrade    ' + label + ' ' + where + ': ' + err.message + ' — splitting into quarters');
    const mLa = (a + c) / 2, mLo = (b + d) / 2;
    let n = 0;
    for (const q of [[a, b, mLa, mLo], [a, mLo, mLa, d], [mLa, b, c, mLo], [mLa, mLo, c, d]]) {
      n += await overpassByArea(queryFor, q, onElements, query, logFn, label, depth + 1);
      await sleep(POLITE_MS);
    }
    return n;
  }
}

/* One-off, for a schema-2 checkpoint: what a car needs, which the fetch did not keep. Barriers that lie
   ON a road (a gate in a field beside one is not asked for); the tags that close a road to the public
   by car; and a paved surface on every way — schema 2 had surface only for USFS twins. By tag,
   statewide: three requests when the mirror is healthy — 67,710, 226,009 and 470,227 elements in the
   first run. */
async function backfillHikeInputs(ways, gateNodes, bbox, query, logFn = log) {
  const bb = (a, b, c, d) => [a, b, c, d].map(v => v.toFixed(3)).join(',');
  const st = { gates: 0, gates_open_to_cars: 0, restricted_ways: 0, paved_ways: 0, requests: 0 };
  const area = [bbox.lat0 - PAD, bbox.lon0 - PAD, bbox.lat1 + PAD, bbox.lon1 + PAD];
  const seen = new Set();
  st.requests += await overpassByArea((a, b, c, d) => '[out:json][timeout:300];node["barrier"~"' + CAR_BARRIERS.source + '"]('
      + bb(a, b, c, d) + ')->.b;way(bn.b)["highway"]->.w;node.b(w.w);out;', area,
    els => { for (const el of els) {
      if (el.type !== 'node' || seen.has(el.id)) continue;
      seen.add(el.id);
      if (blocksCars(el.tags)) { gateNodes.push([el.lat, el.lon]); st.gates++; } else st.gates_open_to_cars++;
    } }, query, logFn, 'gates');
  st.requests += await overpassByArea((a, b, c, d) => '[out:json][timeout:300];('
      + ['access', 'motor_vehicle', 'motorcar'].map(k => 'way["highway"]["' + k
        + '"~"^(private|no|permit|forestry|agricultural|delivery)$"](' + bb(a, b, c, d) + ');').join('')
      + ');out tags;', area,
    els => { for (const el of els) {
      const w = ways.get('o' + el.id), ac = carRestriction(el.tags);
      if (w && ac && !w.ac) { w.ac = ac; st.restricted_ways++; }
    } }, query, logFn, 'access');
  st.requests += await overpassByArea((a, b, c, d) => '[out:json][timeout:300];way["highway"]["surface"~"' + OSM_PAVED.source
      + '"](' + bb(a, b, c, d) + ');out ids;', area,
    els => { for (const el of els) { const w = ways.get('o' + el.id); if (w && !w.pv) { w.pv = 1; st.paved_ways++; } } },
    query, logFn, 'paved');
  logFn('upgrade    what a car needs: ' + JSON.stringify(st));
  return st;
}

/* ===================== the bake ===================== */
export async function build(opts, deps = {}) {
  const t0 = Date.now();
  const fetchOsm = deps.overpass || forEachElement;
  const fetchArc = deps.arcgis || arcgis;

  if (!deps.overpass) {
    /* The probe is an optimisation, not a gate. Treating an empty result as fatal killed a run while
       the fastest mirror was merely slow to answer /status — it takes ten seconds even when healthy.
       If nothing answers, keep the full declared list and let the per-request retries sort it out;
       the worst case is the run being slower, which beats it not starting. */
    const up = await pickMirrors();
    if (up.length) { mirrors = up; log('  Overpass mirrors up: ' + up.map(u => new URL(u).host).join(', ')); }
    else log('  no mirror answered the probe — trying all ' + mirrors.length + ' anyway');
  }

  const cellsFile = JSON.parse(fs.readFileSync(opts.cells, 'utf8'));
  log('build-access ' + GENERATOR_VERSION + ' - region ' + opts.region + ', '
    + cellsFile.rows.length.toLocaleString() + ' cells');

  const cells = new Map();          // "i:j" -> [lat, lon]
  for (const r of cellsFile.rows) {
    const [i, j] = cellIndex(r[0], r[1]);
    cells.set(i + ':' + j, [r[0], r[1]]);
  }
  const state = { cells, nearest: new Map() };
  const ways = new Map();           // wid -> { name, ref, type, cat, geom (simplified), th }
  const trailheadNodes = [];        // [lat, lon] from OSM highway=trailhead
  const gateNodes = [], gateIds = new Set();   // [lat, lon] of barriers ON roads that stop a car

  const tiles = tilesFor(cellsFile.rows.map(r => ({ lat: r[0], lon: r[1] })), opts.bbox);
  log('  ' + tiles.length + ' tiles to query (cut to the cells they contain, padded '
    + (PAD * 111).toFixed(1) + ' km)');

  const doneTiles = new Set();
  let ck = null, needUpgrade = false, usfsDone = false, usfsPaged = false, schemaNow = CHECKPOINT_SCHEMA;
  if (opts.resume && fs.existsSync(opts.checkpoint)) {
    ck = JSON.parse(fs.readFileSync(opts.checkpoint, 'utf8'));
    const schema = ck.schema || 1;
    /* Compatibility is decided by the checkpoint's schema, not by the generator version. Matching the
       version treated every checkpoint from before a version bump as "a different run", and would
       re-fetch the state — hours of Overpass — to change a rule that only assembly reads. */
    if (ck.region === opts.region && schema <= CHECKPOINT_SCHEMA
        && (schema >= 2 || /^[45]\./.test(String(ck.generator_version)))) {
      for (const [wid, w] of Object.entries(ck.ways || {})) ways.set(wid, w);
      for (const t of (ck.trailheads || [])) trailheadNodes.push(t);
      for (const g of (ck.gates || [])) gateNodes.push(g);
      for (const k of (ck.doneTiles || [])) doneTiles.add(k);
      usfsDone = schema >= 2 ? !!ck.usfs : true;      // schema 1 fetched USFS per tile, alongside OSM
      usfsPaged = ck.usfs === 'paged';                // ...unless an interrupted upgrade already re-paged it
      needUpgrade = schema < CHECKPOINT_SCHEMA;
      schemaNow = schema;
      log('  resuming with ' + doneTiles.size + ' tiles and ' + ways.size.toLocaleString()
        + ' ways collected (checkpoint schema ' + schema + ')');
    } else { log('  checkpoint is from a different run — ignoring'); ck = null; }
  }

  /* What the sources said and nothing derived from it: no per-cell nearest ways, no category a rule
     changed, no trailheads. All of that is assembly, recomputed on every run. */
  const saveCk = () => atomicWrite(opts.checkpoint, JSON.stringify({
    generator_version: GENERATOR_VERSION, schema: schemaNow, region: opts.region, doneTiles: [...doneTiles],
    usfs: usfsPaged ? 'paged' : usfsDone, trailheads: trailheadNodes, gates: gateNodes, ways: Object.fromEntries(ways),
  }), { fatal: false });

  const pending = tiles.filter(t => !doneTiles.has(t.k));
  const queue = pending.slice();
  let finished = 0, sinceWrite = 0;

  /* Tiles are fetched by a small pool. The work is entirely I/O — a tile takes 8 s or 180 s
     depending on how busy the server is, not on how much data it holds — so serialising it wasted
     hours. Four is deliberate restraint: enough to hide the latency, few enough to stay a
     well-behaved client of a free service. Stamping is synchronous, so the shared maps need no
     locking; only the fetches overlap. The checkpoint records WHICH tiles finished, not how many,
     because with a pool they finish out of order and a count would skip the stragglers on resume. */
  async function worker() {
    while (queue.length) {
      const t = queue.shift();
      let nWays = 0, nTh = 0;
      /* Only what the source says. Reconciling against USFS, inferring trailheads and stamping cells
         all happen once, at assembly, after the rules. They used to happen here, tile by tile, against
         whatever each source alone called drivable. */
      await fetchOsm(t.s, t.w, t.n, t.e, el => {
        if (el.type === 'node') {
          if (el.tags && el.tags.highway === 'trailhead') { trailheadNodes.push([el.lat, el.lon]); nTh++; }
          if (el.tags && blocksCars(el.tags) && !gateIds.has(el.id)) { gateIds.add(el.id); gateNodes.push([el.lat, el.lon]); }
          return;
        }
        if (el.type !== 'way' || !el.geometry) return;
        const cat = osmCategory(el.tags);
        if (!cat) return;
        const wid = 'o' + el.id;
        if (!ways.has(wid)) {
          const w = { name: (el.tags.name || null), ref: (el.tags.ref || null), type: osmType(el.tags), cat,
                      geom: simplify(el.geometry.map(p => [p.lat, p.lon]), SIMPLIFY_M), th: TRAILHEAD_NONE };
          /* The tags that describe the road, kept because assembly needs them and the fetch is the only
             moment they are in hand. A schema-1 checkpoint threw them away, which is why upgrading one
             has to ask Overpass for them again. */
          if (osmPaved(el.tags)) w.pv = 1;
          const rd = osmRoughReason(el.tags);
          if (rd) w.rd = rd;
          const ac = carRestriction(el.tags);
          if (ac) w.ac = ac;
          ways.set(wid, w);
        }
        nWays++;
      });

      doneTiles.add(t.k);
      finished++;
      const secs = Math.round((Date.now() - t0) / 1000);
      const eta = finished ? Math.round(secs / finished * (pending.length - finished) / 60) : 0;
      log('  tile ' + finished + '/' + pending.length + '  ' + t.n_cells + ' cells, ' + nWays
        + ' OSM ways, ' + nTh + ' th  (' + secs + 's, ~' + eta + ' min left)');
      if (++sinceWrite >= CHECKPOINT_EVERY) { sinceWrite = 0; saveCk(); }
      if (queue.length) await sleep(POLITE_MS);
    }
  }
  await Promise.all(Array.from({ length: Math.min(TILE_WORKERS, Math.max(1, queue.length)) }, worker));
  saveCk();

  /* A schema-1 checkpoint — every one written before the rules moved to assembly — has USFS flattened
     to one way per feature, no trail_type, and no record of the OSM tags that describe a road. Its OSM
     network is still good, and it is the expensive part, so it is upgraded rather than re-fetched:
     USFS again by page (about 25 requests), then the describing tags from Overpass (a few). */
  const upgrading = needUpgrade && !opts.noUpgrade && !opts.skipUsfs;
  if (needUpgrade && !upgrading) log('  checkpoint schema ' + schemaNow + ' left as it is');
  if (upgrading) log('upgrade    checkpoint schema ' + schemaNow + ' -> ' + CHECKPOINT_SCHEMA);
  if (upgrading && schemaNow < 2) {
    log('upgrade    schema 2: USFS again by page, then the OSM tags that describe a road');
    if (!usfsPaged) {
      for (const wid of [...ways.keys()]) if (wid[0] === 'u') ways.delete(wid);
      usfsDone = false;
    } else log('           USFS was already re-fetched by page before an interruption — keeping it');
  }
  let usfsStats = null, backfill = null, hikeInputs = null;
  if (!opts.skipUsfs && !usfsDone) {
    usfsStats = await fetchUsfs(tiles, opts.bbox, fetchArc, ways, log);
    usfsDone = true; usfsPaged = true;
    saveCk();
  }
  if (upgrading && schemaNow < 2) {
    backfill = await backfillOsmDescriptors(ways, opts.bbox, deps.overpassRaw || overpassRaw, log);
    schemaNow = 2;
    saveCk();
  }
  if (upgrading && schemaNow < 3) {
    log('upgrade    schema 3: gates on roads, and the tags that close a road to cars or pave it');
    gateNodes.length = 0;
    hikeInputs = await backfillHikeInputs(ways, gateNodes, opts.bbox, deps.overpassRaw || overpassRaw, log);
    schemaNow = 3;
    saveCk();
  }

  /* ---- the rules, then trailheads, then the cells — in that order, because each reads the last ---- */
  const ruleStats = applyRules(ways, opts.rules);
  log('rules      ' + JSON.stringify(ruleStats));
  const thStats = inferTrailheads(ways, trailheadNodes);
  log('trailheads ' + thStats.inferred.toLocaleString() + ' inferred, ' + thStats.mapped.toLocaleString() + ' mapped');
  stampAll(state, ways);
  log('stamped    ' + ways.size.toLocaleString() + ' ways onto ' + state.nearest.size.toLocaleString() + ' cells');

  /* ---- assemble ---- */
  const referenced = new Set();
  for (const rec of state.nearest.values()) for (const c of CATS) if (rec[c]) referenced.add(rec[c].wid);

  /* Join fragmented named routes, then keep FULL geometry. Every referenced way becomes one entry;
     a way that was chained into another disappears and its cells are re-pointed at the joined
     route, because a cell should name and draw the route rather than one segment of it. */
  const entries = [];
  for (const wid of referenced) {
    const w = ways.get(wid);
    if (!w) continue;
    entries.push({ wid, name: w.name, ref: w.ref, type: w.type, cat: w.cat, th: w.th,
                   thPt: w.thPt || null,
                   osmId: /^o(\d+)$/.test(wid) ? Number(wid.slice(1)) : null,
                   segments: 1, geom: w.geom });
  }
  const joined = joinRoutes(entries);
  log('join       ' + entries.length.toLocaleString() + ' referenced ways -> '
    + joined.length.toLocaleString() + ' routes ('
    + joined.filter(j => j.segments > 1).length.toLocaleString() + ' were fragmented)');

  /* Which joined route each original way ended up in. joinRoutes keeps the seed entry's wid, and a
     chained member's cells have to follow it there. */
  const routeOf = new Map();
  for (let n = 0; n < joined.length; n++) routeOf.set(joined[n].wid, n);
  // members that were absorbed: find them by geometry containment of their first point
  for (const e of entries) {
    if (routeOf.has(e.wid)) continue;
    let best = -1, bestD = Infinity;
    for (let n = 0; n < joined.length; n++) {
      const j = joined[n];
      if (j.cat !== e.cat || j.type !== e.type || (j.name || '') !== (e.name || '') || (j.ref || '') !== (e.ref || '')) continue;
      const r = nearestOnWay(j.geom, e.geom[0][0], e.geom[0][1]);
      if (r.d < bestD) { bestD = r.d; best = n; }
    }
    if (best >= 0 && bestD <= JOIN_SNAP_M * 2) routeOf.set(e.wid, best);
  }

  /* Elevation along every stored route, from the same Terrarium tiles the cell bake reads. */
  log('elevation  sampling ' + joined.reduce((a, j) => a + j.geom.length, 0).toLocaleString()
    + ' points along ' + joined.length.toLocaleString() + ' routes');
  const profiles = new Array(joined.length).fill(null);
  if (!opts.skipElevation) {
    for (let n = 0; n < joined.length; n++) {
      profiles[n] = despike(await elevationProfile(joined[n].geom, deps.tileFetch));
      if ((n + 1) % 5000 === 0) log('elevation  ' + (n + 1).toLocaleString() + '/' + joined.length.toLocaleString()
        + ' routes, ' + elevTiles + ' terrain tiles');
    }
  }

  const outWays = [], outGeom = [];
  let pts = 0, named = 0, withTh = 0;
  for (let n = 0; n < joined.length; n++) {
    const j = joined[n];
    pts += j.geom.length;
    if (j.name || j.ref) named++;
    if (j.th) withTh++;
    outWays.push([j.name, j.ref, j.type, CATS.indexOf(j.cat), j.th, j.osmId, j.segments]);
    outGeom.push(encodeGeom(j.geom));
  }

  /* The trailhead's position along each route, so a per-cell walk is a subtraction. Measured on the
     stored geometry, so the figures and the drawn line agree.

     ONE path for both kinds now: project the recorded trailhead point onto the finished route. The
     old code special-cased mapped trailheads and left inferred ones at arc 0, which measured the
     walk from whichever end the geometry happened to start at. A route with no recorded point gets
     no walk at all rather than a walk from an assumed end — if we do not know where you would park,
     the honest answer is that the figure is unavailable. */
  const thArc = new Array(joined.length).fill(-1);
  let thUnplaced = 0;
  for (let n = 0; n < joined.length; n++) {
    const j = joined[n];
    if (!j.th || !j.geom.length) continue;
    if (!j.thPt) { thUnplaced++; continue; }
    thArc[n] = nearestOnWay(j.geom, j.thPt[0], j.thPt[1]).arc;
  }

  /* ---- modes: the route network, where a car can get to, and the walk from there (hike first) ----
     Computed for every cell the bake covers, including those no category reached within CAP: the
     network can reach a cell from further away than the nearest-way lookup looks. */
  const cellsWithElev = new Map();
  for (const r of cellsFile.rows) {
    if (!inBbox(r[0], r[1], opts.bbox)) continue;
    const [ci, cj] = cellIndex(r[0], r[1]);
    cellsWithElev.set(ci + ':' + cj, [r[0], r[1], r[2]]);
  }
  let modes = new Map(), modeNet = null, modeStats = null;
  if (!opts.skipModes) {
    const m = await computeModes(ways, cellsWithElev, { gates: gateNodes, log,
      elevationOf: opts.skipElevation ? null : async g => despike(await elevationProfile(g, deps.tileFetch)),
      offTrailClimb: opts.skipElevation ? async () => -1 : (from, to) => offTrailGain(from, to, deps.tileFetch) });
    modes = m.modes; modeNet = m.net; modeStats = m.stats;
    log('modes      ' + JSON.stringify(modeStats));
  }

  const rows = [];
  let withWalk = 0, withGain = 0, withOffGain = 0;
  for (const [k, rec] of state.nearest) {
    const c0 = cells.get(k);
    if (!c0 || !inBbox(c0[0], c0[1], opts.bbox)) continue;
    const [i, j] = k.split(':').map(Number);
    const row = [i, j];
    let any = false;
    for (const c of CATS) {
      const r = rec[c];
      const n = r ? routeOf.get(r.wid) : undefined;
      if (!r || n === undefined) { row.push(-1, -1, -1, -1, -1); continue; }
      any = true;
      const route = joined[n];
      /* r.d and r.arc were measured on the pre-join, pre-simplify geometry, so re-project the cell
         onto the stored route. Every number then describes the line the app draws, and the two legs
         of the approach meet at the same point. */
      const proj = nearestOnWay(route.geom, c0[0], c0[1]);
      let walk = -1, gain = -1;
      if (route.th && thArc[n] >= 0) {
        walk = Math.round(Math.abs(proj.arc - thArc[n]));
        withWalk++;
        gain = gainBetween(route.geom, profiles[n], thArc[n], proj.arc);
        if (gain >= 0) withGain++;
      }
      /* The off-trail leg: from that nearest point straight to the cell centre. The distance is the
         projection itself — which is why it is stored as the category distance rather than as a
         fourth column — and the climb is sampled along the straight line from the same Terrarium
         tiles, de-spiked the same way, so the two legs are measured by one method. */
      const offGain = opts.skipElevation ? -1 : await offTrailGain(proj.pt, c0, deps.tileFetch);
      if (offGain >= 0) withOffGain++;
      row.push(Math.round(proj.d), n, walk, gain, offGain);
    }
    if (any || modes.has(k)) { row.push(...modeColumns(modes.get(k))); rows.push(row); }
  }
  /* cells the network reaches from further than any category's nearest-way lookup looked */
  for (const [k, rec] of modes) {
    if (state.nearest.has(k)) continue;
    const [ri, rj] = k.split(':').map(Number);
    rows.push([ri, rj, ...Array(CATS.length * ROW_STRIDE).fill(-1), ...modeColumns(rec)]);
  }
  rows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const provenance = {
    generator: GENERATOR, generator_version: GENERATOR_VERSION,
    region: opts.region, bbox: opts.bbox,
    sources: SOURCES,
    cells_generated: cellsFile.generated,
    geometry: { simplify_m: SIMPLIFY_M, clipped: false, encoding: 'delta int 1e5',
                points_stored: pts, join_snap_m: JOIN_SNAP_M,
                routes_joined: outWays.filter(w => w[6] > 1).length },
    elevation: { source: TERRAIN_SOURCE.name, zoom: ELEV_Z, tiles: elevTiles,
                 tile_failures: elevTileFails, method: 'cumulative positive difference at every vertex',
                 despike: '3-point median', max_grade: MAX_GRADE },
    trailheads: { mapped_nodes: trailheadNodes.length, snap_m: TH_SNAP_M, mapped_m: TH_MAPPED_M,
                  ways_with_trailhead: withTh },
    rules: ruleStats, trailhead_kinds: thStats, checkpoint_schema: schemaNow,
    usfs_fetch: usfsStats, checkpoint_upgrade: backfill, checkpoint_upgrade_3: hikeInputs,
    modes: modeStats, row_width: ROW_WIDTH,
    tiles: tiles.length,
    requests: { overpass: osmRequests, overpass_retries: osmRetries,
                overpass_mb: +(osmBytes / 1e6).toFixed(1),
                usfs: usfsRequests, usfs_retries: usfsRetries, areas_abandoned: osmGaveUp },
    counts: { cells: rows.length, ways: outWays.length, ways_seen: ways.size,
              ways_named: named, ways_with_trailhead: withTh,
              cell_walks: withWalk, cell_gains: withGain, cell_off_gains: withOffGain,
              trailheads_unplaced: thUnplaced },
    seconds: Math.round((Date.now() - t0) / 1000),
  };
  /* The verification in docs/verification.md needs the reconciled ways and each route's trailhead
     point, which the written file does not carry. Nothing in the bake reads this. */
  if (opts.debug) Object.assign(opts.debug, { ways, joined, thArc, routeOf, ruleStats, thStats });
  const generated = new Date().toISOString();
  let out = { version: ACCESS_FORMAT, generated, cap_m: CAP, provenance, ways: outWays, rows };
  let geomOut = { version: ACCESS_FORMAT, generated, geom: outGeom };

  /* The routes walked, for drawing: a third file, fetched only when an approach is shown. */
  const routesPath = opts.out.replace(/\.json$/, '') + '-routes.json';
  let routesOut = modeNet ? { version: ACCESS_FORMAT, generated, ...routesFile(modeNet, modes) } : null;
  if (routesOut && opts.region !== 'state' && fs.existsSync(routesPath)) {
    const mine = new Set(out.rows.map(r => r[0] + ':' + r[1]));
    routesOut = { ...routesOut, ...mergeRoutes(JSON.parse(fs.readFileSync(routesPath, 'utf8')), routesOut, mine) };
  }
  if (opts.region !== 'state' && fs.existsSync(opts.out)) {
    const prev = JSON.parse(fs.readFileSync(opts.out, 'utf8'));
    const pg = opts.out.replace(/\.json$/, '') + '-geom.json';
    const prevGeom = fs.existsSync(pg) ? (JSON.parse(fs.readFileSync(pg, 'utf8')).geom || []) : [];
    const m = mergeInto(prev, out, prevGeom, outGeom);
    out = m.merged; geomOut = { version: ACCESS_FORMAT, generated, geom: m.geom };
    log('merge      ' + out.provenance.counts.replaced.toLocaleString() + ' rebaked, '
      + out.provenance.counts.carried_over.toLocaleString() + ' carried over');
  }

  /* Two files: names and distances up front, geometry only when someone asks to see a line. */
  const geomPath = opts.out.replace(/\.json$/, '') + '-geom.json';
  if (opts.dryRun) log('dry run - not writing');
  else {
    atomicWrite(opts.out, JSON.stringify(out));
    atomicWrite(geomPath, JSON.stringify(geomOut));
    if (routesOut) {
      atomicWrite(routesPath, JSON.stringify(routesOut));
      log('wrote ' + routesPath + ' - ' + routesOut.cells.length.toLocaleString() + ' hike routes plus '
        + (routesOut.driveCells || []).length.toLocaleString() + ' where the drive walks differently, over '
        + routesOut.edges.length.toLocaleString() + ' edges, ' + (fs.statSync(routesPath).size / 1e6).toFixed(2)
        + ' MB, fetched only when an approach is shown');
    }
    log('wrote ' + opts.out + ' - ' + out.rows.length.toLocaleString() + ' cells, '
      + out.ways.length.toLocaleString() + ' ways, ' + (fs.statSync(opts.out).size / 1e6).toFixed(2) + ' MB');
    log('wrote ' + geomPath + ' - geometry only, ' + (fs.statSync(geomPath).size / 1e6).toFixed(2)
      + ' MB, fetched by the app only on the first "show the approach"');
    /* The checkpoint is NOT deleted on success. It holds the fetched, unclipped geometry, and
       everything after the fetch — joining, elevation, clipping decisions, the row format — is
       assembly. Deleting it last time meant a change to any of that cost a ten-hour re-fetch, which
       is exactly what happened. Re-run with --resume to re-assemble for free. */
    log('kept ' + opts.checkpoint + ' — re-run with --resume to re-assemble without re-fetching');
  }
  log('done in ' + Math.round((Date.now() - t0) / 1000) + 's - ' + osmRequests + ' Overpass ('
    + osmRetries + ' retries, ' + (osmBytes / 1e6).toFixed(0) + ' MB), ' + usfsRequests + ' USFS'
    + (osmGaveUp ? ', ' + osmGaveUp + ' areas abandoned' : ''));
  return out;
}

/* A regional re-bake replaces its own cells and carries the rest through. Way indices are local to a
   file, so the tables are concatenated, carried-over rows re-pointed, and anything nothing points at
   any more is dropped — otherwise a few regional bakes would leave the file full of dead geometry. */
/* Merging has to move geometry in lockstep with the ways table, or the two files silently drift and
   the app draws the wrong line for a cell. `prevGeom`/`freshGeom` are the parallel arrays. */
export function mergeInto(prev, fresh, prevGeom, freshGeom) {
  const mine = new Set(fresh.rows.map(r => r[0] + ':' + r[1]));
  const ways = (fresh.ways || []).slice();
  const geom = (freshGeom || []).slice();
  const shift = ways.length;
  for (const w of (prev.ways || [])) ways.push(w);
  for (const g of (prevGeom || [])) geom.push(g);
  const carried = (prev.rows || []).filter(r => !mine.has(r[0] + ':' + r[1])).map(r => {
    const row = r.slice();
    for (let n = 0; n < CATS.length; n++) { const at = 3 + n * ROW_STRIDE; if (row[at] >= 0) row[at] += shift; }
    return row;
  });
  const rows = [...carried, ...fresh.rows].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const used = new Set();
  for (const r of rows) for (let n = 0; n < CATS.length; n++) { const w = r[3 + n * ROW_STRIDE]; if (w >= 0) used.add(w); }
  const remap = new Map(); const kept = [], keptGeom = [];
  [...used].sort((a, b) => a - b).forEach(old => {
    remap.set(old, kept.length); kept.push(ways[old]); keptGeom.push(geom[old]);
  });
  for (const r of rows) for (let n = 0; n < CATS.length; n++) {
    const at = 3 + n * ROW_STRIDE;
    if (r[at] >= 0) r[at] = remap.get(r[at]);
  }
  return { merged: { ...fresh, ways: kept, rows,
      provenance: { ...fresh.provenance,
        counts: { ...fresh.provenance.counts, cells: rows.length, ways: kept.length,
                  replaced: fresh.rows.length, carried_over: carried.length } } },
    geom: keptGeom };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  build(parseArgs(process.argv.slice(2))).catch(err => { console.error(err); process.exit(1); });
}
