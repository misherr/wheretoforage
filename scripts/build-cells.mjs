#!/usr/bin/env node
/* Bake data/cells.json: elevation, slope, aspect and LANDFIRE vegetation for every square-mile cell
   in Washington that could ever hold king boletes.

   This replaces the app's "Export cells.json" button. That button worked, but it meant the
   authoritative dataset could only be produced by a human running the app locally, waiting out a
   full load and clicking — so it could not run in CI, could not be diffed reproducibly, and mixed
   the application up with the tool that generates its input. PRISM precipitation, SSURGO soil water
   capacity and NIFC fire perimeters all need cells re-baked, and none of that belongs in a UI.

   The science is imported, never reimplemented: everHabitat() decides which cells exist and
   vegSummary() turns LANDFIRE samples into host quality, both straight out of src/model/. The cell
   lattice and terrainAt() come from src/grid.mjs, which index.html imports too. That is the whole
   reason the model was extracted first — a second copy of either would drift, and this repo has
   already paid for that twice (see docs/cell-anchor-join.md, "The script must agree with the app").

   Usage:
     node scripts/build-cells.mjs                      # the whole state
     node scripts/build-cells.mjs --region=coast       # one named region, merged into the existing file
     node scripts/build-cells.mjs --bbox=47,-122,48.5,-120.5
     node scripts/build-cells.mjs --resume             # continue an interrupted run
     node scripts/build-cells.mjs --out=/tmp/cells.json --dry-run

   Every run writes checkpoints, because a full bake is ~350 terrain tiles plus ~580 LANDFIRE
   requests and connect-timeouts are routine on this project. */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { everHabitat } from '../src/model/habitat.mjs';
import { vegSummary } from '../src/model/vegetation.mjs';
import { DLAT, DLON, BLK, BLAT, BLON, STATE, inWA, cellCenter, blockCentre, blockRange,
         terrainAt, pointKey as key } from '../src/grid.mjs';

export const GENERATOR = 'scripts/build-cells.mjs';
export const GENERATOR_VERSION = '1.0.0';

/* ---- sources ---- */
const ELEV_Z = 10;   // ~76 m per pixel at 47 degrees N — plenty for square-mile cells and slope/aspect
export const TERRAIN_SOURCE = {
  name: 'Mapzen Terrarium (AWS elevation-tiles-prod)',
  url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  encoding: 'terrarium', zoom: ELEV_Z,
};
const LF = 'https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2024/';
const LFL = { evt: 'LF2024_EVT_CONUS', evc: 'LF2024_EVC_CONUS', evh: 'LF2024_EVH_CONUS' };
export const LANDFIRE_SOURCE = { product: 'LF2024', year: 2024, layers: { ...LFL }, service: LF };

/* ---- knobs ---- */
const HAB_GATE = 0.08;              // everHabitat must exceed this, the same threshold the app uses
const REQ_TIMEOUT = 45000;          // ms per attempt
const ATTEMPTS = 8;                 // UND_ERR_CONNECT_TIMEOUT is normal here; see docs/verification.md
const TILE_WORKERS = 6;
const LF_CELLS_PER_BATCH = 250;     // x4 quarter points = 1000 sample points per request
const CHECKPOINT_EVERY = Number(process.env.CHECKPOINT_EVERY || 5);   // LANDFIRE batches between writes

/* Named regions, so a partial re-bake does not mean redoing the state. Bounds are generous: a region
   is a way to spend fewer calls, not a claim about where the model applies. */
