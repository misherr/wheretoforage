/* The route network: junctions, where a car can get to, and the walk from there.
   Run: node --test scripts/access-network.test.mjs   (npm run test:data globs it)

   Small synthetic networks, each built to fail in one specific way if the rule it guards breaks.
   The one that matters most is the Deming case: a road gated six miles short of the ground. The drive
   must end at the gate, and the walk must carry on along the gated road — a corridor, not a wall. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as N from './access-network.mjs';

const M_LAT = 111320, mLon = la => 111320 * Math.cos(la * Math.PI / 180);
const LAT = 47.5, LON = -121.6;
/* a straight way from (dx0, dy0) to (dx1, dy1), in metres east/north of the origin */
const at = (dx, dy) => [LAT + dy / M_LAT, LON + dx / mLon(LAT)];
const line = (x0, y0, x1, y1, n = 8) => Array.from({ length: n + 1 }, (_, k) => at(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n));
const way = (id, geom, o) => ({ id, geom, cat: 'road', type: 'unclassified', ...o });
const build = (ways, gates = []) => N.buildNetwork(ways, { gates });
const flat = () => 0;

async function world(ways, gates = []) {
  const net = await build(ways, gates);
  const car = N.carReach(net);
  const inR = n => car.reach[n] === 1;
  const free = (e, u, v) => N.drivable(net.W[net.eW[e]]) && inR(u) && inR(v);
  const walk = N.walkFrom(net, [...Array(net.nNodes).keys()].filter(inR), free);
  return { net, car, walk, free };
}
const approach = (w, x, y) => { const [la, lo] = at(x, y); return N.bestApproach(w.net, w.walk, w.free, la, lo, null); };

test('junctions: ends that meet, an end on a side, and lines that cross are all joined', async () => {
  const net = await build([
    way('road', line(0, 0, 2000, 0), { type: 'secondary' }),
    way('spur', line(1000, 8, 1000, 900), { cat: 'rough', type: 'track' }),        // ends 8 m off the road's side
    way('t1', line(1000, 900, 1600, 900), { cat: 'trail', type: 'path' }),         // meets the spur's end
    way('t2', line(1300, 600, 1300, 1400), { cat: 'trail', type: 'path' }),        // crosses t1
  ]);
  assert.equal(net.st.side_joins, 1, 'the spur joins the road at its side');
  assert.ok(net.st.end_joins >= 1, 'the trail joins the spur end to end');
  assert.equal(net.st.crossings, 1, 'the two trails join where they cross');
  /* one connected piece: walk from the road's west end reaches the crossing trail's far end */
  const w = N.walkFrom(net, [0], () => false);
  assert.ok([...w.cost].every(Number.isFinite), 'every node is reachable from every other');
});

test('car: the drive ends at a mapped gate, and the walk carries on along the gated road', async () => {
  /* Deming, in miniature: pavement, then a gravel road gated 2 km short of the ground */
  const w = await world([
    way('hwy', line(0, 0, 1000, 0), { type: 'secondary' }),
    way('fr', line(1000, 0, 1000, 6000, 30), { type: 'unclassified' }),
  ], [at(1000, 2000)]);
  assert.equal(w.net.st.gates_placed, 1);
  const a = approach(w, 1200, 5500);                            // a cell beside the far end of the road
  assert.ok(a, 'the ground is still reachable — on foot');
  assert.ok(a.on > 3300 && a.on < 3700, `about 3.5 km on foot from the gate, got ${Math.round(a.on)} m`);
  const start = w.walk.start[a.from];
  assert.equal(N.stopReason(w.net, start), 'gate', 'and the sheet can say why the drive ended');
  const beforeGate = approach(w, 1200, 1500);
  assert.equal(beforeGate.on, 0, 'short of the gate it is still a drive');
});

