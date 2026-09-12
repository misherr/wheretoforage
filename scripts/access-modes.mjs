/* Per-cell mode figures, from the route network in access-network.mjs.
 *
 * All three modes. For every cell:
 *   hike    — the walk from wherever a car can get to, the way a forager would take it
 *   drive   — the drive from the nearest paved road, and the walk that is left after it
 *   bike    — the ride from where the car stops, and the walk that is left after that
 *   moto    — the same on a dirt bike, which is faster, stopped by the closed-roads layer, and only
 *             on singletrack the Forest Service records as open to motorcycles
 *   worst   — the same walk from the nearest paved road, for when the gravel is gated after all,
 *             and per RIDING mode the same premise ridden rather than walked: a gate stops the car,
 *             not the machine, which is the whole reason one is in the truck
 *   direct  — straight through the brush, when that saves DIRECT_SAVES_MIN or more over `hike`
 * each as { on, onUp, off, offUp } in metres, plus where the car stops, why, and the route walked,
 * so the tap sheet can draw the line its figures describe.
 *
 * Hike and drive can name different places to leave the car: the hike chooses on foot minutes alone,
 * the drive on the whole journey. Where they agree, and they usually do, the drive's walk is the
 * hike's and the routes file stores it once.
 *
 * The minutes and the difficulty bucket are NOT stored: the app computes them from these parts with
 * the constants in src/access.mjs, so the thresholds can move without a re-bake. */
import { buildNetwork, carReach, carDrive, walkFrom, approaches, driveApproaches, vehicleApproaches,
         bikeRide, bikeBlocks, motoRide, motoBlocks, rideStopReason, vehiclePathTo, routeOf, stopReason,
         drivable, paved } from './access-network.mjs';
import { STOP, encodeGeom, routeShardKey, RIDE_MODES } from '../src/access.mjs';

const M_LAT = 111320;
const mLon = lat => 111320 * Math.cos(lat * Math.PI / 180);

/* ways: Map id -> way (after the rules). cells: Map "i:j" -> [lat, lon, elevationM].
   deps: elevationOf(geom) -> metres per vertex; offTrailClimb(from, to) -> metres or -1. */
