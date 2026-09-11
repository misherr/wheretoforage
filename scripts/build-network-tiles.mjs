/* The road and trail NETWORK, as map tiles.

   Run: node scripts/build-network-tiles.mjs          (reads data/access.json.checkpoint.json)
   The statewide bake calls writeNetworkTiles() itself from its in-memory ways, so a re-bake produces
   these without anyone remembering. This entry point exists because the checkpoint already holds
   every way ever fetched, so the tiles can be rebuilt — or the filter and the tiling changed —
   without touching the network.

   WHY THIS EXISTS SEPARATELY FROM data/access.json
   access.json answers "how do I reach THIS CELL": one nearest way per cell per category. Those ways
   are 53,252 of the 460,370 the bake fetched — 11.6%, and only 1.4% in the Seattle tile. Drawing
   them as a layer produced a scatter of disconnected stubs on the cell lattice: 597 ways in 562
   connected pieces, 1.1 ways per piece, against 5.3 for the real network there. "Ways some cell
   pointed at" is not a map and cannot be styled into one.

   So this is a map layer in its own right. It never consults the cell references, never consults the
   ways table, and carries its own category per piece — because 407,000 of these ways have no entry
   in that table at all. Conflating the two is what produced the fragments.

   WHAT IS LEFT OUT, AND WHY THAT IS A CHOICE RATHER THAN A BUG
   The urban street grid. `residential` alone is 191,941 ways and 493,227 vertices — 27% of all the
   geometry and the entire reason a full-network viewport costs 1.1 MB in Seattle. This app is for
   timber, not city blocks: "which ground has a route" is never answered by a residential street.
   Filtering by name does not work, because 93% of residential ways are named; filtering by type
   does. The layer's legend says the streets are missing on purpose, because an absent street looks
   exactly like the bug this replaces. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tileXY } from '../src/grid.mjs';
import { encodeGeom, ACCESS_FORMAT, CATS } from '../src/access.mjs';


/* Split one polyline into per-tile pieces. Returns a Map of "x/y" -> array of point arrays, because
   a way can leave a tile and come back into it (a switchback near an edge, a road that recrosses). */
export function splitByTile(geom, z = NETWORK_Z) {
  const out = new Map();
  if (!geom || geom.length < 2) return out;
  const keyOf = ([la, ln]) => { const t = tileXY(la, ln, z); return Math.floor(t.x) + '/' + Math.floor(t.y); };
  let cur = [geom[0]], curKey = keyOf(geom[0]);
  const flush = () => {
    if (cur.length < 2) return;
    if (!out.has(curKey)) out.set(curKey, []);
    out.get(curKey).push(cur);
  };
  for (let i = 1; i < geom.length; i++) {
    const k = keyOf(geom[i]);
    if (k === curKey) { cur.push(geom[i]); continue; }
    /* The crossing segment belongs to both tiles, or the line would have a gap at every edge. The
       previous vertex is repeated into the new piece rather than interpolating the exact crossing
       point: at z12 a tile is about 9.8 km and the geometry is simplified to 25 m, so an exact crossing
       buys nothing a viewer could see, and interpolating would put a vertex in neither tile's
       source data. */
    cur.push(geom[i]);
    flush();
    cur = [geom[i - 1], geom[i]];
    curKey = k;
  }
  flush();
  return out;
}

export const NETWORK_Z = 12;
export const NETWORK_DIR = 'data/network-tiles';

/* Highway types the layer drops. Type, never name. Everything else the bake fetched is kept:
   track, path, bridleway, unclassified, the USFS layers, and every arterial you would drive to get
   to them. */
export const URBAN_TYPES = new Set(['residential', 'living_street', 'service', 'cycleway',
                                    'footway', 'steps']);
export const isUrbanStreet = type => URBAN_TYPES.has(type || '');