test('car: without the gate, the same road is a drive — which is why the worst case exists', async () => {
  const w = await world([
    way('hwy', line(0, 0, 1000, 0), { type: 'secondary' }),
    way('fr', line(1000, 0, 1000, 6000, 30)),
  ]);
  assert.equal(approach(w, 1200, 5500).on, 0, 'an unmapped gate is invisible: the map says drive up');
  /* the worst case walks from the pavement, gravel and all */
  const pavedNode = new Uint8Array(w.net.nNodes);
  for (let e = 0; e < w.net.E; e++) if (N.paved(w.net.W[w.net.eW[e]])) { pavedNode[w.net.eU[e]] = 1; pavedNode[w.net.eV[e]] = 1; }
  const free = (e, u, v) => N.paved(w.net.W[w.net.eW[e]]) && pavedNode[u] && pavedNode[v];
  const walk = N.walkFrom(w.net, [...Array(w.net.nNodes).keys()].filter(n => pavedNode[n]), free);
  const [la, lo] = at(1200, 5500);
  const worst = N.bestApproach(w.net, walk, free, la, lo, null);
  assert.ok(worst.on > 5300, `the worst case walks the whole gravel road, got ${Math.round(worst.on)} m`);
});

test('car: private and permit roads are not driven, but they are walked', async () => {
  const w = await world([
    way('hwy', line(0, 0, 1000, 0), { type: 'secondary' }),
    way('timber', line(1000, 0, 1000, 3000, 15), { ac: 'private' }),
  ]);
  const a = approach(w, 1100, 2800);
  assert.ok(a.on > 2600, 'the car stops where the private road starts');
  assert.equal(N.stopReason(w.net, w.walk.start[a.from]), 'private');
});

test('car: a drivable road with no mapped link to pavement is not somewhere a car can start', async () => {
  const w = await world([
    way('hwy', line(0, 0, 1000, 0), { type: 'secondary' }),
    way('island', line(3000, 3000, 3000, 5000), {}),              // drivable, but joined to nothing
    way('trail', line(1000, 0, 3000, 3000, 20), { cat: 'trail', type: 'path' }),
  ]);
  const islandEdges = [...Array(w.net.E).keys()].filter(e => w.net.W[w.net.eW[e]].id === 'island');
  assert.ok(islandEdges.length, 'the island road is in the network');
  for (const e of islandEdges) assert.ok(!(w.car.reach[w.net.eU[e]] && w.car.reach[w.net.eV[e]]),
    'but no car gets onto it: nothing joins it to pavement');
  const a = approach(w, 3050, 4800);
  assert.ok(a.on > 3000, `the island road is walked, not driven: ${Math.round(a.on)} m`);
});

test('approach: a trail that starts at the car beats a nearer one that starts miles away', async () => {
  const w = await world([
    way('hwy', line(0, 0, 3000, 0), { type: 'secondary' }),
    way('near-car', line(3000, 0, 3000, 1400, 10), { cat: 'trail', type: 'path' }),   // 250 m from the cell, starts at the road
    way('isolated', line(3600, 1500, 3700, 1600, 2), { cat: 'trail', type: 'path' }),  // 100 m from the cell, joined to nothing
  ]);
  const a = approach(w, 3250, 1500);
  assert.ok(a.off > 200 && a.off < 300, 'it takes the connected trail and walks 250 m off it');
  assert.ok(Number.isFinite(a.total));
});

test('approach: a trail route inside the bushwhack limit is preferred to a faster bushwhack', async () => {
  /* The car reaches a point 1 km from the cell: straight in is ~45 min of brush. A trail from the road
     passes 180 m from the cell after ~2.7 km: ~48 min. The trail is taken although it is slower,
     because it keeps the off-trail leg under the limit; and it is only 3 min slower, so no
     alternative is offered. */
  const w = await world([
    way('hwy', line(0, 0, 7000, 0, 28), { type: 'secondary' }),
    way('tr', line(4500, 0, 2000, 1200, 12), { cat: 'trail', type: 'path' }),
  ]);
  const [la, lo] = at(2000, 1000);
  const fastest = N.bestApproach(w.net, w.walk, w.free, la, lo, null);
  assert.ok(fastest.off > 800, `the fastest approach is straight through the brush (${Math.round(fastest.off)} m)`);
  const r = N.approaches(w.net, w.walk, w.free, la, lo, null);
  assert.ok(r.primary.off <= 800, `the approach given stays within 800 m off trail (${Math.round(r.primary.off)} m)`);
  assert.ok(r.primary.total > fastest.total, 'even though it takes longer');
  assert.equal(r.direct, null, 'and a few minutes saved is not worth offering the bushwhack');
});

