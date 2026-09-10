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
import { osmCategory, osmType, USFS_DRIVABLE_ML, CAP, CATS, encodeGeom, ROW_STRIDE, ACCESS_FORMAT,
         OSM_DRIVE, OSM_TRAIL, OSM_ROUGH,
         TRAILHEAD_NONE, TRAILHEAD_MAPPED, TRAILHEAD_INFERRED } from '../src/access.mjs';
import { REGIONS, decodePNG, terrariumMetres, tileXY, TERRAIN_SOURCE } from './build-cells.mjs';

export const GENERATOR = 'scripts/build-access.mjs';
export const GENERATOR_VERSION = '3.0.0';

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

/* Nearest point on a polyline to a coordinate, as {d, arc}. */
export function nearestOnWay(pts, lat, lon) {
  if (!pts || !pts.length) return { d: Infinity, arc: 0 };
  if (pts.length === 1) {
    return { d: Math.hypot((lon - pts[0][1]) * mLon(pts[0][0]), (lat - pts[0][0]) * M_LAT), arc: 0 };
  }
  const cum = cumulative(pts);
  let best = Infinity, arc = 0;
  for (let i = 1; i < pts.length; i++) {
    const [aLa, aLn] = pts[i - 1], [bLa, bLn] = pts[i];
    const k = mLon(aLa);
    const ax = aLn * k, ay = aLa * M_LAT, bx = bLn * k, by = bLa * M_LAT;
    const px = lon * k, py = lat * M_LAT;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (d < best) { best = d; arc = cum[i - 1] + t * Math.sqrt(len2); }
  }
  return { d: best, arc };
}

