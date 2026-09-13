/* The routes file and its merge: what gets stored for drawing, and what a regional re-bake carries
   through. Run: node --test scripts/access-modes.test.mjs   (npm run test:data globs it)

   The first test is here because of a real bug: the drive's walk was compared with the hike's using
   !== on the two encoded tails, which is never true of two arrays, so all 25,999 of them were stored
   as "different" and the routes file grew by 5 MB for nothing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from './access-modes.mjs';
import * as N from './access-network.mjs';
import * as A from '../src/access.mjs';

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

test('the rules reach the network: a maintenance level times the drive, a bicycle tag stops the bike', async () => {
  /* computeModes copies each way into the network by hand, and three fields the rules stamp were once
     missing from that copy: the drive's 25 mph class was unreachable and 9,106 bicycle=no ways blocked
     nothing at all. This is the end-to-end guard for the passthrough. */
  const ways = new Map([
    ['ohwy', { geom: line(0, 0, 1000, 0), cat: 'road', type: 'secondary' }],
    ['ograded', { geom: line(1000, 0, 1000, 3000, 12), cat: 'road', type: 'unclassified', ml: '4' }],
    ['orough', { geom: line(1000, 0, 4000, 0, 12), cat: 'road', type: 'unclassified' }],
    ['otrail', { geom: line(1000, 3000, 1000, 5000, 8), cat: 'trail', type: 'path', bk: 'no' }],
  ]);
  const cells = new Map([['1:1', [...at(1000, 3000), 500]], ['2:2', [...at(1000, 4900), 500]]]);
  const m = await M.computeModes(ways, cells, { gates: [], elevationOf: null, offTrailClimb: async () => -1 });
  /* the graded road and the rough road are both 3 km from the same junction, and the graded one is
     quicker — which can only happen if ml arrived */
  const graded = m.modes.get('1:1').drive, rough = m.modes.get('2:2');
  assert.ok(graded.graded > 2800, 'the drive down the level-4 road is in the graded class: ' + JSON.stringify(graded));
  assert.equal(graded.rough, 0, 'and none of it in the rough class');
  /* the trail beyond it is tagged bicycle=no, so the bike must walk it rather than ride it */
  assert.ok(m.stats.bike_blocks.bicycle > 0, 'the bicycle tag blocks edges');
  assert.ok(rough.bike.walk.on > 500, 'and the bike walks the tagged trail instead of riding it');
  assert.equal(rough.bike.stop, 6, 'STOP.bicycle — the map says no bicycles');
});

test('the bike is carried by the car, not ridden to where the car could have driven', async () => {
  /* The bike's ride starts at a NODE, but a car stops anywhere along an edge. Without saying so, the
     bike rode the last few hundred metres of a road the car could have driven and 9,157 cells read
     slower by bike than on foot. The bike figure must never be worse than the hike's. */
  const ways = new Map([
    ['ohwy', { geom: line(0, 0, 1000, 0), cat: 'road', type: 'secondary' }],
    ['ofr', { geom: line(1000, 0, 5000, 0, 16), cat: 'road', type: 'unclassified' }],
  ]);
  const cells = new Map([['1:1', [...at(3000, 200), 500]]]);       // beside the middle of the forest road
  const m = await M.computeModes(ways, cells, { gates: [], elevationOf: null, offTrailClimb: async () => -1 });
  const rec = m.modes.get('1:1');
  assert.equal(rec.hike.on, 0, 'the hike calls it a drive-up');
  assert.equal(rec.bike.road + rec.bike.rough + rec.bike.trail, 0, 'so there is nothing to ride');
  assert.equal(rec.bike.walk.on, 0, 'and nothing to walk but the last stretch off the road');
  assert.equal(rec.bike.walk.off, rec.hike.off, 'the same off-trail leg as the hike');
});

test('shards: a cell\'s routes are in the file its index names, with only the edges it needs', () => {
  /* 3.4 MB in one file, fetched at a trailhead, was the problem. Each shard carries its own edge
     table so a tap costs kilobytes; an edge used from two shards is stored twice, which measured at
     2% of the total. */
  const routes = {
    edges: ['A', 'B', 'C'],
    cells: [[100, 100, [0, 1], 'tail1'], [116, 100, [1, 2], 'tail2']],   // 16 cells apart: two shards
    driveCells: [[100, 100, [2], 'dtail']],
    bikeCells: [[116, 100, [0], 'btail']],
  };
  const s = M.shardRoutes(routes);
  assert.deepEqual([...s.keys()].sort(), ['6_6', '7_6']);
  const a = s.get('6_6'), b = s.get('7_6');
  assert.deepEqual(a.cells.map(c => c[0]), [100]);
  assert.deepEqual(b.cells.map(c => c[0]), [116]);
  assert.deepEqual(a.edges, ['A', 'B', 'C'], 'the edges this shard uses, renumbered from zero');
  assert.deepEqual(a.cells[0][2], [0, 1], 'and the cell points at them by the new numbers');
  assert.deepEqual(a.driveCells[0][2], [2]);
  assert.deepEqual(b.edges, ['B', 'C', 'A'], 'the other shard keeps its own copies in its own order');
  assert.deepEqual(b.cells[0][2], [0, 1]);
  assert.deepEqual(b.bikeCells[0][2], [2], 'the ride list is renumbered the same way');
  assert.ok(!a.index && !b.index, 'and the working index is not written out');
});