test('approach: a direct bushwhack that saves a lot is offered alongside, never instead', async () => {
  /* the same, with the trail starting 6 km along the road: ~70 min against ~45 straight in */
  const w = await world([
    way('hwy', line(0, 0, 7000, 0, 28), { type: 'secondary' }),
    way('tr', line(6000, 0, 2000, 1200, 16), { cat: 'trail', type: 'path' }),
  ]);
  const [la, lo] = at(2000, 1000);
  const r = N.approaches(w.net, w.walk, w.free, la, lo, null);
  assert.ok(r.primary.off <= 800, 'the approach given stays on the network as far as it can');
  assert.ok(r.direct && r.direct.off > 800, 'and the straight line through the brush is offered as an alternative');
  assert.ok(r.primary.total - r.direct.total >= N.DIRECT_SAVES_MIN);
});

test('route: the route is the edges walked, start to finish, ending where the off-trail line leaves', async () => {
  const w = await world([
    way('hwy', line(0, 0, 1000, 0), { type: 'secondary' }),
    way('fr', line(1000, 0, 1000, 6000, 30)),
  ], [at(1000, 2000)]);
  const [la, lo] = at(1200, 5500);
  const a = N.bestApproach(w.net, w.walk, w.free, la, lo, null);
  const r = N.routeOf(w.net, w.walk, a);
  const walked = r.edges.reduce((s, e) => s + w.net.eLen[e], 0);
  assert.ok(Math.abs(walked + Math.abs(a.arc - (w.net.eU[a.edge] === a.from ? w.net.eA0[a.edge] : w.net.eA1[a.edge])) - a.on) < 1,
    'the edges plus the partial last edge add up to the on-network distance');
  const gate = at(1000, 2000);
  assert.ok(Math.abs(r.start[0] - gate[0]) < 1e-4, 'and the route starts at the gate');
  const driveUp = N.routeOf(w.net, w.walk, N.bestApproach(w.net, w.walk, w.free, ...at(1050, 1000), null));
  assert.equal(driveUp.edges.length, 0, 'a drive-up has no walked edges');
});

test('approach: off trail costs three times trail, climb twice as much', () => {
  assert.equal(N.OFF_TRAIL_FACTOR, 3);
  assert.equal(N.OFF_CLIMB_FACTOR, 2);
  assert.ok(Math.abs(N.walkMinutes(4000, 0) - 60) < 1e-9, '4 km on trail is an hour');
  assert.ok(Math.abs(N.walkMinutes(0, 100) - 10) < 1e-9, '100 m of climb is ten minutes');
  assert.ok(Math.abs(N.offMinutes(4000 / 3, 0) - 60) < 1e-9, 'a third of that off trail is an hour');
  assert.ok(Math.abs(N.offMinutes(0, 100) - 20) < 1e-9);
});

test('walk: motorways are driven, never walked', async () => {
  const w = await world([
    way('i5', line(0, 0, 5000, 0, 20), { type: 'motorway' }),
    way('a', line(0, 0, 0, 500), { cat: 'trail', type: 'path' }),
  ]);
  const a = approach(w, 2500, 100);
  assert.ok(a.off > 150, 'no standing on the interstate: the cell is reached from the trail, off trail');
});

test('gates: a gate never lands on a junction, so it cannot block the road it branches from', async () => {
  const w = await world([
    way('hwy', line(0, 0, 2000, 0), { type: 'secondary' }),
    way('spur', line(1000, 0, 1000, 1500)),
    way('main', line(2000, 0, 2000, 3000, 12)),
  ], [at(1000, 1)]);                                              // mapped right at the junction
  const beyond = approach(w, 2050, 2900);
  assert.equal(beyond.on, 0, 'the main road past the junction is still drivable');
  const spur = approach(w, 1050, 1400);
  assert.ok(spur.on > 1300, 'the spur itself is gated');
});
