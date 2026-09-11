/* Slice the baked access geometry into viewport-sized tiles, so the trails layer can draw the ground
   in view without pulling the whole 5.5 MB file.

   Run: node scripts/build-access-tiles.mjs            (reads data/access.json + data/access-geom.json)
   The statewide bake calls writeTiles() itself at the end of assembly, so a normal re-bake produces
   these without anyone remembering to. This entry point exists so the tiling scheme can change
   without a ten-hour re-fetch — it is a pure transform of two files already on disk.

   WHY TILES AND NOT A FILTER OVER THE ONE FILE
   access-geom.json is 5.52 MB and lazy: the tap fetches it once to draw a single approach, and most
   viewers never do. A layer that draws everything in view cannot wait for 5.5 MB, and filtering it
   client-side would mean downloading all of it first, which is the thing being avoided. Measured at
   z10 the worst viewport at the zooms this layer is allowed (z11 and in) wants 2 tiles and about
   95 KB gzipped.

   z10 IS DELIBERATE, AND IT IS THE SAME ADDRESSING AS THE TERRAIN TILES
   Both bakes already fetch Terrarium at z/x/y z10 and both use tileXY from src/grid.mjs. Reusing the
   scheme means the loader (src/tile-source.mjs) is not specific to this data, which matters because
   the 30 m rebuild will want the same shape. Measured alternatives: z9 gives 81 files but a 240 KB
   worst tile, z8 gives 28 files and 690 KB; z10 gives 270 files, a 27 KB worst tile gzipped, and a
   median of 9 KB.

   GEOMETRY IS CLIPPED AT TILE EDGES, AND THAT IS ONLY SAFE HERE
   Each polyline is split where it crosses an edge, keeping the crossing vertex in both pieces so the
   drawn line has no gap. It costs +10% total against +40% for putting whole ways in every tile they
   touch. Clipping must NOT reach the tap-to-draw path: a way clipped to a radius around the cell is
   exactly the bug that truncated trails before v4, and access-geom.json stays whole for that reason.
   Display and measurement have different contracts.

   A TILE CARRIES ONLY [wayIndex, geometry]
   Category, name, type, trailhead and segment count are already in the ways table the app loads up
   front from access.json — 50,531 entries. Repeating them per tile would be bytes spent on a second
   copy that can disagree with the first. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tileXY } from '../src/grid.mjs';
import { decodeGeom, encodeGeom, ACCESS_FORMAT } from '../src/access.mjs';

export const TILE_Z = 10;
export const TILES_DIR = 'data/access-tiles';

/* Split one polyline into per-tile pieces. Returns a Map of "x/y" -> array of point arrays, because
   a way can leave a tile and come back into it (a switchback near an edge, a road that recrosses). */
export function splitByTile(geom, z = TILE_Z) {
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
       point: at z10 a tile is 39 km and the geometry is simplified to 25 m, so an exact crossing
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

/* Which tiles a lat/lon bounds covers. Shared with the app through src/tile-source.mjs; kept here
   too so the writer and the reader cannot disagree about the scheme. */
export function tilesForBounds(south, west, north, east, z = TILE_Z) {
  const a = tileXY(north, west, z), b = tileXY(south, east, z);
  const out = [];
  for (let x = Math.floor(a.x); x <= Math.floor(b.x); x++)
    for (let y = Math.floor(a.y); y <= Math.floor(b.y); y++) out.push(x + '/' + y);
  return out;
}

/* Build the tile payloads in memory. Separated from the writing so the bake can call it with the
   objects it already has, and so a test can check the output without touching a disk. */
export function buildTiles(access, geomArray, z = TILE_Z) {
  const tiles = new Map();
  let pieces = 0;
  for (let n = 0; n < geomArray.length; n++) {
    const geom = Array.isArray(geomArray[n]) && Array.isArray(geomArray[n][0])
      ? geomArray[n] : decodeGeom(geomArray[n]);
    for (const [k, runs] of splitByTile(geom, z)) {
      if (!tiles.has(k)) tiles.set(k, []);
      for (const run of runs) { tiles.get(k).push([n, encodeGeom(run)]); pieces++; }
    }
  }
  const out = new Map();
  for (const [k, ways] of tiles) {
    out.set(k, { version: ACCESS_FORMAT, generated: access.generated, z, tile: k, ways });
  }
  return { tiles: out, pieces };
}

export function writeTiles(access, geomArray, dir = TILES_DIR, z = TILE_Z, log = console.log) {
  const { tiles, pieces } = buildTiles(access, geomArray, z);
  const root = path.join(dir, String(z));
  fs.rmSync(root, { recursive: true, force: true });     // stale tiles from a previous scheme
  let bytes = 0;
  for (const [k, payload] of tiles) {
    const [x, y] = k.split('/');
    const d = path.join(root, x);
    fs.mkdirSync(d, { recursive: true });
    const body = JSON.stringify(payload);
    fs.writeFileSync(path.join(d, y + '.json'), body);
    bytes += body.length;
  }
  /* The manifest exists so the app never requests a tile that does not exist — 98 of the 368 tiles
     covering the state bbox are empty ocean or Canada, and a 404 per pan is noise in the console and
     a wasted round trip. It also carries the stamp: a tile set from a different bake than the ways
     table the app has loaded would draw lines under the wrong indices, so the app checks. */
  const manifest = { version: ACCESS_FORMAT, generated: access.generated, z,
                     tiles: [...tiles.keys()].sort() };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(manifest));
  log('tiles      ' + tiles.size + ' at z' + z + ', ' + pieces.toLocaleString() + ' pieces, '
    + (bytes / 1e6).toFixed(2) + ' MB on disk (about ' + (bytes / 2.48 / 1e6).toFixed(2) + ' MB gzipped)');
  return { count: tiles.size, bytes, pieces };
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const accessFile = process.argv.find(a => a.startsWith('--access='))?.slice(9) || 'data/access.json';
  const geomFile = process.argv.find(a => a.startsWith('--geom='))?.slice(7) || 'data/access-geom.json';
  const outDir = process.argv.find(a => a.startsWith('--out='))?.slice(6) || TILES_DIR;
  const access = JSON.parse(fs.readFileSync(accessFile, 'utf8'));
  const geom = JSON.parse(fs.readFileSync(geomFile, 'utf8'));
  if (access.version !== ACCESS_FORMAT || geom.version !== ACCESS_FORMAT) {
    console.error(`refusing to tile format v${access.version}/v${geom.version}; this writes v${ACCESS_FORMAT}`);
    process.exit(1);
  }
  if (geom.generated !== access.generated) {
    console.error('refusing to tile: access.json and access-geom.json are from different bakes');
    process.exit(1);
  }
  console.log(`tiling ${geom.geom.length.toLocaleString()} ways from ${accessFile} (${access.generated})`);
  writeTiles(access, geom.geom, outDir);
}