/* ===================== the query ===================== */
const KINDS = [...OSM_DRIVE, ...OSM_TRAIL, ...OSM_ROUGH].join('|');
export const overpassQuery = (s, w, n, e) => `[out:json][timeout:180];
(
  way["highway"~"^(${KINDS})$"]["area"!="yes"](${s},${w},${n},${e});
  way["highway"="service"]["service"~"^(forestry|forest|logging)$"](${s},${w},${n},${e});
  way["abandoned:highway"](${s},${w},${n},${e});
  way["disused:highway"](${s},${w},${n},${e});
  way["razed:highway"](${s},${w},${n},${e});
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
      // Only move off a mirror after it has failed twice running.
      const rateLimited = /429/.test(lastErr);
      if (!rateLimited && a >= 1 && mirrors.length > 1) mirror++;
      await sleep(rateLimited ? Math.min(60000, 5000 * Math.pow(1.8, a)) : 2500);
    }
  }
  throw new Error(lastErr);
}

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

async function arcgis(base, s, w, n, e, fields) {
  const u = base + '/query?f=json&where=1%3D1&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326'
    + '&geometry=' + encodeURIComponent([w, s, e, n].join(','))
    + '&spatialRel=esriSpatialRelIntersects&returnGeometry=true&outFields=' + fields;
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

/* ===================== enumeration ===================== */
export function parseArgs(argv) {
  const o = { region: 'state', bbox: null, out: 'data/access.json', cells: 'data/cells.json',
              checkpoint: null, resume: false, dryRun: false, skipUsfs: false, skipElevation: false };
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
      // keep the strongest trailhead found on any member, and the longest constituent OSM id
      const th = members.reduce((a, m) => Math.max(a, m.th), TRAILHEAD_NONE);
      const osm = members.filter(m => m.osmId).sort((a, b) => b.geom.length - a.geom.length)[0];
      out.push({ ...list[i], geom: chain, th, segments: members.length,
                 osmId: osm ? osm.osmId : null });
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

  const tiles = tilesFor(cellsFile.rows.map(r => ({ lat: r[0], lon: r[1] })), opts.bbox);
  log('  ' + tiles.length + ' tiles to query (cut to the cells they contain, padded '
    + (PAD * 111).toFixed(1) + ' km)');

  const doneTiles = new Set();
  let ck = null;
  if (opts.resume && fs.existsSync(opts.checkpoint)) {
    ck = JSON.parse(fs.readFileSync(opts.checkpoint, 'utf8'));
    if (ck.generator_version === GENERATOR_VERSION && ck.region === opts.region) {
      for (const [k, v] of Object.entries(ck.nearest || {})) {
        const rec = {};
        CATS.forEach((c, n) => { if (v[n * 3] >= 0) rec[c] = { d: v[n * 3], wid: v[n * 3 + 1], arc: v[n * 3 + 2] }; });
        state.nearest.set(k, rec);
      }
      for (const [wid, w] of Object.entries(ck.ways || {})) ways.set(wid, w);
      for (const t of (ck.trailheads || [])) trailheadNodes.push(t);
      for (const k of (ck.doneTiles || [])) doneTiles.add(k);
      log('  resuming with ' + doneTiles.size + ' tiles and ' + ways.size.toLocaleString() + ' ways collected');
    } else { log('  checkpoint is from a different run — ignoring'); ck = null; }
  }

  const saveCk = () => atomicWrite(opts.checkpoint, JSON.stringify({
    generator_version: GENERATOR_VERSION, region: opts.region, doneTiles: [...doneTiles],
    trailheads: trailheadNodes,
    ways: Object.fromEntries(ways),
    nearest: Object.fromEntries([...state.nearest].map(([k, rec]) => [k,
      CATS.flatMap(c => rec[c] ? [Math.round(rec[c].d), rec[c].wid, Math.round(rec[c].arc)] : [-1, -1, -1])])),
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
      let nWays = 0, nFeat = 0, nTh = 0;

      /* Roads are remembered per tile so a trail ending at one can be recognised as a trailhead. */
      const drivable = [];
      const pendingTrails = [];
      await fetchOsm(t.s, t.w, t.n, t.e, el => {
        if (el.type === 'node') {
          if (el.tags && el.tags.highway === 'trailhead') { trailheadNodes.push([el.lat, el.lon]); nTh++; }
          return;
        }
        if (el.type !== 'way' || !el.geometry) return;
        const cat = osmCategory(el.tags);
        if (!cat) return;
        const coords = el.geometry.map(p => [p.lat, p.lon]);
        const wid = 'o' + el.id;
        if (!ways.has(wid)) {
          ways.set(wid, { name: (el.tags.name || null), ref: (el.tags.ref || null),
                          type: osmType(el.tags), cat, geom: simplify(coords, SIMPLIFY_M), th: TRAILHEAD_NONE });
        }
        stampWay(state, coords, cat, wid);
        if (cat === 'road') drivable.push(coords); else pendingTrails.push({ wid, coords });
        nWays++;
      });

      if (!opts.skipUsfs) {
        // Three independent endpoints on a fast server; no reason to wait for each in turn.
        const [rd, cl, tr] = await Promise.all([
          fetchArc(USFS_ROADS + '/0', t.s, t.w, t.n, t.e, 'objectid,name,id,oper_maint_level'),
          fetchArc(USFS_ROADS + '/1', t.s, t.w, t.n, t.e, 'objectid,name,id'),
          fetchArc(USFS_TRAILS, t.s, t.w, t.n, t.e, 'objectid,trail_name,trail_no'),
        ]);
        const addArc = (res, typeName, catOf, nameOf, refOf) => {
          for (const f of (res.features || [])) {
            const a = f.attributes || {};
            const coords = (f.geometry && f.geometry.paths ? f.geometry.paths.flat() : []).map(p => [p[1], p[0]]);
            if (!coords.length) continue;
            const wid = 'u' + typeName + a.objectid;
            const cat = catOf(a);
            if (!ways.has(wid)) {
              ways.set(wid, { name: nameOf(a) || null, ref: refOf(a) == null ? null : String(refOf(a)),
                              type: typeName, cat, geom: simplify(coords, SIMPLIFY_M), th: TRAILHEAD_NONE });
            }
            stampWay(state, coords, cat, wid);
            if (cat === 'road') drivable.push(coords); else pendingTrails.push({ wid, coords });
            nFeat++;
          }
        };
        addArc(rd, 'nfsr', a => USFS_DRIVABLE_ML.test(String(a.oper_maint_level || '')) ? 'road' : 'rough',
          a => a.name, a => a.id);
        addArc(cl, 'nfsr-closed', () => 'rough', a => a.name, a => a.id);
        addArc(tr, 'nfst', () => 'trail', a => a.trail_name, a => a.trail_no);
      }

      /* Infer a trailhead where a non-road way ends at a drivable road. There is no USFS trailheads
         dataset in EDW and OSM's highway=trailhead tag is sparse — 13 nodes across six sample tiles
         — so relying on it alone would leave a walk figure for almost nobody. Where a trail meets a
         road is where you leave the car; it is derivable from data already fetched; and it is
         labelled as an inference rather than as a surveyed point. */
      for (const { wid, coords } of pendingTrails) {
        const w = ways.get(wid);
        if (!w || w.th !== TRAILHEAD_NONE) continue;
        for (const end of [coords[0], coords[coords.length - 1]]) {
          if (!end) continue;
          for (const road of drivable) {
            if (nearestOnWay(road, end[0], end[1]).d <= TH_SNAP_M) { w.th = TRAILHEAD_INFERRED; break; }
          }
          if (w.th !== TRAILHEAD_NONE) break;
        }
      }

      doneTiles.add(t.k);
      finished++;
      const secs = Math.round((Date.now() - t0) / 1000);
      const eta = finished ? Math.round(secs / finished * (pending.length - finished) / 60) : 0;
      log('  tile ' + finished + '/' + pending.length + '  ' + t.n_cells + ' cells, ' + nWays
        + ' OSM ways, ' + nFeat + ' USFS, ' + nTh + ' th  (' + secs + 's, ~' + eta + ' min left)');
      if (++sinceWrite >= CHECKPOINT_EVERY) { sinceWrite = 0; saveCk(); }
      if (queue.length) await sleep(POLITE_MS);
    }
  }
  await Promise.all(Array.from({ length: Math.min(TILE_WORKERS, Math.max(1, queue.length)) }, worker));
  saveCk();

  /* A mapped trailhead outranks an inferred one — it is a surveyed point rather than a deduction. */
  for (const [, w] of ways) {
    if (w.cat === 'road' || !w.geom.length) continue;
    for (const [tLa, tLn] of trailheadNodes) {
      if (nearestOnWay(w.geom, tLa, tLn).d <= TH_MAPPED_M) { w.th = TRAILHEAD_MAPPED; break; }
    }
  }

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
     stored geometry, so the figures and the drawn line agree. An inferred trailhead is an END of the
     route; a mapped one is projected onto it. */
  const thArc = new Array(joined.length).fill(-1);
  for (let n = 0; n < joined.length; n++) {
    const j = joined[n];
    if (!j.th || !j.geom.length) continue;
    let arc = 0;
    if (j.th === TRAILHEAD_MAPPED) {
      let best = Infinity;
      for (const [tLa, tLn] of trailheadNodes) {
        const r = nearestOnWay(j.geom, tLa, tLn);
        if (r.d <= TH_MAPPED_M && r.d < best) { best = r.d; arc = r.arc; }
      }
      if (best === Infinity) arc = 0;
    }
    thArc[n] = arc;
  }

  const rows = [];
  let withWalk = 0, withGain = 0;
  for (const [k, rec] of state.nearest) {
    const c0 = cells.get(k);
    if (!c0 || !inBbox(c0[0], c0[1], opts.bbox)) continue;
    const [i, j] = k.split(':').map(Number);
    const row = [i, j];
    let any = false;
    for (const c of CATS) {
      const r = rec[c];
      const n = r ? routeOf.get(r.wid) : undefined;
      if (!r || n === undefined) { row.push(-1, -1, -1, -1); continue; }
      any = true;
      const route = joined[n];
      let walk = -1, gain = -1;
      if (route.th && thArc[n] >= 0) {
        /* r.arc was measured on the pre-join geometry, so re-project the cell onto the route: the
           number shown has to describe the line shown. */
        const proj = nearestOnWay(route.geom, c0[0], c0[1]);
        walk = Math.round(Math.abs(proj.arc - thArc[n]));
        withWalk++;
        gain = gainBetween(route.geom, profiles[n], thArc[n], proj.arc);
        if (gain >= 0) withGain++;
      }
      row.push(Math.round(r.d), n, walk, gain);
    }
    if (any) rows.push(row);
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
    tiles: tiles.length,
    requests: { overpass: osmRequests, overpass_retries: osmRetries,
                overpass_mb: +(osmBytes / 1e6).toFixed(1),
                usfs: usfsRequests, usfs_retries: usfsRetries, areas_abandoned: osmGaveUp },
    counts: { cells: rows.length, ways: outWays.length, ways_seen: ways.size,
              ways_named: named, ways_with_trailhead: withTh,
              cell_walks: withWalk, cell_gains: withGain },
    seconds: Math.round((Date.now() - t0) / 1000),
  };
  const generated = new Date().toISOString();
  let out = { version: ACCESS_FORMAT, generated, cap_m: CAP, provenance, ways: outWays, rows };
  let geomOut = { version: ACCESS_FORMAT, generated, geom: outGeom };

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
