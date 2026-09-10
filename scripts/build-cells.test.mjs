/* Tests for scripts/build-cells.mjs — the bake that replaced the app's export button.
   Run: node --test scripts/build-cells.test.mjs   (npm run test:data runs it)

   No network. The two network surfaces are injected, so the whole pipeline — including checkpoint
   and resume — runs against synthetic terrain and vegetation. A resume test that needs the live
   LANDFIRE service to agree with itself twice is not testing resume, it is testing the weather.

   What these are guarding, in order of how much it would cost to get wrong:
     - the quarter-point geometry, because vegSummary() averages over exactly those four points and
       the whole vegetation half of cells.json is wrong if they move;
     - the lattice, because a bake script that disagrees with the app about where cells are renders
       a blank map while every tap still works (CLAUDE.md, "The script must agree with the app");
     - checkpoint/resume, because a full bake is ~580 requests and losing one to a connect timeout
       must cost minutes rather than the whole run. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import * as B from './build-cells.mjs';
import { DLAT, DLON, BLK, cellCenter, inWA, pointKey, terrainAt } from '../src/grid.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'build-cells-test-'));

/* ===================== the sampling geometry ===================== */

/* vegFor() in index.html builds its sample points as
     dl=(e.size||DLAT)/4, dn=(e.lonsize||e.size||DLON)/4
     [lat+dl,lon-dn],[lat+dl,lon+dn],[lat-dl,lon-dn],[lat-dl,lon+dn]
   This is that expression, copied out of the app rather than out of the script, so the assertion
   below is a genuine comparison and not a tautology. */
const vegForPoints = (lat, lon, size = DLAT, lonsize = DLON) => {
  const dl = (size || DLAT) / 4, dn = (lonsize || size || DLON) / 4;
  return [[lat + dl, lon - dn], [lat + dl, lon + dn], [lat - dl, lon - dn], [lat - dl, lon + dn]];
};

test('geometry: quarterPoints matches vegFor, point for point and in order', () => {
  for (const [lat, lon] of [[46.98725, -124.0023], [47.5, -121.5], [48.99, -117.05], [45.62, -122.7]]) {
    assert.deepEqual(B.quarterPoints(lat, lon), vegForPoints(lat, lon),
      `quarter points diverged at ${lat},${lon} — vegSummary averages over these four, so cells.json's whole vegetation block moves`);
  }
});

test('geometry: the order is part of the output, not an implementation detail', () => {
  // Four distinct types across four points, and top[] keeps three: which one is dropped depends on
  // insertion order, so a reordered sample list silently changes host quality. Pin the order.
  const p = B.quarterPoints(47.0, -122.0);
  assert.ok(p[0][0] > p[2][0], 'first two points must be the northern pair');
  assert.ok(p[0][1] < p[1][1], 'within a pair, west comes before east');
  assert.ok(p[2][1] < p[3][1], 'within a pair, west comes before east');
});

test('geometry: sub-mile cells scale both axes independently', () => {
  const p = B.quarterPoints(47, -122, 0.007, 0.007);
  assert.deepEqual(p, vegForPoints(47, -122, 0.007, 0.007));
});

/* ===================== the lattice agrees with the app ===================== */

test('lattice: blockCells reproduces the app\'s cellCenter scan, in scan order', () => {
  // index.html: for(i=0..BLK) for(j=0..BLK) cellCenter(b.I*BLK+i, b.J*BLK+j), kept if inWA
  for (const b of [{ I: 810, J: -1449 }, { I: 820, J: -1400 }, { I: 845, J: -2020 }]) {
    const expect = [];
    for (let i = 0; i < BLK; i++) for (let j = 0; j < BLK; j++) {
      const c = cellCenter(b.I * BLK + i, b.J * BLK + j);
      if (inWA(c[0], c[1])) expect.push(c);
    }
    assert.deepEqual(B.blockCells(b), expect);
  }
});

test('lattice: every enumerated cell lands exactly on the cellCenter lattice', () => {
  const blocks = B.enumerateBlocks({ lat0: 47.0, lat1: 47.3, lon0: -122.0, lon1: -121.6 });
  assert.ok(blocks.length > 0, 'the sample bbox should contain blocks');
  for (const b of blocks) for (const [lat, lon] of B.blockCells(b)) {
    const i = Math.floor(lat / DLAT + 1e-9), j = Math.floor(lon / DLON + 1e-9);
    assert.deepEqual([lat, lon], cellCenter(i, j),
      `${lat},${lon} is off-lattice — the app would look for weather at a different anchor`);
  }
});

