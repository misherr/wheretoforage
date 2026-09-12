/* The routes file and its merge: what gets stored for drawing, and what a regional re-bake carries
   through. Run: node --test scripts/access-modes.test.mjs   (npm run test:data globs it)

   The first test is here because of a real bug: the drive's walk was compared with the hike's using
   !== on the two encoded tails, which is never true of two arrays, so all 25,999 of them were stored
   as "different" and the routes file grew by 5 MB for nothing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from './access-modes.mjs';
import * as N from './access-network.mjs';

const M_LAT = 111320, mLon = la => 111320 * Math.cos(la * Math.PI / 180);
const LAT = 47.5, LON = -121.6;
const at = (dx, dy) => [LAT + dy / M_LAT, LON + dx / mLon(LAT)];
const line = (x0, y0, x1, y1, n = 8) => Array.from({ length: n + 1 }, (_, k) => at(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n));

/* pavement, a gravel road gated halfway, and a trail on from the gate */
async function world() {
  const ways = [
    { id: 'hwy', geom: line(0, 0, 1000, 0), cat: 'road', type: 'secondary' },
    { id: 'fr', geom: line(1000, 0, 1000, 4000, 20), cat: 'road', type: 'unclassified' },
  ];
  const net = await N.buildNetwork(ways, { gates: [at(1000, 2000)] });
  const car = N.carReach(net);
  const inR = n => car.reach[n] === 1;
  const free = (e, u, v) => N.drivable(net.W[net.eW[e]]) && inR(u) && inR(v);
  const hike = N.walkFrom(net, [...Array(net.nNodes).keys()].filter(inR), free);
  const drv = N.carDrive(net);
  const driveWalk = N.walkFrom(net, [...Array(net.nNodes).keys()].filter(n => isFinite(drv.min[n])), () => false, n => drv.min[n]);
  return { net, hike, free, drv, driveWalk };
}

test('routes: the drive walk is stored only where it is not the hike walk', async () => {
  const w = await world();
  const [la, lo] = at(1100, 3000);                       // past the gate: both modes walk from it
  const hA = N.approaches(w.net, w.hike, w.free, la, lo, null).primary;
  const dA = N.driveApproaches(w.net, w.drv, w.driveWalk, la, lo, null).primary;
  assert.ok(hA && dA, 'both modes reach it');
  const rec = { hike: { on: 1, onUp: 0, off: 1, offUp: 0 }, route: N.routeOf(w.net, w.hike, hA),
                driveRoute: N.routeOf(w.net, w.driveWalk, dA) };
  const out = M.routesFile(w.net, new Map([['1:2', rec]]));
  assert.equal(out.cells.length, 1, 'the hike walk is drawn');
  assert.equal(out.driveCells.length, 0, 'and the drive walks the same line, so it is not stored twice');

  /* now make them differ: a drive that ends at the cell's own road needs no walk at all, and a hike
     from a different place walks a different line */
  const other = { ...rec, driveRoute: N.routeOf(w.net, w.driveWalk,
    N.driveApproaches(w.net, w.drv, w.driveWalk, ...at(1100, 1000), null).primary) };
  const out2 = M.routesFile(w.net, new Map([['1:2', other]]));
  assert.equal(out2.driveCells.length, 0, 'a drive with no walk has no line to draw');
});

test('routes: a regional re-bake keeps the cells it did not touch, in both lists', () => {
  const prev = { edges: ['A', 'B', 'C'], cells: [[1, 1, [0], 'tail1'], [9, 9, [1], 'tail9']],
                 driveCells: [[9, 9, [2], 'dtail9']] };
  const fresh = { edges: ['X'], cells: [[1, 1, [0], 'freshtail']], driveCells: [] };
  const merged = M.mergeRoutes(prev, fresh, new Set(['1:1']));
  assert.deepEqual(merged.cells.map(c => c[0] + ':' + c[1]), ['1:1', '9:9']);
  assert.equal(merged.cells.find(c => c[0] === 1)[3], 'freshtail', 'the re-baked cell takes the new line');
  assert.equal(merged.edges[merged.cells.find(c => c[0] === 9)[2][0]], 'B', 'and a carried cell still points at its own geometry');
  assert.equal(merged.driveCells.length, 1);
  assert.equal(merged.edges[merged.driveCells[0][2][0]], 'C', 'the drive list is re-pointed the same way');
});

test('routes: a cell whose figures need no walking has no route to draw', async () => {
  const w = await world();
  const [la, lo] = at(1050, 1000);                        // beside the gravel, short of the gate
  const hA = N.approaches(w.net, w.hike, w.free, la, lo, null).primary;
  assert.equal(hA.from, 'here', 'the car is already at the nearest point');
  const out = M.routesFile(w.net, new Map([['3:4', { route: N.routeOf(w.net, w.hike, hA), driveRoute: null }]]));
  assert.equal(out.cells.length, 0, 'nothing to draw, and nothing stored');
});