export const REGIONS = {
  state:            STATE,
  coast:            { lat0: 45.9, lat1: 48.5, lon0: -124.9, lon1: -123.2 },
  olympics:         { lat0: 47.0, lat1: 48.4, lon0: -124.5, lon1: -122.8 },
  'west-cascades':  { lat0: 45.5, lat1: 49.0, lon0: -122.6, lon1: -120.6 },
  'east-cascades':  { lat0: 45.8, lat1: 49.0, lon0: -121.3, lon1: -119.0 },
  okanogan:         { lat0: 47.4, lat1: 49.0, lon0: -120.6, lon1: -117.0 },
  'blue-mountains': { lat0: 45.5, lat1: 46.9, lon0: -118.7, lon1: -116.9 },
  puget:            { lat0: 46.5, lat1: 49.0, lon0: -123.4, lon1: -121.8 },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : '-';

/* ===================== PNG (Terrarium tiles) =====================
   The browser decoded these by drawing them onto a canvas. Node has no canvas, and pulling in a PNG
   library would be the first dependency this repo has ever had, for a format we need one narrow
   slice of: 8-bit non-interlaced RGB/RGBA, which is all a Terrarium tile is. zlib is built in. */
export function decodePNG(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, ihdr = null; const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4),
                                  depth: data[8], color: data[9], interlace: data[12] };
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error('PNG has no IHDR');
  if (ihdr.depth !== 8) throw new Error('PNG bit depth ' + ihdr.depth + ' unsupported (Terrarium is 8)');
  if (ihdr.interlace) throw new Error('interlaced PNG unsupported');
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.color];
  if (!ch) throw new Error('PNG colour type ' + ihdr.color + ' unsupported');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = ihdr.width * ch, out = Buffer.alloc(stride * ihdr.height);
  let p = 0;
  for (let y = 0; y < ihdr.height; y++) {
    const ft = raw[p++];
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const rv = raw[p + x];
      const a = x >= ch ? cur[x - ch] : 0, b = prev ? prev[x] : 0, c = (x >= ch && prev) ? prev[x - ch] : 0;
      let v;
      switch (ft) {
        case 0: v = rv; break;
        case 1: v = rv + a; break;
        case 2: v = rv + b; break;
        case 3: v = rv + ((a + b) >> 1); break;
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          v = rv + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break;
        }
        default: throw new Error('unknown PNG filter ' + ft);
      }
      cur[x] = v & 255;
    }
    p += stride;
  }
  return { width: ihdr.width, height: ihdr.height, channels: ch, data: out };
}

// Terrarium packs metres as (R*256 + G + B/256) - 32768. Identical arithmetic to the app's canvas path.
export const terrariumMetres = (r, g, b) => r * 256 + g + b / 256 - 32768;
export function tileXY(lat, lon, z) {
  const n = 2 ** z, x = (lon + 180) / 360 * n, lr = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n;
  return { x, y };
}

/* ===================== elevation ===================== */
const tiles = new Map();      // "z/x/y" -> decoded tile
const ecache = new Map();     // pointKey -> metres
let tileFetches = 0, tileRetries = 0;

async function loadTile(z, x, y) {
  const k = z + '/' + x + '/' + y;
  if (tiles.has(k)) return tiles.get(k);
  const url = TERRAIN_SOURCE.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  let lastErr = '';
  for (let a = 0; a < ATTEMPTS; a++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(REQ_TIMEOUT) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const img = decodePNG(Buffer.from(await r.arrayBuffer()));
      tileFetches++; tiles.set(k, img); return img;
    } catch (err) {
      lastErr = (err.cause && err.cause.code) || err.name || err.message;
      tileRetries++;
      if (a < ATTEMPTS - 1) {
        log('  retry ' + (a + 1) + '/' + ATTEMPTS + ' tile ' + k + ': ' + lastErr);
        await sleep(Math.min(20000, 800 * (a + 1)));
      }
    }
  }
  throw new Error('terrain tile ' + k + ' failed after ' + ATTEMPTS + ' attempts: ' + lastErr);
}

/* The two network surfaces, injectable. build() takes { loadTile, sample } and defaults to the real
   ones; the tests pass fakes so the whole pipeline — including checkpoint and resume — runs offline
   and deterministically. A resume test that needs the live LANDFIRE service to agree with itself
   twice is not testing resume, it is testing the weather. */
export const realDeps = () => ({ loadTile, sample: sampleLayer });
export function resetCaches() { tiles.clear(); ecache.clear(); tileFetches = tileRetries = lfRequests = lfRetries = 0; }

/* Read elevation for a list of points, grouped by tile so each tile is fetched once. Points already
   in the cache are skipped, which is what makes --resume and the overlapping phases cheap. */