test('lattice: block probes are the app\'s five points', () => {
  const b = { I: 810, J: -1449, lat: 47.0, lon: -124.0 };
  assert.deepEqual(B.blockProbes(b), [
    [b.lat, b.lon], [b.lat + DLAT, b.lon + DLON], [b.lat - DLAT, b.lon - DLON],
    [b.lat + DLAT, b.lon - DLON], [b.lat - DLAT, b.lon + DLON]]);
});

/* ===================== the apron ===================== */

test('apron: it exists, is one block wide, and never shrinks the region', () => {
  const bb = { lat0: 47.0, lat1: 47.5, lon0: -122.0, lon1: -121.0 };
  const a = B.apronOf(bb);
  assert.ok(a.lat0 < bb.lat0 && a.lat1 > bb.lat1 && a.lon0 < bb.lon0 && a.lon1 > bb.lon1);
  assert.equal(+(bb.lat0 - a.lat0).toFixed(6), +(DLAT * BLK).toFixed(6));
  assert.equal(+(a.lon1 - bb.lon1).toFixed(6), +(DLON * BLK).toFixed(6));
});

test('apron: inBbox is what keeps apron cells out of the output', () => {
  const bb = { lat0: 47.0, lat1: 47.5, lon0: -122.0, lon1: -121.0 };
  assert.ok(B.inBbox(47.2, -121.5, bb));
  assert.ok(B.inBbox(47.0, -122.0, bb), 'the bounds are inclusive');
  assert.ok(!B.inBbox(46.9, -121.5, bb));
  assert.ok(!B.inBbox(47.2, -122.2, bb), 'a cell in the apron must not be emitted');
});

/* Without the apron a region's edge cells lose neighbours and terrainAt falls back to a one-sided
   gradient — a different slope for the same ground. Demonstrated directly on terrainAt, since that
   is where the loss happens. */
test('apron: an edge cell without its neighbours gets a different slope', () => {
  const lat = 47.0, lon = -122.0;
  const elev = new Map([
    [pointKey(lat, lon), 500], [pointKey(lat + DLAT, lon), 560], [pointKey(lat - DLAT, lon), 500],
    [pointKey(lat, lon + DLON), 520], [pointKey(lat, lon - DLON), 480]]);
  const full = terrainAt((a, b) => elev.get(pointKey(a, b)) ?? null, lat, lon, DLAT, DLON);
  elev.delete(pointKey(lat - DLAT, lon));                 // as if the block south were never sampled
  const clipped = terrainAt((a, b) => elev.get(pointKey(a, b)) ?? null, lat, lon, DLAT, DLON);
  assert.notEqual(+full.slope.toFixed(1), +clipped.slope.toFixed(1),
    'losing a neighbour must change the slope — otherwise this test is not detecting the thing the apron fixes');
});

/* ===================== PNG decoding ===================== */

// Minimal PNG encoder for the test only: it exercises the decoder against bytes it did not produce
// the filters for. All five filter types, so a wrong Paeth predictor cannot pass.
function encodePNG(width, height, channels, pixels, filterType) {
  const colour = { 1: 0, 2: 4, 3: 2, 4: 6 }[channels];
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = colour; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filterType;
    for (let x = 0; x < stride; x++) {
      const v = pixels[y * stride + x];
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y ? pixels[(y - 1) * stride + x] : 0;
      const c = (x >= channels && y) ? pixels[(y - 1) * stride + x - channels] : 0;
      let f;
      switch (filterType) {
        case 0: f = v; break;
        case 1: f = v - a; break;
        case 2: f = v - b; break;
        case 3: f = v - ((a + b) >> 1); break;
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          f = v - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break;
        }
      }
      raw[y * (stride + 1) + 1 + x] = f & 255;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('png: decodes every filter type back to the original pixels', () => {
  const W = 9, H = 7, CH = 3;
  const px = new Uint8Array(W * H * CH);
  for (let i = 0; i < px.length; i++) px[i] = (i * 37 + (i % 5) * 91) & 255;
  for (const ft of [0, 1, 2, 3, 4]) {
    const img = B.decodePNG(encodePNG(W, H, CH, px, ft));
    assert.equal(img.width, W); assert.equal(img.height, H); assert.equal(img.channels, CH);
    assert.deepEqual([...img.data], [...px], `filter type ${ft} decoded wrong`);
  }
});

test('png: RGBA tiles decode too, and the R/G/B channels stay put', () => {
  const px = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < px.length; i++) px[i] = (i * 13) & 255;
  const img = B.decodePNG(encodePNG(4, 4, 4, px, 4));
  assert.equal(img.channels, 4);
  assert.deepEqual([...img.data], [...px]);
});