/* z12 because the viewport is what hurts, not the total. The same geometry tiled at z10 costs
   494 KB for the worst two-tile view and at z12 costs 83 KB; a phone at app zoom 12 covers 8 z12
   tiles, whose median is 1 KB each. The total barely moves — 5.89 MB gzipped at z10 against 6.52 MB
   at z12 — because clipping duplication is small next to the geometry itself. */

export function buildNetworkTiles(ways, z = NETWORK_Z) {
  const tiles = new Map();
  let kept = 0, dropped = 0, pieces = 0, points = 0;
  for (const w of ways) {
    if (!w || !w.geom || w.geom.length < 2) continue;
    if (isUrbanStreet(w.type)) { dropped++; continue; }
    const cat = CATS.indexOf(w.cat);
    if (cat < 0) { dropped++; continue; }
    kept++;
    for (const [k, runs] of splitByTile(w.geom, z)) {
      if (!tiles.has(k)) tiles.set(k, []);
      for (const run of runs) { tiles.get(k).push([cat, encodeGeom(run)]); pieces++; points += run.length; }
    }
  }
  return { tiles, kept, dropped, pieces, points };
}

export function writeNetworkTiles(ways, generated, dir = NETWORK_DIR, z = NETWORK_Z, log = console.log) {
  const { tiles, kept, dropped, pieces, points } = buildNetworkTiles(ways, z);
  const root = path.join(dir, String(z));
  fs.rmSync(root, { recursive: true, force: true });
  let bytes = 0;
  for (const [k, entries] of tiles) {
    const [x, y] = k.split('/');
    const d = path.join(root, x);
    fs.mkdirSync(d, { recursive: true });
    const body = JSON.stringify({ version: ACCESS_FORMAT, z, tile: k, ways: entries });
    fs.writeFileSync(path.join(d, y + '.json'), body);
    bytes += body.length;
  }
  /* The manifest is self-describing on purpose: it carries the stamp that busts the tile URLs, so
     the layer needs nothing from access.json to load. The old tiles took their stamp from there,
     which is the same conflation that produced the fragments. */
  const manifest = { version: ACCESS_FORMAT, generated, z, excluded: [...URBAN_TYPES].sort(),
                     counts: { ways: kept, dropped_urban: dropped, pieces, points },
                     tiles: [...tiles.keys()].sort() };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(manifest));
  log('network    ' + tiles.size.toLocaleString() + ' tiles at z' + z + ', '
    + kept.toLocaleString() + ' ways (' + dropped.toLocaleString() + ' urban dropped), '
    + pieces.toLocaleString() + ' pieces, ' + (bytes / 1e6).toFixed(1) + ' MB on disk');
  return { count: tiles.size, bytes, kept, dropped, pieces };
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const ckFile = process.argv.find(a => a.startsWith('--checkpoint='))?.slice(13)
    || 'data/access.json.checkpoint.json';
  const outDir = process.argv.find(a => a.startsWith('--out='))?.slice(6) || NETWORK_DIR;
  if (!fs.existsSync(ckFile)) {
    console.error(`no checkpoint at ${ckFile}. It holds every fetched way and is gitignored, so if it`);
    console.error('is gone the network has to be re-fetched: node scripts/build-access.mjs (about 80 min).');
    console.error('See ROADMAP.md — a local Geofabrik extract would remove that dependency.');
    process.exit(1);
  }
  console.log(`reading ${ckFile}`);
  const ck = JSON.parse(fs.readFileSync(ckFile, 'utf8'));
  const ways = Object.values(ck.ways || {});
  /* The checkpoint has no timestamp of its own, so the stamp comes from the access bake it belongs
     to — the same fetch produced both — and falls back to the file's mtime. */
  let generated = null;
  try { generated = JSON.parse(fs.readFileSync('data/access.json', 'utf8')).generated; } catch { /* none */ }
  generated = generated || fs.statSync(ckFile).mtime.toISOString();
  console.log(`${ways.length.toLocaleString()} fetched ways, stamping ${generated}`);
  writeNetworkTiles(ways, generated, outDir);
}