async function elevations(pts, label, loadTileFn = loadTile) {
  const need = pts.filter(p => !ecache.has(key(p[0], p[1])));
  if (need.length) {
    const byTile = new Map();
    for (const p of need) {
      const t = tileXY(p[0], p[1], ELEV_Z), tx = Math.floor(t.x), ty = Math.floor(t.y), k = tx + ',' + ty;
      if (!byTile.has(k)) byTile.set(k, { tx, ty, pts: [] });
      byTile.get(k).pts.push({ p, px: Math.min(255, Math.floor((t.x - tx) * 256)),
                                  py: Math.min(255, Math.floor((t.y - ty) * 256)) });
    }
    const queue = [...byTile.values()]; const total = queue.length; let done = 0;
    log('  ' + label + ': ' + need.length.toLocaleString() + ' new points across ' + total + ' terrain tiles');
    const worker = async () => {
      while (queue.length) {
        const t = queue.shift();
        const img = await loadTileFn(ELEV_Z, t.tx, t.ty);
        for (const q of t.pts) {
          const i = (q.py * img.width + q.px) * img.channels;
          ecache.set(key(q.p[0], q.p[1]), terrariumMetres(img.data[i], img.data[i + 1], img.data[i + 2]));
        }
        if (++done % 25 === 0 || !queue.length) log('  ' + label + ': ' + done + '/' + total + ' tiles (' + pct(done, total) + ')');
      }
    };
    await Promise.all(Array.from({ length: TILE_WORKERS }, worker));
  }
  return pts.map(p => ecache.get(key(p[0], p[1])));
}
const getE = (la, lo) => { const v = ecache.get(key(la, lo)); return v === undefined ? null : v; };

/* ===================== LANDFIRE ===================== */
let lfRequests = 0, lfRetries = 0;
export function loadEvtNames(file = 'data/evt-names.json') {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const src = raw && raw.names ? raw.names : raw;
  const m = new Map();
  for (const k in src) { const n = parseInt(k); if (!isNaN(n)) m.set(n, src[k]); }
  if (m.size <= 50) throw new Error(file + ' has only ' + m.size + ' types - expected hundreds; refusing to bake host quality from it');
  return m;
}

/* Verbatim behaviour of the app's sampleLayer, including the short-batch back-off and the locationId
   indexing. The service answers out of order and occasionally truncates a batch; both are handled by
   trusting locationId and shrinking the chunk rather than by assuming alignment. */
async function sampleLayer(layer, pts) {
  const out = new Array(pts.length).fill(null);
  let chunk = 1000, i = 0;
  while (i < pts.length) {
    const b = pts.slice(i, i + chunk);
    const body = new URLSearchParams({
      geometry: JSON.stringify({ points: b.map(p => [+p[1].toFixed(5), +p[0].toFixed(5)]), spatialReference: { wkid: 4326 } }),
      geometryType: 'esriGeometryMultipoint', returnFirstValueOnly: 'true',
      interpolation: 'RSP_NearestNeighbor', f: 'json',
    });
    let j = null, lastErr = '';
    for (let a = 0; a < ATTEMPTS && !j; a++) {
      try {
        const r = await fetch(LF + LFL[layer] + '/ImageServer/getSamples',
          { method: 'POST', body, signal: AbortSignal.timeout(REQ_TIMEOUT) });
        const x = await r.json();
        if (x.error) throw new Error(x.error.message || 'service error');
        j = x; lfRequests++;
      } catch (err) {
        lastErr = (err.cause && err.cause.code) || err.name || err.message; lfRetries++;
        if (a === ATTEMPTS - 1) throw new Error('LANDFIRE ' + layer + ' failed after ' + ATTEMPTS + ' attempts: ' + lastErr);
        log('  retry ' + (a + 1) + '/' + ATTEMPTS + ' (' + layer + '): ' + lastErr);
        await sleep(Math.min(30000, 1500 * (a + 1)));
      }
    }
    const smp = j.samples || [];
    if (!smp.length) throw new Error('LANDFIRE ' + layer + ' returned no samples for ' + b.length + ' points');
    smp.forEach((sm, k) => {
      const idx = (sm.locationId != null && sm.locationId < b.length) ? sm.locationId : k;
      const v = parseFloat(sm.value); out[i + idx] = isNaN(v) ? null : v;
    });
    if (smp.length < b.length) { chunk = Math.max(50, smp.length); i += smp.length; } else i += b.length;
  }
  return out;
}