test('the worst case is ridden, not walked, for the modes that ride', async () => {
  /* The Deming shape: pavement, a gravel road gated where nobody mapped a gate, and a cell at the far
     end of it. The walker's bound is the whole road on foot. The rider's bound is the whole road
     RIDDEN — that is why the machine is in the truck — and saying 5.5 h under the dirt bike was an
     order of magnitude out in the one case the mode exists for. */
  const ways = new Map([
    ['ohwy', { geom: line(0, 0, 1000, 0), cat: 'road', type: 'secondary' }],
    ['ofr', { geom: line(1000, 0, 1000, 6000, 24), cat: 'road', type: 'unclassified' }],
  ]);
  const cells = new Map([['1:1', [...at(1060, 5800), 500]]]);
  const m = await M.computeModes(ways, cells, { gates: [at(1000, 2000)], elevationOf: null,
                                                offTrailClimb: async () => -1 });
  const rec = m.modes.get('1:1');
  const walked = A.footMinutes(rec.worst);
  assert.ok(walked > 60, 'the walker is on that road for over an hour: ' + Math.round(walked));

  for (const [mode, total, metres] of [['bike', A.bikeTravelMinutes, A.rideMetres],
                                       ['moto', A.motoTravelMinutes, A.motoMetres]]) {
    const k = rec[mode], w = k.worst;
    assert.ok(w, mode + ' has a bound of its own');
    assert.ok(metres(w) > metres(k) + 1000,
      mode + ' rides further in the worst case, because it starts at the pavement: '
      + metres(k) + ' -> ' + metres(w));
    assert.ok(total(w) < walked, mode + ' still beats walking the same road: '
      + Math.round(total(w)) + ' against ' + Math.round(walked));
    assert.ok(total(w) >= total(k) - 1,
      'and never beats its own figure, which starts past the gate: ' + Math.round(total(w))
      + ' against ' + Math.round(total(k)));
  }
  assert.ok(A.motoTravelMinutes(rec.moto.worst) < A.bikeTravelMinutes(rec.bike.worst),
    'and the motor beats the pedals over the same gravel');
  assert.equal(m.stats.worst_ride.faster_than_figure, 0, 'the bound is a bound, on every cell');
  assert.equal(m.stats.worst_ride.moto.no_ride, 0, 'and counted per mode, not both riders in one figure');
  assert.equal(m.stats.worst_ride.slower_than_walking, 0);

  /* the columns round-trip, including the sentinel that says "the same walk as the figure above" */
  const row = [1, 1, ...M.modeColumns('moto', rec)];
  assert.equal(row.length, A.MODE_WIDTH.moto);
  assert.equal(row[A.RIDE_WORST_AT + 4], -1, 'the worst case ends where the figure does, so its walk is stored once');
  const back = A.decodeModeRow('moto', row, ...at(1060, 5800)).moto;
  assert.deepEqual(back.worst.walk, back.walk, 'and comes back as that same walk');
  assert.equal(A.motoMetres(back.worst), A.motoMetres(rec.moto.worst));

  /* and a worst case that ends somewhere else keeps its own walk */
  const other = { moto: { ...rec.moto, worst: { ...rec.moto.worst, walk: { on: 77, onUp: 7, off: 7, offUp: 0 } } } };
  const row2 = [1, 1, ...M.modeColumns('moto', other)];
  assert.equal(row2[A.RIDE_WORST_AT + 4], 77, 'stored in full when it differs');
  assert.equal(A.decodeModeRow('moto', row2, ...at(1060, 5800)).moto.worst.walk.on, 77);
});