test('png: refuses what it cannot actually decode instead of returning garbage', () => {
  assert.throws(() => B.decodePNG(Buffer.from('not a png at all')), /not a PNG/);
  const bad = encodePNG(4, 4, 3, new Uint8Array(48), 0);
  bad[8 + 4 + 4 + 8] = 16;          // IHDR data[8] is bit depth -> 16
  assert.throws(() => B.decodePNG(bad), /bit depth/);
});

test('png: terrarium elevation arithmetic matches the app\'s canvas decode', () => {
  assert.equal(B.terrariumMetres(128, 0, 0), 0);
  assert.equal(B.terrariumMetres(128, 100, 0), 100);
  assert.equal(B.terrariumMetres(128, 0, 128), 0.5);
  assert.equal(B.terrariumMetres(127, 255, 255), -1 + 255 / 256);   // just below sea level
});

test('png: tileXY matches the app\'s web-mercator expression', () => {
  for (const [lat, lon] of [[47.5, -121.5], [45.6, -124.7], [49.0, -117.0]]) {
    const n = 2 ** 10, lr = lat * Math.PI / 180;
    assert.deepEqual(B.tileXY(lat, lon, 10), {
      x: (lon + 180) / 360 * n,
      y: (1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n });
  }
});

/* ===================== argument parsing ===================== */

test('args: defaults to the whole state and a sibling checkpoint', () => {
  const o = B.parseArgs([]);
  assert.equal(o.region, 'state');
  assert.equal(o.out, 'data/cells.json');
  assert.equal(o.checkpoint, 'data/cells.json.checkpoint.json');
  assert.equal(o.resume, false);
});

test('args: named regions and explicit bboxes both work', () => {
  assert.deepEqual(B.parseArgs(['--region=coast']).bbox, B.REGIONS.coast);
  const o = B.parseArgs(['--bbox=48.5,-120.5,47,-122']);
  assert.equal(o.region, 'bbox');
  assert.deepEqual(o.bbox, { lat0: 47, lat1: 48.5, lon0: -122, lon1: -120.5 }, 'corners may be given in any order');
});

test('args: a typo fails loudly rather than baking the wrong thing', () => {
  assert.throws(() => B.parseArgs(['--region=cascades']), /unknown region/);
  assert.throws(() => B.parseArgs(['--bbox=1,2,3']), /--bbox needs/);
  assert.throws(() => B.parseArgs(['--regoin=coast']), /unknown argument/);
});

/* ===================== the EVT table gate ===================== */

test('evt: a truncated table is refused, not silently baked into host quality', () => {
  const d = tmpdir();
  const f = path.join(d, 'evt.json');
  fs.writeFileSync(f, JSON.stringify({ 7036: 'North Pacific Seasonal Sitka Spruce Forest' }));
  assert.throws(() => B.loadEvtNames(f), /only 1 types/,
    'baking with a short table is how 48,032 cells got host:-1 last time');
  fs.rmSync(d, { recursive: true, force: true });
});

test('evt: the real table loads and covers the three live-verified codes', () => {
  const m = B.loadEvtNames(path.join(REPO, 'data/evt-names.json'));
  assert.ok(m.size > 1000, `expected over a thousand types, got ${m.size}`);
  assert.match(m.get(7036), /Sitka Spruce/);
  assert.match(m.get(7039), /Douglas-fir.*Hemlock/);
});

/* ===================== provenance ===================== */

const fakeProvenance = () => ({
  generator: B.GENERATOR, generator_version: B.GENERATOR_VERSION,
  region: 'state', bbox: B.REGIONS.state, doy: 249,
  landfire: B.LANDFIRE_SOURCE, terrain: B.TERRAIN_SOURCE,
  evt_table: { file: 'data/evt-names.json', types: 1069 },
  counts: { cells: 1 }, requests: {}, seconds: 1,
});

test('provenance: the encoded file records generator, sources and timestamp', () => {
  const out = B.encode([[47, -122, 500, 3.2, 180]],
    [[0.75, 60, 25, 0.8, [['Silver Fir Forest', 0.75]], ['Silver Fir Forest', 'Silver Fir Forest', 'Silver Fir Forest', null], 7]],
    { generated: '2026-09-09T00:00:00.000Z', provenance: fakeProvenance() });
  assert.equal(out.version, 2);
  assert.equal(out.generated, '2026-09-09T00:00:00.000Z');
  const p = out.provenance;
  assert.equal(p.generator, 'scripts/build-cells.mjs');
  assert.match(p.generator_version, /^\d+\.\d+\.\d+$/);
  assert.equal(p.landfire.product, 'LF2024', 'the LANDFIRE product year must be recorded');
  assert.equal(p.landfire.year, 2024);
  assert.match(p.terrain.encoding, /terrarium/);
  assert.equal(p.terrain.zoom, 10, 'the terrain tile zoom changes the resolution — record it');
  assert.ok(p.evt_table.types > 0);
  assert.ok('doy' in p, 'the day of year the gate ran at belongs in the record');
});

test('provenance: the app\'s own fields survive, in the format it reads', () => {
  const out = B.encode([[47, -122, 500, 3.2, 180]], [null], { generated: 'x', provenance: fakeProvenance() });
  assert.equal(out.dlat, DLAT); assert.equal(out.dlon, DLON); assert.equal(out.anchor, 0.2);
  assert.deepEqual(out.rows[0], [47, -122, 500, 3.2, 180, null]);
});

/* ===================== the name-index encoding ===================== */

test('encode: name indices are assigned in row order, so the file is canonical', () => {
  const staged = [[47, -122, 1, 0, -1], [47.1, -122, 2, 0, -1], [47.2, -122, 3, 0, -1]];
  const veg = [
    [1, 60, 30, 1.0, [['Silver Fir', 0.5], ['Hemlock', 0.5]], ['Silver Fir', 'Silver Fir', 'Hemlock', 'Hemlock'], 15],
    [1, 60, 30, 0.6, [['Hemlock', 1.0]], ['Hemlock', 'Hemlock', 'Hemlock', 'Hemlock'], 15],
    [1, 60, 30, 1.0, [['Silver Fir', 1.0]], ['Silver Fir', 'Silver Fir', 'Silver Fir', 'Silver Fir'], 15]];
  const out = B.encode(staged, veg, { generated: 'x', provenance: fakeProvenance() });
  assert.deepEqual(out.names, ['Silver Fir', 'Hemlock']);
  assert.deepEqual(out.rows[0][5][4], [[0, 0.5], [1, 0.5]]);
  assert.deepEqual(out.rows[1][5][4], [[1, 1.0]]);
  assert.deepEqual(out.rows[2][5][4], [[0, 1.0]]);
});

/* ===================== regional merge ===================== */

test('merge: cells outside the region are carried through untouched', () => {
  const prov = fakeProvenance();
  const prev = B.encode(
    [[47.0, -122, 100, 1, 10], [47.1, -122, 200, 2, 20], [47.2, -122, 300, 3, 30]],
    [[1, 50, 20, 0.6, [['Hemlock', 1]], ['Hemlock', 'Hemlock', 'Hemlock', 'Hemlock'], 15],
     [1, 55, 22, 1.0, [['Silver Fir', 1]], ['Silver Fir', 'Silver Fir', 'Silver Fir', 'Silver Fir'], 15], null],
    { generated: 'old', provenance: prov });
  const fresh = B.encode(
    [[47.1, -122, 999, 9, 90]],
    [[1, 77, 44, 0.25, [['Harvested', 1]], ['Harvested', 'Harvested', 'Harvested', 'Harvested'], 15]],
    { generated: 'new', provenance: { ...prov, region: 'bbox' } });

  const m = B.mergeInto(prev, fresh);
  assert.equal(m.rows.length, 3, 'no cell may be lost by a regional bake');
  const byLat = Object.fromEntries(m.rows.map(r => [r[0], r]));
  assert.deepEqual(byLat[47.0].slice(0, 5), [47.0, -122, 100, 1, 10], 'untouched cell must keep its values');
  assert.deepEqual(byLat[47.1].slice(0, 5), [47.1, -122, 999, 9, 90], 'rebaked cell must take the fresh values');
  assert.equal(byLat[47.2][5], null, 'a null vegetation block must survive the round trip');
  assert.equal(m.provenance.counts.replaced, 1);
  assert.equal(m.provenance.counts.carried_over, 2);
});

test('merge: carried-over type names survive re-indexing', () => {
  const prov = fakeProvenance();
  const prev = B.encode([[47.0, -122, 100, 1, 10], [47.1, -122, 200, 2, 20]],
    [[1, 50, 20, 0.6, [['Hemlock', 1]], ['Hemlock', 'Hemlock', 'Hemlock', 'Hemlock'], 15],
     [1, 55, 22, 1.0, [['Silver Fir', 1]], ['Silver Fir', 'Silver Fir', 'Silver Fir', 'Silver Fir'], 15]],
    { generated: 'old', provenance: prov });
  const fresh = B.encode([[47.1, -122, 200, 2, 20]],
    [[1, 55, 22, 0.25, [['Harvested', 1]], ['Harvested', 'Harvested', 'Harvested', 'Harvested'], 15]],
    { generated: 'new', provenance: prov });
  const m = B.mergeInto(prev, fresh);
  const name = r => m.names[r[5][4][0][0]];
  const byLat = Object.fromEntries(m.rows.map(r => [r[0], r]));
  assert.equal(name(byLat[47.0]), 'Hemlock', 'a carried-over row must still point at its own type');
  assert.equal(name(byLat[47.1]), 'Harvested');
});

test('merge: rows come out sorted, so a regional bake produces a readable diff', () => {
  const prov = fakeProvenance();
  const prev = B.encode([[47.2, -122, 3, 0, -1], [47.0, -122, 1, 0, -1]], [null, null], { generated: 'o', provenance: prov });
  const fresh = B.encode([[47.1, -122, 2, 0, -1]], [null], { generated: 'n', provenance: prov });
  const m = B.mergeInto(prev, fresh);
  assert.deepEqual(m.rows.map(r => r[0]), [47.0, 47.1, 47.2]);
});

/* ===================== checkpoint and resume ===================== */

/* Synthetic world: terrain from a smooth function so slope and aspect are well defined, vegetation
   from the point's own coordinates so every cell has a distinct, checkable answer. */
function fakeDeps(counters = {}) {
  counters.tiles = 0; counters.samples = 0;
  const loadTile = async (z, x, y) => {
    counters.tiles++;
    const W = 256, data = Buffer.alloc(W * W * 3);
    for (let py = 0; py < W; py++) for (let px = 0; px < W; px++) {
      // a ridge in the middle elevation band, so plenty of cells clear the habitat gate
      const m = 900 + 300 * Math.sin((x * W + px) / 40) + 200 * Math.cos((y * W + py) / 55);
      const v = Math.round((m + 32768) * 256);
      const i = (py * W + px) * 3;
      data[i] = (v >> 16) & 255; data[i + 1] = (v >> 8) & 255; data[i + 2] = v & 255;
    }
    return { width: W, height: W, channels: 3, data };
  };
  const sample = async (layer, pts) => {
    counters.samples++;
    return pts.map(([lat, lon]) => {
      const h = Math.abs(Math.round(lat * 1e4) * 31 + Math.round(lon * 1e4) * 17);
      if (layer === 'evt') return [7036, 7039, 7084, 7156][h % 4];
      if (layer === 'evc') return 101 + (h % 99);
      return 101 + (h % 50);
    });
  };
  return { loadTile, sample };
}

const BBOX = '47.20,-121.90,47.60,-121.30';   // 778 cells / 4 LANDFIRE batches, so an interrupt has somewhere to land
const stripVolatile = j => {
  const c = JSON.parse(JSON.stringify(j));
  delete c.generated;
  delete c.provenance.seconds;
  delete c.provenance.requests;
  return c;
};

test('resume: an interrupted bake finishes to exactly the output of an uninterrupted one', async () => {
  const d = tmpdir();
  const outA = path.join(d, 'a.json'), outB = path.join(d, 'b.json');
  const argsFor = out => ({ ...B.parseArgs([`--bbox=${BBOX}`, `--out=${out}`, '--doy=249']) });

  // (1) straight through
  B.resetCaches();
  const plain = await B.build(argsFor(outA), fakeDeps());
  assert.ok(plain.rows.length > 400, `the test bbox should bake a useful number of cells, got ${plain.rows.length}`);

  // (2) same bake, but killed after the first LANDFIRE batch, then resumed
  const opts = argsFor(outB);
  B.resetCaches();
  let batches = 0;
  const dying = fakeDeps();
  const realSample = dying.sample;
  dying.sample = async (layer, pts) => {
    if (layer === 'evt' && ++batches > 1) throw new Error('simulated connect timeout');
    return realSample(layer, pts);
  };
  await assert.rejects(() => B.build(opts, dying), /simulated connect timeout/);
  assert.ok(fs.existsSync(opts.checkpoint), 'the interrupted run must leave a checkpoint behind');
  const ck = JSON.parse(fs.readFileSync(opts.checkpoint, 'utf8'));
  assert.ok(ck.veg.length > 0 && ck.veg.length < ck.staged.length,
    `checkpoint should hold partial work, got ${ck.veg.length} of ${ck.staged.length}`);
  assert.ok(!fs.existsSync(outB), 'an interrupted run must not have written an output file');

  B.resetCaches();
  const resumed = await B.build({ ...opts, resume: true }, fakeDeps());

  assert.deepEqual(stripVolatile(resumed), stripVolatile(plain),
    'a resumed bake must produce byte-identical cells to an uninterrupted one');
  assert.equal(resumed.rows.length, plain.rows.length);
  assert.ok(!fs.existsSync(opts.checkpoint), 'a completed run must clear its checkpoint');
  fs.rmSync(d, { recursive: true, force: true });
});

test('resume: the checkpoint holds the staged terrain, so resuming re-reads no tiles', async () => {
  const d = tmpdir();
  const opts = B.parseArgs([`--bbox=${BBOX}`, `--out=${path.join(d, 'c.json')}`, '--doy=249']);
  B.resetCaches();
  let batches = 0;
  const dying = fakeDeps();
  const realSample = dying.sample;
  dying.sample = async (layer, pts) => {
    if (layer === 'evt' && ++batches > 1) throw new Error('boom');
    return realSample(layer, pts);
  };
  await assert.rejects(() => B.build(opts, dying), /boom/);

  B.resetCaches();
  const counters = {};
  const fresh = fakeDeps(counters);
  await B.build({ ...opts, resume: true }, fresh);
  assert.equal(counters.tiles, 0,
    'resume must take terrain from the checkpoint — re-reading tiles is what makes a resume expensive');
  fs.rmSync(d, { recursive: true, force: true });
});

test('resume: a checkpoint from a different region or day is ignored, not misapplied', async () => {
  const d = tmpdir();
  const out = path.join(d, 'd.json');
  const opts = B.parseArgs([`--bbox=${BBOX}`, `--out=${out}`, '--doy=249']);
  fs.writeFileSync(opts.checkpoint, JSON.stringify({
    generator_version: B.GENERATOR_VERSION, region: 'bbox', doy: 100,   // different day
    bbox: opts.bbox, staged: [[47.35, -121.6, 900, 1, 10]], veg: [null],
  }));
  B.resetCaches();
  const r = await B.build({ ...opts, resume: true }, fakeDeps());
  assert.ok(r.rows.length > 400, 'a stale checkpoint must be discarded and the region rebaked');
  fs.rmSync(d, { recursive: true, force: true });
});

/* ===================== the region is a subset of the state ===================== */

test('region: a bbox bake emits only cells inside it, apron excluded', async () => {
  const d = tmpdir();
  const opts = B.parseArgs([`--bbox=${BBOX}`, `--out=${path.join(d, 'e.json')}`, '--doy=249']);
  B.resetCaches();
  const r = await B.build(opts, fakeDeps());
  for (const [lat, lon] of r.rows) {
    assert.ok(B.inBbox(lat, lon, opts.bbox), `${lat},${lon} is outside the requested region`);
  }
  fs.rmSync(d, { recursive: true, force: true });
});

test('region: two abutting bboxes agree with one bbox covering both', async () => {
  // This is the apron's whole purpose: a cell's slope must not depend on which run produced it.
  const d = tmpdir();
  const run = async (bbox) => {
    B.resetCaches();
    const o = B.parseArgs([`--bbox=${bbox}`, `--out=${path.join(d, 'x.json')}`, '--doy=249', '--dry-run']);
    return B.build(o, fakeDeps());
  };
  const whole = await run('47.20,-121.90,47.60,-121.30');
  const south = await run('47.20,-121.90,47.40,-121.30');
  const north = await run('47.4001,-121.90,47.60,-121.30');

  const byKey = j => new Map(j.rows.map(r => [r[0] + ',' + r[1], r.slice(0, 5)]));
  const w = byKey(whole);
  let checked = 0;
  for (const part of [south, north]) for (const [k, v] of byKey(part)) {
    assert.ok(w.has(k), `${k} appeared in a partial bake but not the whole one`);
    assert.deepEqual(v, w.get(k), `${k} got different terrain depending on which region baked it`);
    checked++;
  }
  assert.ok(checked > 700, `expected to check plenty of cells, only saw ${checked}`);
  fs.rmSync(d, { recursive: true, force: true });
});

/* ===================== per-sample types (format 2) ===================== */

test('format 2: per-sample types and the tree mask survive encoding', () => {
  const out = B.encode([[47, -122, 900, 4, 90]],
    [[0.75, 62, 24, 0.7, [['Silver Fir', 0.5], ['Hemlock', 0.25]],
      ['Silver Fir', 'Silver Fir', 'Hemlock', null], 0b0111]],
    { generated: 'x', provenance: fakeProvenance() });
  const vg = out.rows[0][5];
  assert.deepEqual(vg[5].map(i => (i < 0 ? null : out.names[i])),
    ['Silver Fir', 'Silver Fir', 'Hemlock', null], 'the four sample types must round-trip in order');
  assert.equal(vg[6], 0b0111, 'the tree mask must round-trip');
  assert.equal(vg[5].filter(i => i >= 0).length, 3, 'an unnamed sample is recorded as -1, not dropped');
});

test('format 2: host recomputed from samples equals what vegSummary computed', async () => {
  // The whole point of baking per-sample types: a host-rule change must not need a re-bake. That
  // only holds if the load-time recomputation is the same arithmetic as the bake-time one.
  const { vegSummary, hostFromSamples } = await import('../src/model/vegetation.mjs');
  const evtNames = new Map([[7036, 'North Pacific Seasonal Sitka Spruce Forest'],
    [7039, 'North Pacific Maritime Mesic-Wet Douglas-fir-Western Hemlock Forest'],
    [7084, 'North Pacific Montane Shrubland'], [7292, 'Open Water'],
    [7156, 'North Pacific Lowland Riparian Forest']]);
  const cases = [
    [[7036, 7039, 7084, 7292], [155, 170, 239, 11], [113, 119, 206, 11]],
    [[7156, 7084, 7292, 7036], [181, 239, 11, 155], [127, 206, 11, 113]],
    [[7039, 7039, 7039, 7039], [170, 170, 170, 170], [119, 119, 119, 119]],
    [[7084, 7292, 7084, 7292], [239, 11, 239, 11], [206, 11, 206, 11]],
    [[null, 7036, null, 7039], [155, 155, 170, 170], [113, 113, 119, 119]],
  ];
  for (const [evt, evc, evh] of cases) {
    const v = vegSummary(evt, evc, evh, evtNames);
    const again = hostFromSamples(v.types, v.treeMask);
    assert.equal(again.host, v.host, 'recomputed host diverged for ' + JSON.stringify(evt));
  }
});

test('format 2: the tree mask agrees with treeFrac', async () => {
  const { vegSummary } = await import('../src/model/vegetation.mjs');
  const evtNames = new Map([[7036, 'North Pacific Seasonal Sitka Spruce Forest']]);
  const v = vegSummary([7036, 7036, 7036, 7036], [155, 155, 50, 40], [113, 113, 50, 40], evtNames);
  let bits = 0;
  for (let k = 0; k < 4; k++) if (v.treeMask >> k & 1) bits++;
  assert.equal(bits / 4, v.treeFrac, 'popcount of the mask must equal treeFrac');
  assert.equal(v.treeMask, 0b0011, 'only the first two samples are tree-class EVC');
});