/* The four quarter points of a cell, in the app's order. vegSummary() averages over these, and the
   order decides which type is dropped when a cell holds four distinct types and top[] keeps three —
   so this order is part of the output, not an implementation detail. Tested against vegFor(). */
export function quarterPoints(lat, lon, dlat = DLAT, dlon = DLON) {
  const dl = dlat / 4, dn = dlon / 4;
  return [[lat + dl, lon - dn], [lat + dl, lon + dn], [lat - dl, lon - dn], [lat - dl, lon + dn]];
}

/* ===================== enumeration (pure — no network) ===================== */
export function parseArgs(argv) {
  const o = { region: 'state', bbox: null, out: 'data/cells.json', checkpoint: null,
              resume: false, dryRun: false, doy: null };
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
    else if ((m = /^--checkpoint=(.+)$/.exec(a))) o.checkpoint = m[1];
    else if ((m = /^--doy=(\d+)$/.exec(a))) o.doy = Number(m[1]);
    else if (a === '--resume') o.resume = true;
    else if (a === '--dry-run') o.dryRun = true;
    else throw new Error('unknown argument ' + a);
  }
  if (!o.bbox) {
    if (!REGIONS[o.region]) throw new Error('unknown region "' + o.region + '" - one of: ' + Object.keys(REGIONS).join(', '));
    o.bbox = REGIONS[o.region];
  } else o.region = 'bbox';
  o.checkpoint = o.checkpoint || o.out + '.checkpoint.json';
  return o;
}

/* Which cells exist, and where. Two gates, both the app's: a block survives if any of five probe
   points could ever hold boletes, then each cell inside a surviving block is gated on its own.
   everHabitat() takes a day of year, but the gate outcome does not move with it — verified across
   the whole year at 5,270 lattice points, zero crossings — so the cell set is stable whatever day
   the bake runs on. */
export function enumerateBlocks(bbox) {
  const { I0, I1, J0, J1 } = blockRange(bbox);
  const out = [];
  for (let I = I0; I <= I1; I++) for (let J = J0; J <= J1; J++) {
    const [lat, lon] = blockCentre(I, J);
    if (inWA(lat, lon)) out.push({ I, J, lat, lon });
  }
  return out;
}

/* One block of apron around the requested region.

   terrainAt() reads a cell's four neighbours, so a cell on the outer edge of a region has neighbours
   the region does not contain — and without them it falls back to a one-sided gradient and gets a
   different slope and aspect than the same cell would get in a statewide bake. Measured on a 194-cell
   coastal trial: 12 cells' slope and 3 cells' aspect moved, up to 1.1 degrees and 18 degrees.

   So enumerate and sample one block beyond the region, and emit only the cells inside it. A regional
   re-bake then produces exactly what a statewide one would, which is the property that makes
   --region safe to use on live data rather than merely cheaper. Statewide is unaffected: the apron
   falls outside the state outline and inWA() drops it. */
export const apronOf = bbox => ({
  lat0: bbox.lat0 - BLAT, lat1: bbox.lat1 + BLAT,
  lon0: bbox.lon0 - BLON, lon1: bbox.lon1 + BLON,
});
export const inBbox = (lat, lon, b) => lat >= b.lat0 && lat <= b.lat1 && lon >= b.lon0 && lon <= b.lon1;
export const blockProbes = b => [[b.lat, b.lon], [b.lat + DLAT, b.lon + DLON], [b.lat - DLAT, b.lon - DLON],
                                 [b.lat + DLAT, b.lon - DLON], [b.lat - DLAT, b.lon + DLON]];