test('the chain prices the drive to where the ride starts, and names why the car stopped', async () => {
  /* Pavement, two kilometres of graded gravel to a gate, and trail on beyond it. The rider's figure
     has always started at the gate; until v11 nothing said the two kilometres existed, and the
     "easiest access" sort ranked on the part after them. */
  const ways = new Map([
    ['ohwy', { geom: line(0, 0, 1000, 0), cat: 'road', type: 'secondary' }],
    ['ofr', { geom: line(1000, 0, 1000, 2000, 8), cat: 'road', type: 'unclassified', ml: '4' }],
    ['otrail', { geom: line(1000, 2000, 1000, 5000, 12), cat: 'trail', type: 'path' }],
  ]);
  /* past the END of the trail, so there is a walk worth naming as the third leg */
  const cells = new Map([['1:1', [...at(1060, 5600), 500]]]);
  const m = await M.computeModes(ways, cells, { gates: [at(1000, 2000)], elevationOf: null,
                                                offTrailClimb: async () => -1 });
  const rec = m.modes.get('1:1');

  for (const mode of A.RIDE_MODES) {
    const k = rec[mode];
    assert.ok(k, mode + ' reaches the cell');
    assert.ok(k.driveTo, mode + ' carries the drive that reaches its ride');
    /* the drive is the gravel, not the pavement: carDrive starts ON the pavement at no cost */
    assert.ok(k.driveTo.graded > 1800 && k.driveTo.graded < 2200,
      'about two kilometres of graded gravel, and in the graded class because ml=4 reached the network: '
      + JSON.stringify(k.driveTo));
    assert.equal(k.driveTo.rough, 0);
    assert.equal(k.driveTo.stop, A.STOP.gate, 'and the car stopped at the mapped gate');
    /* the effect the change exists for: door to cell now includes that drive, exactly */
    const chain = A.chainMinutes(mode, k);
    const fromCar = mode === 'moto' ? A.motoTravelMinutes(k) : A.bikeTravelMinutes(k);
    assert.ok(chain > fromCar, mode + ': the chain charges for the drive');
    assert.ok(Math.abs((chain - fromCar) - A.driveMinutes(k.driveTo)) < 1e-9, 'by exactly the drive');
    assert.ok(A.driveMinutes(k.driveTo) > 2, 'which is a real number of minutes, not a rounding: '
      + A.driveMinutes(k.driveTo).toFixed(1));
  }

  /* And here the two riders part company on identical ground, for legal reasons rather than physical
     ones: the trail carries no motorized designation, so the bicycle rides it and the dirt bike walks
     it. Same drive, same gate, different law — which is why chaining happens inside a mode and there
     is no "fastest machine" that would hide this. */
  assert.equal(A.chainLegs('bike', rec.bike), 3, 'the bicycle drives, rides and walks');
  assert.ok(A.rideMetres(rec.bike) > 2500, 'riding the trail past the gate: ' + A.rideMetres(rec.bike) + ' m');
  assert.equal(A.chainLegs('moto', rec.moto), 2, 'the dirt bike drives and walks — it may not ride this trail');
  assert.ok(A.motoMetres(rec.moto) < 100, 'six metres of gravel between the gate node and the junction '
    + 'is not a ride, which is what the hundred-metre threshold in chainLegs is for: ' + A.motoMetres(rec.moto));
  assert.equal(rec.moto.stop, A.STOP.designation, 'and says so: no motorized designation recorded');
  assert.ok(A.chainMinutes('moto', rec.moto) > A.chainMinutes('bike', rec.bike),
    'so the slower machine wins here, which a mode that picked for you would have hidden');

  /* counted in the bake's own stats, so a statewide run reports the share rather than asserting it */
  assert.equal(m.stats.bike_three_leg, 1);
  assert.equal(m.stats.moto_three_leg, 0, 'the dirt bike never rides, so it has no three-leg trip here');
  assert.equal(m.stats.bike_no_chain, 0);
  assert.ok(m.stats.drive_leg.bike.p50 > 2, 'and the drive leg is summarised: '
    + JSON.stringify(m.stats.drive_leg.bike));
  assert.equal(m.stats.bike_car_stops[A.STOP.gate], 1, 'with why the car stopped, counted');

  /* the columns round-trip */
  const row = [1, 1, ...M.modeColumns('bike', rec)];
  assert.equal(row.length, A.MODE_WIDTH.bike);
  const back = A.decodeModeRow('bike', row, ...at(1060, 5600)).bike;
  assert.deepEqual(back.driveTo, rec.bike.driveTo);
  assert.equal(Math.round(A.chainMinutes('bike', back)), Math.round(A.chainMinutes('bike', rec.bike)));
});

test('the chain still prices the drive where there is nothing to ride', async () => {
  /* A cell beside a road the car drives to the end of: no ride, but the drive is most of the trip and
     door to cell has to include it. This is the case the drive figure already answered, and the
     riding modes must not disagree with it. */
  const ways = new Map([
    ['ohwy', { geom: line(0, 0, 1000, 0), cat: 'road', type: 'secondary' }],
    ['ofr', { geom: line(1000, 0, 5000, 0, 16), cat: 'road', type: 'unclassified', ml: '4' }],
  ]);
  const cells = new Map([['2:2', [...at(4900, 200), 500]]]);
  const m = await M.computeModes(ways, cells, { gates: [], elevationOf: null, offTrailClimb: async () => -1 });
  const k = m.modes.get('2:2').bike, d = m.modes.get('2:2').drive;
  assert.equal(A.rideMetres(k), 0, 'nothing to ride: the car gets as far as a bike would');
  assert.ok(k.driveTo, 'but the drive is still priced');
  assert.ok(A.driveMinutes(k.driveTo) > 3, 'and it is the bulk of the journey: '
    + A.driveMinutes(k.driveTo).toFixed(1) + ' min');
  assert.equal(A.chainLegs('bike', k), 2, 'two legs, so the sheet keeps the plain as-mapped note');
  /* and it agrees with the drive figure, which answered this cell already */
  assert.ok(Math.abs(A.chainMinutes('bike', k) - A.travelMinutes(d)) < 2,
    'the chain and the drive agree where there is no ride: ' + A.chainMinutes('bike', k).toFixed(1)
    + ' against ' + A.travelMinutes(d).toFixed(1));
});