export async function computeModes(ways, cells, { gates = [], wilderness = null, elevationOf, offTrailClimb,
                                                  log = () => {}, onJoin = null } = {}) {
  const list = [];
  /* Every field the network reads, and it reads more than the categories: `ml` decides a drive's
     speed, `bk` and `closed` whether a bike may use the way at all. Copying by hand is how three of
     them went missing once — if you add a rule that stamps a way, add it here. */
  for (const [id, w] of ways) list.push({ id, geom: w.geom, cat: w.cat, type: w.type, pv: w.pv, ac: w.ac,
                                          ml: w.ml, bk: w.bk, closed: w.closed, name: w.name, ref: w.ref });
  const net = await buildNetwork(list, { gates, elevationOf, log, onJoin });   // onJoin: the audit seam, see access-network.mjs
  const car = carReach(net);
  const inR = n => car.reach[n] === 1;
  const all = Array.from({ length: net.nNodes }, (_, n) => n);
  const hikeFree = (e, u, v) => drivable(net.W[net.eW[e]]) && inR(u) && inR(v);
  const hike = walkFrom(net, all.filter(inR), hikeFree);
  const pavedNode = new Uint8Array(net.nNodes);
  for (let e = 0; e < net.E; e++) if (paved(net.W[net.eW[e]])) { pavedNode[net.eU[e]] = 1; pavedNode[net.eV[e]] = 1; }
  const worstFree = (e, u, v) => paved(net.W[net.eW[e]]) && pavedNode[u] && pavedNode[v];
  const worst = walkFrom(net, all.filter(n => pavedNode[n]), worstFree);
  /* The drive: minutes from the nearest paved road to every node a car can reach, then a walk seeded
     with that cost, so one Dijkstra answers "drive as deep as it pays to, then walk". Nothing is free
     here — going deeper by road costs road minutes, which is the whole point of the figure. */
  const drv = carDrive(net);
  const driveWalk = walkFrom(net, all.filter(n => isFinite(drv.min[n])), () => false, n => drv.min[n]);
  /* The bike starts where the car stops, rides what it is allowed to ride, and walks the rest. The
     blocks are per edge — a trail crosses a wilderness boundary mid-way. */
  const blocks = bikeBlocks(net, { wilderness });
  const ride = bikeRide(net, all.filter(inR), blocks, hikeFree);   // carried by the car to any point it can reach
  const rideWalk = walkFrom(net, all.filter(n => isFinite(ride.min[n])), () => false, n => ride.min[n]);
  log('modes      bike blocks: ' + JSON.stringify(blocks.stats));
  /* The dirt bike: the same two phases, its own blocks, and its own speeds. */
  const mBlocks = motoBlocks(net, { wilderness });
  const moto = motoRide(net, all.filter(inR), mBlocks, hikeFree);
  const motoWalk = walkFrom(net, all.filter(n => isFinite(moto.min[n])), () => false, n => moto.min[n]);
  log('modes      moto blocks: ' + JSON.stringify(mBlocks.stats));

  /* The two riders take the same shape, so they take the same code from here on: what differs is
     upstream, in what each may use and how fast it goes. */
  const RIDERS = [{ mode: 'bike', rideFn: bikeRide, veh: ride, walk: rideWalk, blocks },
                  { mode: 'moto', rideFn: motoRide, veh: moto, walk: motoWalk, blocks: mBlocks }];

  /* Each rider's own worst case: the same premise as the walker's — the gravel is gated where nobody
     mapped a gate, so the car gets no further than the pavement — but RIDDEN. It is the same two-phase
     computation as the figure above it with one thing changed, the sources: the pavement instead of
     wherever the car reached. Everything else holds, so the bound is still a bound — a road the Forest
     Service has closed to motor vehicles still stops the dirt bike whatever the gravel is doing.

     The walker's version of this bound is right for the hike and for the drive, which a closure
     strands on foot at the pavement either way, and it is in the base file for both. It was wrong for
     the two riding modes by an order of magnitude: at Deming it read 5.5 h under the dirt bike. */
  const pavedList = all.filter(n => pavedNode[n]);
  for (const r of RIDERS) {
    r.wVeh = r.rideFn(net, pavedList, r.blocks, worstFree);
    r.wWalk = walkFrom(net, all.filter(n => isFinite(r.wVeh.min[n])), () => false, n => r.wVeh.min[n]);
  }

  let drvE = 0, drvReached = 0;
  for (let e = 0; e < net.E; e++) if (drivable(net.W[net.eW[e]])) { drvE++; if (inR(net.eU[e]) && inR(net.eV[e])) drvReached++; }
  const stats = { ...net.st, car_reached_nodes: car.reach.reduce((a, b) => a + b, 0), paved_seeds: car.seeds,
    drivable_edges: drvE, drivable_edges_reached: drvReached, cells: 0, hike: 0, worst: 0, direct: 0,
    drive: 0, drive_to_the_point: 0, drive_same_park: 0,
    bike: 0, bike_no_ride: 0, bike_blocks: null,
    moto: 0, moto_no_ride: 0, moto_blocks: null, moto_trail_miles: null,
    bike_worst: 0, moto_worst: 0, bike_worst_stops: {}, moto_worst_stops: {},
    /* What the rider's bound comes to, PER MODE — a median over both riders together would be quoted
       later as one of them — and the two checks that say it is a bound at all: never quicker than the
       mode's own figure (it starts further back), never slower than walking from the same pavement (a
       rider may push). Those two are measured on the ROUTER's totals, which carry an ESTIMATED
       off-trail climb while the stored figures carry a measured one, so they are not the same count as
       the one docs/verification.md takes off the finished files. Counted rather than thrown on: the
       approach scan may choose different points for the two, and a wave of violations would be the
       bug, not a handful. */
    worst_ride: { faster_than_figure: 0, slower_than_walking: 0,
                  bike: { quicker: 0, saved_p50: null, saved_p90: null, saved_over_15: 0, no_ride: 0 },
                  moto: { quicker: 0, saved_p50: null, saved_p90: null, saved_over_15: 0, no_ride: 0 } },
    stops: { none: 0, gate: 0, private: 0, rough: 0, end: 0 },
    drive_stops: { none: 0, gate: 0, private: 0, rough: 0, end: 0 },
    bike_stops: {}, moto_stops: {} };
  stats.bike_blocks = blocks.stats;
  stats.moto_blocks = mBlocks.stats;
  /* What the designation rule leaves out, in miles, so the sheet can say it rather than let a rider
     assume the trails are not there. A conservative mode has to be legible as conservative. */
  {
    const seg = g => { let s = 0; for (let i = 1; i < g.length; i++)
      s += Math.hypot((g[i][1] - g[i - 1][1]) * mLon(g[i - 1][0]), (g[i][0] - g[i - 1][0]) * M_LAT); return s; };
    const mi = { designated_mi: 0, undesignated_mi: 0, nonmotorized_mi: 0, osm_only_mi: 0 };
    for (const [id, w] of ways) {
      if (w.cat !== 'trail' || !w.geom || w.geom.length < 2) continue;
      const d = seg(w.geom) / 1609.34;
      if (w.mo === 1) mi.designated_mi += d;
      else if (id[0] !== 'u') mi.osm_only_mi += d;
      else if (w.mo === 0) mi.nonmotorized_mi += d;
      else mi.undesignated_mi += d;
    }
    for (const k of Object.keys(mi)) mi[k] = Math.round(mi[k]);
    stats.moto_trail_miles = mi;
    log('modes      moto trail miles: ' + JSON.stringify(mi));
  }
  log('modes      car reaches ' + (100 * drvReached / Math.max(1, drvE)).toFixed(1) + '% of drivable road from pavement');

  const out = new Map();
  const saved = { bike: [], moto: [] };   // minutes each rider's bound beats the walker's, summarised below
  const parts = async (a, lat, lon) => a ? { on: Math.round(a.on), onUp: Math.round(a.onUp), off: Math.round(a.off),
    offUp: await offTrailClimb(a.point, [lat, lon]) } : null;
  for (const [key, [lat, lon, elev]] of cells) {
    stats.cells++;
    const hA = approaches(net, hike, hikeFree, lat, lon, () => elev);
    const wA = approaches(net, worst, worstFree, lat, lon, () => elev);
    const dA = driveApproaches(net, drv, driveWalk, lat, lon, () => elev);
    const rA = RIDERS.map(r => vehicleApproaches(net, r.veh, r.walk, lat, lon, () => elev));
    if (!hA.primary && !wA.primary && !dA.primary && !rA.some(a => a.primary)) continue;
    const rec = { hike: await parts(hA.primary, lat, lon), worst: await parts(wA.primary, lat, lon),
                  direct: await parts(hA.direct, lat, lon), park: null, stop: STOP.none, route: null,
                  drive: null, driveRoute: null, bike: null, bikeRoute: null, moto: null, motoRoute: null };
    if (hA.primary) {
      stats.hike++;
      const s = hA.primary.from === 'here' ? -1 : hike.start[hA.primary.from];
      const pt = s >= 0 ? net.nodePt[s] : hA.primary.point;
      rec.park = [Math.round((pt[1] - lon) * mLon(lat)), Math.round((pt[0] - lat) * M_LAT)];   // metres east, north
      const why = s >= 0 ? stopReason(net, s) : 'none';
      rec.stop = STOP[why]; stats.stops[why]++;
      rec.route = routeOf(net, hike, hA.primary);
    }
    if (dA.primary) {
      const d = dA.primary;
      stats.drive++;
      if (d.from === 'drive') stats.drive_to_the_point++;
      const why = d.stopNode >= 0 ? stopReason(net, d.stopNode) : 'none';
      /* The off-trail climb is the same measurement the hike's leg gets, and the same number when the
         two approaches leave the route at the same place — which is most of them. */
      const sameEnd = hA.primary && Math.abs(hA.primary.arc - d.arc) < 1 && hA.primary.edge === d.edge;
      rec.drive = { paved: Math.round(d.drive.paved), graded: Math.round(d.drive.graded), rough: Math.round(d.drive.rough),
                    up: Math.round(d.drive.up), stop: STOP[why],
                    park: [Math.round((d.park[1] - lon) * mLon(lat)), Math.round((d.park[0] - lat) * M_LAT)],
                    walk: { on: Math.round(d.on), onUp: Math.round(d.onUp), off: Math.round(d.off),
                            offUp: sameEnd && rec.hike ? rec.hike.offUp : await offTrailClimb(d.point, [lat, lon]) } };
      stats.drive_stops[why]++;
      if (rec.park && rec.drive.park[0] === rec.park[0] && rec.drive.park[1] === rec.park[1]) stats.drive_same_park++;
      rec.driveRoute = routeOf(net, driveWalk, d);
    }
    for (let n = 0; n < RIDERS.length; n++) {
      const r = RIDERS[n], A = rA[n], mode = r.mode, veh = r.veh, vWalk = r.walk, blk = r.blocks;
      if (!A.primary) continue;
      const b = A.primary;
      stats[mode]++;
      const why = b.stopNode >= 0 ? rideStopReason(net, b.stopNode, blk) : STOP.none;
      const sameEnd = hA.primary && hA.primary.edge === b.edge && Math.abs(hA.primary.arc - b.arc) < 1;
      const at = p => [Math.round((p[1] - lon) * mLon(lat)), Math.round((p[0] - lat) * M_LAT)];
      rec[mode] = { road: Math.round(b.drive.road), rough: Math.round(b.drive.rough), trail: Math.round(b.drive.trail),
                    up: Math.round(b.drive.up), stop: why,
                    park: at(b.source || b.park), dismount: at(b.park),
                    walk: { on: Math.round(b.on), onUp: Math.round(b.onUp), off: Math.round(b.off),
                            offUp: sameEnd && rec.hike ? rec.hike.offUp : await offTrailClimb(b.point, [lat, lon]) } };
      stats[mode + '_stops'][why] = (stats[mode + '_stops'][why] || 0) + 1;
      if (rec[mode].road + rec[mode].rough + rec[mode].trail === 0) stats[mode + '_no_ride']++;
      /* And this rider's worst case. The off-trail climb is the measured one whenever the worst-case
         approach leaves the network at the same place as a leg already measured, which is most of
         them — the ride ends at the same blocked edge, it only takes longer to get there. */
      const wR = vehicleApproaches(net, r.wVeh, r.wWalk, lat, lon, () => elev);
      if (wR.primary) {
        const q = wR.primary, near = a => a && a.edge === q.edge && Math.abs(a.arc - q.arc) < 1;
        const walk = { on: Math.round(q.on), onUp: Math.round(q.onUp), off: Math.round(q.off),
                       offUp: near(b) ? rec[mode].walk.offUp
                            : near(hA.primary) && rec.hike ? rec.hike.offUp
                            : await offTrailClimb(q.point, [lat, lon]) };
        rec[mode].worst = { road: Math.round(q.drive.road), rough: Math.round(q.drive.rough),
                            trail: Math.round(q.drive.trail), up: Math.round(q.drive.up), walk,
                            stop: q.stopNode >= 0 ? rideStopReason(net, q.stopNode, blk) : STOP.none };
        stats[mode + '_worst']++;
        stats[mode + '_worst_stops'][rec[mode].worst.stop] = (stats[mode + '_worst_stops'][rec[mode].worst.stop] || 0) + 1;
        const ws = stats.worst_ride;
        if (wR.primary.total < A.primary.total - 1) ws.faster_than_figure++;
        if (wA.primary && wR.primary.total > wA.primary.total + 1) ws.slower_than_walking++;
        if (!(q.drive.road + q.drive.rough + q.drive.trail >= 100)) ws[mode].no_ride++;
        /* The median is over the cells where the bound DIFFERS. Including the ones with nothing to
           ride, where the saving is zero by construction, made it 41 min against the 58 the same
           figure comes to off the finished files — one name over two populations. */
        if (wA.primary) {
          const s = wA.primary.total - wR.primary.total;
          if (s > 1) { ws[mode].quicker++; saved[mode].push(s); if (s >= 15) ws[mode].saved_over_15++; }
        }
      }
      /* The ride IS drawn, unlike the drive: riding past a gate is what the figure is about. */
      rec[mode + 'Route'] = { edges: [...vehiclePathTo(net, veh, b.stopNode >= 0 ? b.stopNode : b.edgeFrom),
                                      ...(b.from === 'drive' ? [] : routeOf(net, vWalk, b).edges)],
                              last: b.edge, lastFrom: b.edgeFrom >= 0 ? b.edgeFrom : null, end: b.point,
                              start: b.source || b.park };
    }
    if (rec.worst) stats.worst++;
    if (rec.direct) stats.direct++;
    out.set(key, rec);
    if (stats.cells % 10000 === 0) log('modes      ' + stats.cells.toLocaleString() + ' cells');
  }
  for (const mode of RIDE_MODES) {
    const s = saved[mode]; if (!s.length) continue;
    s.sort((a, b) => a - b);
    const at = p => Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]);
    stats.worst_ride[mode].saved_p50 = at(0.5); stats.worst_ride[mode].saved_p90 = at(0.9);
  }
  for (const mode of RIDE_MODES) {
    const w = stats.worst_ride[mode];
    log('modes      ' + mode + ' if the gravel is gated: ' + stats[mode + '_worst'].toLocaleString()
      + ' cells, ' + w.quicker.toLocaleString() + ' of them quicker than walking from the same pavement'
      + ' by a median ' + w.saved_p50 + ' min (p90 ' + w.saved_p90 + '), 15 min or more for '
      + w.saved_over_15.toLocaleString() + '; ' + w.no_ride.toLocaleString()
      + ' with nothing rideable leaving the pavement');
  }
  log('modes      and the bound is a bound, on the router\'s own totals: '
    + stats.worst_ride.faster_than_figure + ' quicker than the figure they bound, '
    + stats.worst_ride.slower_than_walking + ' slower than walking');
  return { modes: out, net, stats };
}