export function blockCells(b) {
  const out = [];
  for (let i = 0; i < BLK; i++) for (let j = 0; j < BLK; j++) {
    const c = cellCenter(b.I * BLK + i, b.J * BLK + j);
    if (inWA(c[0], c[1])) out.push(c);
  }
  return out;
}

/* ===================== output ===================== */
function atomicWrite(file, body, opts) {
  const fatal = !opts || opts.fatal !== false;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = file + '.tmp';
  for (let a = 0; a < 4; a++) {
    try { fs.writeFileSync(tmp, body); fs.renameSync(tmp, file); return true; }
    catch (err) {
      if (a === 3) {
        if (fatal) throw err;
        console.warn('  checkpoint write failed (' + (err.code || err.message) + ') - carrying on');
        return false;
      }
    }
  }
}

/* Rows carry vegetation type *names*; the compact name-index encoding is applied once here, in final
   row order, so the indices are a function of the file rather than of the order cells were baked. */
export function encode(staged, veg, meta) {
  const names = [];
  const idx = n => { let i = names.indexOf(n); if (i < 0) { names.push(n); i = names.length - 1; } return i; };
  const rows = staged.map((r, i) => {
    const v = veg[i];
    return [r[0], r[1], r[2], r[3], r[4],
      v ? [v[0], v[1], v[2], v[3], v[4].map(t => [idx(t[0]), t[1]]),
           v[5].map(n => n == null ? -1 : idx(n)), v[6]] : null];
  });
  return { version: 2, generated: meta.generated, dlat: DLAT, dlon: DLON, anchor: 0.2,
           provenance: meta.provenance, names, rows };
}

/* A regional run merges into whatever is already on disk: cells inside the region are replaced, cells
   outside are carried through untouched. Rewriting the whole file from a regional run would silently
   delete the rest of the state. */
export function mergeInto(prev, fresh) {
  const mine = new Set(fresh.rows.map(r => r[0] + ',' + r[1]));
  const withNames = (rows, names) => rows.map(r => [r[0], r[1], r[2], r[3], r[4],
    r[5] ? [r[5][0], r[5][1], r[5][2], r[5][3], (r[5][4] || []).map(([ni, s]) => [names[ni], s]),
            (r[5][5] || []).map(ni => ni < 0 ? null : names[ni]), r[5][6] || 0] : null]);
  const carried = withNames(prev.rows, prev.names).filter(r => !mine.has(r[0] + ',' + r[1]));
  const rebaked = withNames(fresh.rows, fresh.names);
  const all = [...carried, ...rebaked].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const staged = all.map(r => [r[0], r[1], r[2], r[3], r[4]]);
  const veg = all.map(r => r[5]);
  const out = encode(staged, veg, { generated: fresh.generated, provenance: fresh.provenance });
  out.provenance = { ...fresh.provenance,
    counts: { cells: out.rows.length, replaced: rebaked.length, carried_over: carried.length } };
  return out;
}

