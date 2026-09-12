/* Per-cell mode figures, from the route network in access-network.mjs.
 *
 * Hike and drive; bike follows on the same network. For every cell:
 *   hike    — the walk from wherever a car can get to, the way a forager would take it
 *   drive   — the drive from the nearest paved road, and the walk that is left after it
 *   worst   — the same walk from the nearest paved road, for when the gravel is gated after all
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
import { buildNetwork, carReach, carDrive, walkFrom, approaches, driveApproaches, routeOf, stopReason,
         drivable, paved } from './access-network.mjs';
import { STOP, encodeGeom } from '../src/access.mjs';

const M_LAT = 111320;
const mLon = lat => 111320 * Math.cos(lat * Math.PI / 180);

/* ways: Map id -> way (after the rules). cells: Map "i:j" -> [lat, lon, elevationM].
   deps: elevationOf(geom) -> metres per vertex; offTrailClimb(from, to) -> metres or -1. */
export async function computeModes(ways, cells, { gates = [], elevationOf, offTrailClimb, log = () => {}, onJoin = null } = {}) {
  const list = [];
  for (const [id, w] of ways) list.push({ id, geom: w.geom, cat: w.cat, type: w.type, pv: w.pv, ac: w.ac, name: w.name, ref: w.ref });
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

  let drvE = 0, drvReached = 0;
  for (let e = 0; e < net.E; e++) if (drivable(net.W[net.eW[e]])) { drvE++; if (inR(net.eU[e]) && inR(net.eV[e])) drvReached++; }
  const stats = { ...net.st, car_reached_nodes: car.reach.reduce((a, b) => a + b, 0), paved_seeds: car.seeds,
    drivable_edges: drvE, drivable_edges_reached: drvReached, cells: 0, hike: 0, worst: 0, direct: 0,
    drive: 0, drive_to_the_point: 0, drive_same_park: 0,
    stops: { none: 0, gate: 0, private: 0, rough: 0, end: 0 },
    drive_stops: { none: 0, gate: 0, private: 0, rough: 0, end: 0 } };
  log('modes      car reaches ' + (100 * drvReached / Math.max(1, drvE)).toFixed(1) + '% of drivable road from pavement');

  const out = new Map();
  const parts = async (a, lat, lon) => a ? { on: Math.round(a.on), onUp: Math.round(a.onUp), off: Math.round(a.off),
    offUp: await offTrailClimb(a.point, [lat, lon]) } : null;
  for (const [key, [lat, lon, elev]] of cells) {
    stats.cells++;
    const hA = approaches(net, hike, hikeFree, lat, lon, () => elev);
    const wA = approaches(net, worst, worstFree, lat, lon, () => elev);
    const dA = driveApproaches(net, drv, driveWalk, lat, lon, () => elev);
    if (!hA.primary && !wA.primary && !dA.primary) continue;
    const rec = { hike: await parts(hA.primary, lat, lon), worst: await parts(wA.primary, lat, lon),
                  direct: await parts(hA.direct, lat, lon), park: null, stop: STOP.none, route: null,
                  drive: null, driveRoute: null };
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
    if (rec.worst) stats.worst++;
    if (rec.direct) stats.direct++;
    out.set(key, rec);
    if (stats.cells % 10000 === 0) log('modes      ' + stats.cells.toLocaleString() + ' cells');
  }
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
  const index = new Map(), edges = [], cellsOut = [], driveOut = [];
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
  }
  cellsOut.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  driveOut.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { edges, cells: cellsOut, driveCells: driveOut };
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
  return { edges, cells, driveCells };
}

/* A v6 row's mode columns for one cell, in the order src/access.mjs decodes them. */
export function modeColumns(rec) {
  const h = rec && rec.hike, w = rec && rec.worst, d = rec && rec.direct, v = rec && rec.drive;
  return [
    ...(h ? [h.on, h.onUp, h.off, h.offUp, rec.park ? rec.park[0] : 0, rec.park ? rec.park[1] : 0, rec.stop] : [-1, -1, -1, -1, 0, 0, -1]),
    ...(w ? [w.on, w.onUp, w.off, w.offUp] : [-1, -1, -1, -1]),
    ...(d ? [d.on, d.onUp, d.off, d.offUp] : [-1, -1, -1, -1]),
    ...(v ? [v.paved, v.graded, v.rough, v.up, v.walk.on, v.walk.onUp, v.walk.off, v.walk.offUp,
             v.park[0], v.park[1], v.stop] : [-1, -1, -1, -1, -1, -1, -1, -1, 0, 0, -1]),
  ];
}