/* The polyline of an edge between two arcs of its way, in either direction. */
function edgeLine(net, e, a0, a1) {
  const wi = net.eW[e], g = net.W[wi].geom, c = net.cum[wi];
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  const at = a => { let i = 1; while (i < c.length - 1 && c[i] < a) i++;
    const t = (a - c[i - 1]) / ((c[i] - c[i - 1]) || 1);
    return [g[i - 1][0] + (g[i][0] - g[i - 1][0]) * t, g[i - 1][1] + (g[i][1] - g[i - 1][1]) * t]; };
  const pts = [at(lo)];
  for (let i = 0; i < c.length; i++) if (c[i] > lo && c[i] < hi) pts.push(g[i]);
  pts.push(at(hi));
  return a0 <= a1 ? pts : pts.reverse();
}

/* The routes file: every edge any cell's route uses, once, and per cell the list of them plus the
   partial last edge up to where the off-trail line leaves. Fetched by the app only when someone asks
   to see an approach — 91,054 edges and ~1.9 MB of geometry statewide at the first measurement. */
export function routesFile(net, modes) {
  const index = new Map(), edges = [], cellsOut = [], driveOut = [], bikeOut = [], motoOut = [];
  const encodeRoute = (key, r) => {
    if (!r || r.lastFrom == null) return null;
    const ids = r.edges.map(e => { let k = index.get(e); if (k === undefined) { k = edges.length; index.set(e, k); edges.push(encodeGeom(edgeLine(net, e, net.eA0[e], net.eA1[e]))); } return k; });
    const e = r.last, fromArc = net.eU[e] === r.lastFrom ? net.eA0[e] : net.eA1[e];
    const wi = net.eW[e], c = net.cum[wi], g = net.W[wi].geom;
    /* The arc of the end point on the last edge, by exact projection onto each segment. Sampling twenty
       points a segment, as the first version did, left 44 routes more than 50 m off their hike figure
       — up to 231 m, on long straight segments where twenty samples are 250 m apart. */
    const lo = Math.min(net.eA0[e], net.eA1[e]), hi = Math.max(net.eA0[e], net.eA1[e]);
    let best = Infinity, endArc = fromArc;
    for (let i = 1; i < g.length; i++) {
      if (c[i] < lo || c[i - 1] > hi) continue;
      const k = mLon(r.end[0]);
      const ax = (g[i - 1][1] - r.end[1]) * k, ay = (g[i - 1][0] - r.end[0]) * M_LAT;
      const bx = (g[i][1] - r.end[1]) * k, by = (g[i][0] - r.end[0]) * M_LAT;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
      const a = Math.max(lo, Math.min(hi, c[i - 1] + t * (c[i] - c[i - 1])));
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < best) { best = d; endArc = a; }
    }
    const [i, j] = key.split(':').map(Number);
    return [i, j, ids, encodeGeom(edgeLine(net, e, fromArc, endArc))];
  };
  for (const [key, rec] of modes) {
    const hike = encodeRoute(key, rec.route);
    if (hike) cellsOut.push(hike);
    /* The drive's walk, only where it is not the hike's: the app falls back to the hike entry, which
       is the same line whenever the two approaches leave the car in the same place. Compared by value
       — the first version compared the two encoded tails with !==, which is never true of two arrays,
       and stored all 25,999 of them. */
    const drive = encodeRoute(key, rec.driveRoute);
    const same = r => JSON.stringify(r[2]) + '|' + JSON.stringify(r[3]);
    if (drive && (!hike || same(drive) !== same(hike))) driveOut.push(drive);
    /* The bike's line is the ride and then the walk, so it is rarely the hike's; stored whenever it
       differs, on the same rule. */
    const bike = encodeRoute(key, rec.bikeRoute);
    if (bike && (!hike || same(bike) !== same(hike))) bikeOut.push(bike);
    const moto = encodeRoute(key, rec.motoRoute);
    if (moto && (!hike || same(moto) !== same(hike)) && (!bike || same(moto) !== same(bike))) motoOut.push(moto);
  }
  for (const list of [cellsOut, driveOut, bikeOut, motoOut]) list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { edges, cells: cellsOut, driveCells: driveOut, bikeCells: bikeOut, motoCells: motoOut };
}