/* ===================== the bake ===================== */
export async function build(opts, deps = {}) {
  const loadTileFn = deps.loadTile || loadTile, sample = deps.sample || sampleLayer;
  const t0 = Date.now();
  const doy = opts.doy != null ? opts.doy
    : Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000);
  const evtNames = loadEvtNames();
  log('build-cells ' + GENERATOR_VERSION + ' - region ' + opts.region
    + ' [' + opts.bbox.lat0 + '..' + opts.bbox.lat1 + ', ' + opts.bbox.lon0 + '..' + opts.bbox.lon1 + '], doy ' + doy);
  log('  EVT table: ' + evtNames.size + ' types | LANDFIRE ' + LANDFIRE_SOURCE.product
    + ' | terrain ' + TERRAIN_SOURCE.encoding + ' z' + ELEV_Z);

  let ck = null;
  if (opts.resume && fs.existsSync(opts.checkpoint)) {
    ck = JSON.parse(fs.readFileSync(opts.checkpoint, 'utf8'));
    if (ck.generator_version !== GENERATOR_VERSION || ck.region !== opts.region || ck.doy !== doy) {
      log('  checkpoint is from a different run (' + ck.generator_version + '/' + ck.region + '/doy ' + ck.doy + ') - ignoring it');
      ck = null;
    } else log('  resuming: ' + ck.staged.length.toLocaleString() + ' cells staged, ' + ck.veg.length.toLocaleString() + ' already vegetated');
  }

  let staged;
  if (ck) staged = ck.staged;
  else {
    /* ---- phase 1: which blocks could ever hold boletes ---- */
    const apron = apronOf(opts.bbox);
    const blocks = enumerateBlocks(apron);
    log('phase 1/4  ' + blocks.length.toLocaleString() + ' candidate blocks in bounds (incl. one block of apron)');
    const probes = blocks.flatMap(blockProbes);
    const pel = await elevations(probes, 'phase 1 terrain', loadTileFn);
    const keep = blocks.filter((b, i) => {
      for (let k = 0; k < 5; k++) {
        if (everHabitat(probes[i * 5 + k][0], probes[i * 5 + k][1], pel[i * 5 + k], doy) > HAB_GATE) return true;
      }
      return false;
    });
    log('phase 1/4  ' + keep.length.toLocaleString() + ' blocks retained (' + pct(keep.length, blocks.length)
      + '), ' + (blocks.length - keep.length).toLocaleString() + ' dropped as never-habitat');

    /* ---- phase 2: elevation for every in-state cell of every retained block ----
       Every cell, including the ones phase 3 will gate out. That is deliberate and it matters for
       reproduction: the app fetched elevation for a whole block before gating, so terrainAt() could
       see a gated-out neighbour. Sampling the same superset here gives the same slope and aspect —
       and, unlike the app, which fetched per anchor group as its queue reached it, the answer no
       longer depends on the order blocks are visited. */
    const cand = keep.flatMap(blockCells);
    log('phase 2/4  ' + cand.length.toLocaleString() + ' candidate cells in retained blocks');
    const cel = await elevations(cand, 'phase 2 terrain', loadTileFn);

    /* ---- phase 3: gate each cell, then slope and aspect ---- */
    staged = []; let noTerrain = 0, gated = 0, apronOnly = 0;
    cand.forEach((c, i) => {
      const elev = cel[i];
      if (elev == null || isNaN(elev)) { noTerrain++; return; }
      if (everHabitat(c[0], c[1], elev, doy) <= HAB_GATE) { gated++; return; }
      // Apron cells were sampled so their neighbours' elevations exist; they are not output.
      if (!inBbox(c[0], c[1], opts.bbox)) { apronOnly++; return; }
      const t = terrainAt(getE, c[0], c[1], DLAT, DLON);
      staged.push([c[0], c[1], Math.round(elev), +t.slope.toFixed(1), t.aspect == null ? -1 : Math.round(t.aspect)]);
    });
    log('phase 3/4  ' + staged.length.toLocaleString() + ' cells to bake ('
      + gated.toLocaleString() + ' gated out'
      + (apronOnly ? ', ' + apronOnly.toLocaleString() + ' apron cells sampled for terrain only' : '')
      + (noTerrain ? ', ' + noTerrain + ' with no terrain' : '') + ')');
  }

  /* ---- phase 4: LANDFIRE vegetation, 250 cells at a time ---- */
  const veg = ck ? ck.veg : [];
  const batches = Math.ceil((staged.length - veg.length) / LF_CELLS_PER_BATCH);
  log('phase 4/4  vegetation for ' + (staged.length - veg.length).toLocaleString()
    + ' cells in ' + batches + ' batches of ' + LF_CELLS_PER_BATCH);
  const saveCk = () => atomicWrite(opts.checkpoint, JSON.stringify({
    generator_version: GENERATOR_VERSION, region: opts.region, bbox: opts.bbox, doy, staged, veg,
  }), { fatal: false });

  /* Checkpoint before the first request, not just every CHECKPOINT_EVERY batches. Phases 1-3 cost
     ~305 terrain tiles; without this, a failure on the very first LANDFIRE batch throws all of that
     away and the resumed run pays for it again. */
  if (!ck) saveCk();

  let sinceWrite = 0, batchNo = 0;
  try {
    while (veg.length < staged.length) {
      const slice = staged.slice(veg.length, veg.length + LF_CELLS_PER_BATCH);
      const pts = slice.flatMap(r => quarterPoints(r[0], r[1]));
      const [evt, evc, evh] = await Promise.all([
        sample('evt', pts), sample('evc', pts), sample('evh', pts)]);
      slice.forEach((r, i) => {
        const v = vegSummary(evt.slice(i * 4, i * 4 + 4), evc.slice(i * 4, i * 4 + 4), evh.slice(i * 4, i * 4 + 4), evtNames);
        /* types[] and treeMask are what make host recomputable at load time: they are everything
           the host average depends on, so a host-rule change no longer needs a re-bake. host and
           top stay at positions 3-4 so an older cached page still reads the file. */
        veg.push(v ? [+v.treeFrac.toFixed(2), Math.round(v.canopy), +v.height.toFixed(1),
                      v.host == null ? -1 : +v.host.toFixed(4),
                      v.top.map(t => [t.name, +t.share.toFixed(2)]),
                      v.types, v.treeMask] : null);
      });
      batchNo++;
      const perCell = (Date.now() - t0) / 1000 / Math.max(1, veg.length);
      log('phase 4/4  batch ' + batchNo + '/' + batches + ' - ' + veg.length.toLocaleString() + '/'
        + staged.length.toLocaleString() + ' cells (' + pct(veg.length, staged.length) + '), ~'
        + Math.round(perCell * (staged.length - veg.length)) + 's left');
      if (++sinceWrite >= CHECKPOINT_EVERY || veg.length >= staged.length) { sinceWrite = 0; saveCk(); }
    }
  } catch (err) {
    /* Bank what we have before letting the error out. The retry ladders above already absorb the
       routine connect timeouts, so reaching here means something is properly wrong — but the next
       run should still start from where this one stopped rather than from nothing. */
    saveCk();
    log('failed after ' + veg.length.toLocaleString() + '/' + staged.length.toLocaleString()
      + ' cells - checkpoint written to ' + opts.checkpoint + '; re-run with --resume');
    throw err;
  }

  const provenance = {
    generator: GENERATOR, generator_version: GENERATOR_VERSION,
    region: opts.region, bbox: opts.bbox, doy,
    landfire: LANDFIRE_SOURCE, terrain: TERRAIN_SOURCE,
    evt_table: { file: 'data/evt-names.json', types: evtNames.size },
    counts: { cells: staged.length },
    requests: { terrain_tiles: tileFetches, terrain_retries: tileRetries,
                landfire: lfRequests, landfire_retries: lfRetries },
    seconds: Math.round((Date.now() - t0) / 1000),
  };
  let out = encode(staged, veg, { generated: new Date().toISOString(), provenance });

  if (opts.region !== 'state' && fs.existsSync(opts.out)) {
    const prev = JSON.parse(fs.readFileSync(opts.out, 'utf8'));
    out = mergeInto(prev, out);
    log('merge      ' + out.provenance.counts.replaced.toLocaleString() + ' cells rebaked, '
      + out.provenance.counts.carried_over.toLocaleString() + ' carried over from the existing file');
  }

  if (opts.dryRun) log('dry run - not writing');
  else {
    atomicWrite(opts.out, JSON.stringify(out));
    log('wrote ' + opts.out + ' - ' + out.rows.length.toLocaleString() + ' cells, '
      + out.names.length + ' vegetation types, ' + (fs.statSync(opts.out).size / 1e6).toFixed(2) + ' MB');
    if (fs.existsSync(opts.checkpoint)) fs.unlinkSync(opts.checkpoint);
  }
  log('done in ' + Math.round((Date.now() - t0) / 1000) + 's - ' + tileFetches + ' terrain tiles ('
    + tileRetries + ' retries), ' + lfRequests + ' LANDFIRE requests (' + lfRetries + ' retries)');
  return out;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  build(parseArgs(process.argv.slice(2))).catch(err => { console.error(err); process.exit(1); });
}