/* The routes, split into the regional files the app fetches one of. Each shard carries its own edge
   table: an edge used from two shards is stored twice, which measured at 2% of the total and buys a
   tap that costs kilobytes instead of megabytes. */
export function shardRoutes(routes) {
  const out = new Map();
  const put = (list, c) => {
    const key = routeShardKey(c[0], c[1]);
    let s = out.get(key);
    if (!s) out.set(key, s = { edges: [], index: new Map(), cells: [], driveCells: [], bikeCells: [], motoCells: [] });
    const ids = c[2].map(e => {
      let n = s.index.get(e);
      if (n === undefined) { n = s.edges.length; s.index.set(e, n); s.edges.push(routes.edges[e]); }
      return n;
    });
    s[list].push([c[0], c[1], ids, c[3]]);
  };
  for (const c of routes.cells) put('cells', c);
  for (const c of (routes.driveCells || [])) put('driveCells', c);
  for (const c of (routes.bikeCells || [])) put('bikeCells', c);
  for (const c of (routes.motoCells || [])) put('motoCells', c);
  for (const s of out.values()) delete s.index;
  return out;
}

/* A regional re-bake's routes replace its own cells' and carry the rest through, with the carried
   cells' edges re-pointed into the combined table — the same rule mergeInto applies to the ways. `mine`
   is every cell the regional bake covered, routed or not: a cell in the region that lost its route
   must lose the old one too. */
export function mergeRoutes(prev, fresh, mine) {
  const edges = fresh.edges.slice(), remap = new Map();
  const carry = (prevList, freshList) => {
    const out = (freshList || []).slice();
    for (const c of (prevList || [])) {
      if (mine.has(c[0] + ':' + c[1])) continue;
      const ids = c[2].map(e => { let k = remap.get(e); if (k === undefined) { k = edges.length; remap.set(e, k); edges.push(prev.edges[e]); } return k; });
      out.push([c[0], c[1], ids, c[3]]);
    }
    return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  };
  const cells = carry(prev.cells, fresh.cells);
  const driveCells = carry(prev.driveCells, fresh.driveCells);
  const bikeCells = carry(prev.bikeCells, fresh.bikeCells);
  const motoCells = carry(prev.motoCells, fresh.motoCells);
  return { edges, cells, driveCells, bikeCells, motoCells };
}

/* The worst case, which goes in the BASE file because it is the same walk whichever mode is on
   screen, and every mode's block shows it. */
export function worstColumns(rec) {
  const w = rec && rec.worst;
  return w ? [w.on, w.onUp, w.off, w.offUp] : [-1, -1, -1, -1];
}

/* One mode's columns for one cell, in the order src/access.mjs decodes them — v9 keeps each mode in
   its own file, so these are rows of their own rather than a slice of a wide one. */
export function modeColumns(mode, rec) {
  if (mode === 'hike') {
    const h = rec && rec.hike, d = rec && rec.direct;
    return [
      ...(h ? [h.on, h.onUp, h.off, h.offUp, rec.park ? rec.park[0] : 0, rec.park ? rec.park[1] : 0, rec.stop]
            : [-1, -1, -1, -1, 0, 0, -1]),
      ...(d ? [d.on, d.onUp, d.off, d.offUp] : [-1, -1, -1, -1]),
    ];
  }
  if (mode === 'drive') {
    const v = rec && rec.drive;
    return v ? [v.paved, v.graded, v.rough, v.up, v.walk.on, v.walk.onUp, v.walk.off, v.walk.offUp,
                v.park[0], v.park[1], v.stop] : [-1, -1, -1, -1, -1, -1, -1, -1, 0, 0, -1];
  }
  const k = rec && rec[mode];
  if (!k) return [-1, -1, -1, -1, -1, -1, -1, -1, 0, 0, 0, 0, -1, ...new Array(9).fill(-1)];
  /* The walk left after the worst-case ride is usually the mode figure's own — the ride ends at the
     same blocked edge, it just started further back — so it is stored once, and -1 in its first
     column means "that walk". A walk of zero metres is a real answer here, which is why the sentinel
     is negative. */
  const w = k.worst;
  const same = w && w.walk.on === k.walk.on && w.walk.onUp === k.walk.onUp
                 && w.walk.off === k.walk.off && w.walk.offUp === k.walk.offUp;
  return [k.road, k.rough, k.trail, k.up, k.walk.on, k.walk.onUp, k.walk.off, k.walk.offUp,
          k.park[0], k.park[1], k.dismount[0], k.dismount[1], k.stop,
          ...(w ? [w.road, w.rough, w.trail, w.up,
                   ...(same ? [-1, -1, -1, -1] : [w.walk.on, w.walk.onUp, w.walk.off, w.walk.offUp]), w.stop]
                : new Array(9).fill(-1))];
}
/* Does this cell have anything to say in this mode? A row of -1s is not written. */
export function hasMode(mode, rec) {
  if (!rec) return false;
  if (mode === 'hike') return !!(rec.hike || rec.direct);
  return !!rec[mode];
}
