/* The route network: every fetched way, joined where ways meet, so an approach can follow trails,
 * tracks and gated roads THROUGH one another rather than along one named route from its own
 * trailhead. That single-route model is what put "Porter Creek Logging Road, 609 m, drive up" on a
 * cell whose road was gated six miles short — it knew the road, not the network, and nothing about
 * where a car actually stops.
 *
 * Three questions, answered once for the whole state:
 *   1. Where can a car get to? Drivable roads, connected to pavement, stopping at mapped gates and at
 *      private or permit-only roads. Pessimistic on purpose.
 *   2. From there, what does it take on foot to reach each cell? Trails, tracks, closed and gated
 *      roads are all walkable corridors; the last stretch to the cell centre is a straight line off
 *      trail.
 *   3. And if the gravel turns out to be gated where nobody mapped a gate? The same walk, starting
 *      from the nearest PAVED road. That is the Deming failure made visible instead of hidden.
 *
 * Junctions are inferred, not read: the checkpoint holds 25 m-simplified geometry and no node ids,
 * so ways meeting within SNAP_M are joined, a way ending on another's side is joined to it there,
 * and two ways whose lines cross are joined at the crossing. That makes some false connections — a
 * trail passing under a road on a bridge becomes a junction — and misses none that OSM has. The
 * Geofabrik extract in ROADMAP.md would give the true topology.
 *
 * Everything here describes the network AS MAPPED. A gate nobody mapped is not in it. */

import { WALK_KMH, CLIMB_MIN_PER_100M, OFF_TRAIL_FACTOR as OTF, OFF_CLIMB_FACTOR as OCF, BUSHWHACK_M, DIRECT_SAVES_MIN,
         DRIVE_MPH, DRIVE_CLASSES, driveMinutes } from '../src/access.mjs';
export { DIRECT_SAVES_MIN };

const M_LAT = 111320;
const mLon = lat => 111320 * Math.cos(lat * Math.PI / 180);

export const SNAP_M = 15;          // ways whose ends or sides meet within this are joined
export const GATE_SNAP_M = 25;     // a mapped gate this close to a drivable way is on it (25 m = simplification)
export const GATE_OFF_JUNCTION_M = 6;  // a gate is kept this far into its own way, so it never blocks a junction

/* Which ways a car may use, which it may not walk, which count as pavement. */
const LIMITED = /^(motorway|trunk)(_link)?$/;
const PAVED_CLASS = /^(motorway|trunk|primary|secondary|tertiary)(_link)?$/;
const NO_CROSSING_CHECK = /^(residential|living_street|service)$/;   // the town grid; ends join it
export const drivable = w => w.cat === 'road' && !w.ac;
export const walkable = w => !LIMITED.test(w.type || '');
export const paved = w => drivable(w) && (PAVED_CLASS.test(w.type || '') || !!w.pv);

/* ---------- small geometry ---------- */
function cumulative(g) {
  const c = new Float64Array(g.length);
  for (let i = 1; i < g.length; i++) c[i] = c[i - 1] + Math.hypot((g[i][1] - g[i - 1][1]) * mLon(g[i - 1][0]), (g[i][0] - g[i - 1][0]) * M_LAT);
  return c;
}
/* point at arc a along g (with cumulative c) */
function pointAt(g, c, a) {
  if (a <= 0) return g[0];
  if (a >= c[c.length - 1]) return g[g.length - 1];
  let i = 1; while (c[i] < a) i++;
  const t = (a - c[i - 1]) / ((c[i] - c[i - 1]) || 1);
  return [g[i - 1][0] + (g[i][0] - g[i - 1][0]) * t, g[i - 1][1] + (g[i][1] - g[i - 1][1]) * t];
}
/* distance from (la,lo) to segment a-b and the parameter t along it */
function segProj(la, lo, a, b) {
  const k = mLon(la);
  const ax = (a[1] - lo) * k, ay = (a[0] - la) * M_LAT, bx = (b[1] - lo) * k, by = (b[0] - la) * M_LAT;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
  return { d: Math.hypot(ax + t * dx, ay + t * dy), t };
}
/* proper crossing of segments p1-p2 and q1-q2: parameters (s, u) in (0,1), or null */
function crossing(p1, p2, q1, q2) {
  const k = mLon(p1[0]);
  const x1 = p1[1] * k, y1 = p1[0] * M_LAT, x2 = p2[1] * k, y2 = p2[0] * M_LAT;
  const x3 = q1[1] * k, y3 = q1[0] * M_LAT, x4 = q2[1] * k, y4 = q2[0] * M_LAT;
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(den) < 1e-9) return null;
  const s = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
  const u = ((x1 - x3) * (y1 - y2) - (y1 - y3) * (x1 - x2)) / den;
  /* Inclusive: an OSM intersection is a node shared by both ways, and when simplification keeps it
     the lines meet exactly at a vertex of each — the strict test missed every one of those. The same
     crossing found from both adjoining segments is merged later, as points within a metre. */
  const E = 1e-9;
  return s >= -E && s <= 1 + E && u >= -E && u <= 1 + E ? { s: Math.min(1, Math.max(0, s)), u: Math.min(1, Math.max(0, u)) } : null;
}

/* A grid of ~220 m cells. Segments are filed under every cell their box (padded) touches. */
const GY = 0.002, GX = 0.003;
const gkey = (i, j) => i * 1e6 + (j + 500000);
function forBox(s, w, n, e, cb) {
  for (let i = Math.floor(s / GY); i <= Math.floor(n / GY); i++)
    for (let j = Math.floor(w / GX); j <= Math.floor(e / GX); j++) cb(gkey(i, j));
}
function segBox(a, b, padM) {
  const pLa = padM / M_LAT, pLo = padM / mLon(Math.max(a[0], b[0]));
  return [Math.min(a[0], b[0]) - pLa, Math.min(a[1], b[1]) - pLo, Math.max(a[0], b[0]) + pLa, Math.max(a[1], b[1]) + pLo];
}

/* Union-find over split points. */
class UF {
  constructor() { this.p = []; }
  add() { this.p.push(this.p.length); return this.p.length - 1; }
  find(x) { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; } return x; }
  union(a, b) { a = this.find(a); b = this.find(b); if (a !== b) this.p[b] = a; }
}

/* ---------- the network ---------- */

/* ways: array of { id, geom, cat, type, pv, ac, name, ref }. gates: array of [lat, lon].
   elevationOf(geom) -> array of metres (or null) per vertex; injected so this module never fetches.
   Returns the graph plus build statistics, which the bake records in provenance. */
export async function buildNetwork(ways, { gates = [], elevationOf = null, log = () => {}, onJoin = null } = {}) {
  const W = ways.filter(w => w.geom && w.geom.length >= 2);
  const cum = W.map(w => cumulative(w.geom));
  const uf = new UF();
  const pts = W.map(() => []);                 // per way: [{a, id, gate}]
  const addPt = (wi, a, gate = false) => { const id = uf.add(); pts[wi].push({ a, id, gate }); return id; };
  const endPt = W.map((w, wi) => [addPt(wi, 0), addPt(wi, cum[wi][cum[wi].length - 1])]);
  const st = { ways: W.length, end_joins: 0, side_joins: 0, crossings: 0, gates_placed: 0, gates_unplaced: 0, vetoed: 0 };
  /* The audit seam. Every inferred join is offered to `onJoin` before it is made — kind, both ways,
     where it falls on each, how far apart they were, and how far the contact point is from the
     nearest VERTEX of each way, which is the evidence that OSM had a node there. Returning false
     vetoes the join. Measuring the false-junction rate needs the joins the real code makes rather
     than a copy of the rules, and a bridge/tunnel rule would veto through here once those tags are
     fetched. The bake passes nothing, so the default is exactly the behaviour before it existed. */
  const nearVertex = (c, a) => { let d = Infinity; for (let k = 0; k < c.length; k++) { const x = Math.abs(c[k] - a); if (x < d) d = x; } return d; };
  const offer = (kind, wi, wj, ai, aj, d, point) => !onJoin || onJoin({ kind, wi, wj, ai, aj, d, point,
    wid: W[wi].id, wjd: W[wj].id, vi: nearVertex(cum[wi], ai), vj: nearVertex(cum[wj], aj) }) !== false;

  /* segment grid, padded by SNAP_M, for "is an end near a side" */
  const grid = new Map();
  W.forEach((w, wi) => { for (let k = 1; k < w.geom.length; k++) {
    const [s, we, n, e] = segBox(w.geom[k - 1], w.geom[k], SNAP_M);
    forBox(s, we, n, e, key => { let arr = grid.get(key); if (!arr) grid.set(key, arr = []); arr.push(wi, k); });
  } });
  log('network    ' + W.length.toLocaleString() + ' ways, ' + grid.size.toLocaleString() + ' grid cells');

  /* ends: to another way's end, or onto its side */
  W.forEach((w, wi) => {
    for (const which of [0, 1]) {
      const p = which ? w.geom[w.geom.length - 1] : w.geom[0];
      const arr = grid.get(gkey(Math.floor(p[0] / GY), Math.floor(p[1] / GX)));
      if (!arr) continue;
      const best = new Map();                  // other way -> {d, a}
      for (let q = 0; q < arr.length; q += 2) {
        const wj = arr[q]; if (wj === wi) continue;
        const k = arr[q + 1], g = W[wj].geom;
        const r = segProj(p[0], p[1], g[k - 1], g[k]);
        if (r.d > SNAP_M) continue;
        const a = cum[wj][k - 1] + r.t * (cum[wj][k] - cum[wj][k - 1]);
        const b = best.get(wj); if (!b || r.d < b.d) best.set(wj, { d: r.d, a });
      }
      for (const [wj, b] of best) {
        const L = cum[wj][cum[wj].length - 1];
        const end = b.a <= SNAP_M ? 0 : b.a >= L - SNAP_M ? 1 : -1;
        const ai = which ? cum[wi][cum[wi].length - 1] : 0;
        if (!offer(end < 0 ? 'end-side' : 'end-end', wi, wj, ai, end < 0 ? b.a : (end ? L : 0), b.d, p)) { st.vetoed++; continue; }
        if (end === 0) { uf.union(endPt[wi][which], endPt[wj][0]); st.end_joins++; }
        else if (end === 1) { uf.union(endPt[wi][which], endPt[wj][1]); st.end_joins++; }
        else { uf.union(endPt[wi][which], addPt(wj, b.a)); st.side_joins++; }
      }
    }
  });

  /* crossings: two ways whose lines cross, away from their ends. The town grid is left to its ends
     (it is not what an approach runs through), and limited-access roads cross nothing at grade. */
  const cgrid = new Map();
  W.forEach((w, wi) => { if (NO_CROSSING_CHECK.test(w.type || '') || LIMITED.test(w.type || '')) return;
    for (let k = 1; k < w.geom.length; k++) { const [s, we, n, e] = segBox(w.geom[k - 1], w.geom[k], 0);
      forBox(s, we, n, e, key => { let arr = cgrid.get(key); if (!arr) cgrid.set(key, arr = []); arr.push(wi, k); }); } });
  const seen = new Set();
  for (const [key, arr] of cgrid) {
    for (let x = 0; x < arr.length; x += 2) for (let y = x + 2; y < arr.length; y += 2) {
      const wi = arr[x], wj = arr[y]; if (wi === wj) continue;
      const ki = arr[x + 1], kj = arr[y + 1];
      const gi = W[wi].geom, gj = W[wj].geom;
      const c = crossing(gi[ki - 1], gi[ki], gj[kj - 1], gj[kj]);
      if (!c) continue;
      const ai = cum[wi][ki - 1] + c.s * (cum[wi][ki] - cum[wi][ki - 1]);
      const aj = cum[wj][kj - 1] + c.u * (cum[wj][kj] - cum[wj][kj - 1]);
      /* One crossing, however many segment pairs found it: at a shared vertex all four adjoining
         pairs do. Keyed by where it falls on each way, to the metre. */
      const pk = wi < wj ? wi + ':' + Math.round(ai) + ':' + wj + ':' + Math.round(aj) : wj + ':' + Math.round(aj) + ':' + wi + ':' + Math.round(ai);
      if (seen.has(pk)) continue; seen.add(pk);
      const Li = cum[wi][cum[wi].length - 1], Lj = cum[wj][cum[wj].length - 1];
      if (ai < SNAP_M || ai > Li - SNAP_M || aj < SNAP_M || aj > Lj - SNAP_M) continue;   // an end: joined above
      if (!offer('crossing', wi, wj, ai, aj, 0, pointAt(gi, cum[wi], ai))) { st.vetoed++; continue; }
      uf.union(addPt(wi, ai), addPt(wj, aj)); st.crossings++;
    }
  }

  /* gates: onto the nearest drivable way, kept off its junctions */
  for (const [gla, glo] of gates) {
    const arr = grid.get(gkey(Math.floor(gla / GY), Math.floor(glo / GX)));
    let best = null;
    if (arr) for (let q = 0; q < arr.length; q += 2) {
      const wj = arr[q]; if (!drivable(W[wj])) continue;
      const k = arr[q + 1], g = W[wj].geom, r = segProj(gla, glo, g[k - 1], g[k]);
      if (r.d <= GATE_SNAP_M && (!best || r.d < best.d)) best = { d: r.d, wj, a: cum[wj][k - 1] + r.t * (cum[wj][k] - cum[wj][k - 1]) };
    }
    if (!best) { st.gates_unplaced++; continue; }
    const L = cum[best.wj][cum[best.wj].length - 1];
    if (L < 2 * GATE_OFF_JUNCTION_M) { st.gates_unplaced++; continue; }
    addPt(best.wj, Math.min(L - GATE_OFF_JUNCTION_M, Math.max(GATE_OFF_JUNCTION_M, best.a)), true);
    st.gates_placed++;
  }

  /* Split points on one way within a metre of each other are the same place: a crossing found from
     two adjoining segments, or a junction at a vertex. Merged BEFORE nodes are assigned, or a junction
     attached to the second of two near-identical points would be left on a node no edge reaches.
     Gates are never merged: they are placed away from junctions on purpose. */
  W.forEach((w, wi) => {
    const P = pts[wi].sort((x, y) => x.a - y.a);
    for (let i = 1; i < P.length; i++) if (!P[i].gate && !P[i - 1].gate && P[i].a - P[i - 1].a <= 1) uf.union(P[i - 1].id, P[i].id);
  });

  /* nodes and edges */
  const nodeOf = new Map(); let nNodes = 0;
  const nid = id => { const r = uf.find(id); let n = nodeOf.get(r); if (n === undefined) { n = nNodes++; nodeOf.set(r, n); } return n; };
  const eW = [], eA0 = [], eA1 = [], eU = [], eV = [];
  const gateNode = new Set();
  W.forEach((w, wi) => {
    const P = pts[wi].sort((x, y) => x.a - y.a);
    let prev = null;
    for (const p of P) {
      const n = nid(p.id);
      if (p.gate) gateNode.add(n);
      if (prev && n !== prev.n && p.a - prev.a > 0.01) { eW.push(wi); eA0.push(prev.a); eA1.push(p.a); eU.push(prev.n); eV.push(n); }
      if (!prev || n !== prev.n) prev = { a: p.a, n };
    }
  });
  const E = eW.length;
  st.nodes = nNodes; st.edges = E; st.gate_nodes = gateNode.size;

  /* climb, per way: cumulative ascent forward and backward, so any stretch is a subtraction */
  const up = new Array(W.length), down = new Array(W.length), elev = new Array(W.length);
  if (elevationOf) {
    for (let wi = 0; wi < W.length; wi++) {
      const e = await elevationOf(W[wi].geom);
      const c = cum[wi], U = new Float64Array(c.length), D = new Float64Array(c.length);
      for (let i = 1; i < c.length; i++) {
        const run = c[i] - c[i - 1], de = e && e[i] != null && e[i - 1] != null ? e[i] - e[i - 1] : 0;
        const ok = run > 1 && Math.abs(de) / run <= 3.0;           // the same gradient gate as the bake
        U[i] = U[i - 1] + (ok && de > 0 ? de : 0); D[i] = D[i - 1] + (ok && de < 0 ? -de : 0);
      }
      up[wi] = U; down[wi] = D; elev[wi] = e;
    }
  }
  const climbAt = (arr, c, a) => {                                  // interpolate a cumulative array at arc a
    if (!arr) return 0;
    if (a <= 0) return 0; const L = c[c.length - 1]; if (a >= L) return arr[arr.length - 1];
    let i = 1; while (c[i] < a) i++;
    const t = (a - c[i - 1]) / ((c[i] - c[i - 1]) || 1);
    return arr[i - 1] + (arr[i] - arr[i - 1]) * t;
  };
  const eLen = new Float64Array(E), eUpF = new Float64Array(E), eUpB = new Float64Array(E);
  for (let e = 0; e < E; e++) {
    const wi = eW[e], c = cum[wi];
    eLen[e] = eA1[e] - eA0[e];
    eUpF[e] = climbAt(up[wi], c, eA1[e]) - climbAt(up[wi], c, eA0[e]);
    eUpB[e] = climbAt(down[wi], c, eA1[e]) - climbAt(down[wi], c, eA0[e]);
  }
  /* adjacency (CSR) */
  const deg = new Int32Array(nNodes + 1);
  for (let e = 0; e < E; e++) { deg[eU[e] + 1]++; deg[eV[e] + 1]++; }
  for (let i = 0; i < nNodes; i++) deg[i + 1] += deg[i];
  const adj = new Int32Array(2 * E), fill = deg.slice(0, nNodes);
  for (let e = 0; e < E; e++) { adj[fill[eU[e]]++] = e; adj[fill[eV[e]]++] = e; }
  const nodePt = new Array(nNodes);
  for (let e = 0; e < E; e++) {
    const wi = eW[e];
    if (!nodePt[eU[e]]) nodePt[eU[e]] = pointAt(W[wi].geom, cum[wi], eA0[e]);
    if (!nodePt[eV[e]]) nodePt[eV[e]] = pointAt(W[wi].geom, cum[wi], eA1[e]);
  }
  log('network    ' + nNodes.toLocaleString() + ' nodes, ' + E.toLocaleString() + ' edges; ' + JSON.stringify(st));
  return { W, cum, up, down, elev, eW, eA0, eA1, eU, eV, eLen, eUpF, eUpB, deg, adj, nodePt, gateNode, nNodes, E, st, climbAt };
}

/* ---------- where a car can get to ---------- */

/* Breadth-first from every node on a paved, public road, along drivable roads only. A gate node is
   reached — you can drive to a gate — but never passed. */
export function carReach(net) {
  const { W, eW, eU, eV, deg, adj, nNodes, E, gateNode } = net;
  const reach = new Uint8Array(nNodes), seeds = [];
  for (let e = 0; e < E; e++) if (paved(W[eW[e]])) for (const n of [eU[e], eV[e]]) if (!reach[n] && !gateNode.has(n)) { reach[n] = 1; seeds.push(n); }
  const q = seeds.slice();
  while (q.length) {
    const n = q.pop();
    if (gateNode.has(n)) continue;
    for (let k = deg[n]; k < deg[n + 1]; k++) {
      const e = adj[k]; if (!drivable(W[eW[e]])) continue;
      const m = eU[e] === n ? eV[e] : eU[e];
      if (!reach[m]) { reach[m] = 1; q.push(m); }
    }
  }
  return { reach, seeds: seeds.length };
}

/* ---------- by car ---------- */

/* Which speed a way is driven at. The maintenance level is the only field either source has that says
   whether a passenger car belongs on a road, so it decides: 4 and 5 are graded, 3 and every forest
   road nobody rated are rough. Pessimistic where nothing is known, which is the rule this project
   keeps relearning.

   A town street is the exception, and it is a measurement rather than a taste: 61% of the drivable
   network this test calls unpaved is highway=residential, because rural and small-town streets are
   mapped without a surface tag. Timing those at 15 mph made a cell on the far side of a village read
   several minutes deeper into the forest than it is, which is not pessimism — it is wrong about a
   street. A street is graded; an unrated forest road is not.

   Pavement is whatever `paved` already calls pavement, so "from the nearest paved road" means the
   same thing in the drive figure and in the worst case beside it. */
const STREET = /^(residential|living_street)$/;
export const driveClassOf = w => paved(w) ? 'paved'
  : /^[45]/.test(String(w.ml || '')) || STREET.test(w.type || '') ? 'graded' : 'rough';
const DRIVE_M_PER_MIN = {};
for (const c of DRIVE_CLASSES) DRIVE_M_PER_MIN[c] = DRIVE_MPH[c] * 1609.34 / 60;

/* Minutes from the nearest paved road to every node a car can reach, with the metres it drove in each
   class and the climb, so the app can recompute the minutes from stored parts. Same stopping rules as
   carReach: drivable roads only, a gate is reached and never passed, and a private or permit road is
   not drivable at all. */
export function carDrive(net) {
  const { W, eW, eU, eV, eLen, eUpF, eUpB, deg, adj, nNodes, E, gateNode } = net;
  const min = new Float64Array(nNodes).fill(Infinity);
  const legs = { paved: new Float64Array(nNodes), graded: new Float64Array(nNodes), rough: new Float64Array(nNodes), up: new Float64Array(nNodes) };
  const heap = [], push = (c, n) => { heap.push([c, n]); let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0;
    for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  let seeds = 0;
  for (let e = 0; e < E; e++) if (paved(W[eW[e]])) for (const n of [eU[e], eV[e]])
    if (min[n] === Infinity && !gateNode.has(n)) { min[n] = 0; seeds++; push(0, n); }
  while (heap.length) {
    const [c, n] = pop(); if (c > min[n]) continue;
    if (gateNode.has(n)) continue;                       // you may drive to a gate, never through it
    for (let k = deg[n]; k < deg[n + 1]; k++) {
      const e = adj[k], w = W[eW[e]]; if (!drivable(w)) continue;
      const fwd = eU[e] === n, m = fwd ? eV[e] : eU[e];
      const cls = driveClassOf(w), nc = c + eLen[e] / DRIVE_M_PER_MIN[cls];
      if (nc < min[m] - 1e-9) {
        min[m] = nc;
        for (const q of DRIVE_CLASSES) legs[q][m] = legs[q][n];
        legs[cls][m] += eLen[e];
        legs.up[m] = legs.up[n] + (fwd ? eUpF[e] : eUpB[e]);
        push(nc, m);
      }
    }
  }
  return { min, legs, seeds };
}
const legsAt = (drv, n) => ({ paved: drv.legs.paved[n], graded: drv.legs.graded[n], rough: drv.legs.rough[n], up: drv.legs.up[n] });
const plusLeg = (l, cls, m, up) => { const o = { ...l }; o[cls] += m; o.up += Math.max(0, up); return o; };

/* ---------- on foot ---------- */

/* The effort model. The constants live in src/access.mjs, shared with the app, so the route the bake
   chooses and the minutes the sheet shows are one calculation: 4 km/h on anything mapped plus 10 min
   per 100 m of climb; off trail at a third of the speed and twice the climb cost. */
export const WALK_M_PER_MIN = WALK_KMH * 1000 / 60;
export const CLIMB_MIN_PER_M = CLIMB_MIN_PER_100M / 100;
export const OFF_TRAIL_FACTOR = OTF;
export const OFF_CLIMB_FACTOR = OCF;
export const walkMinutes = (m, up) => m / WALK_M_PER_MIN + up * CLIMB_MIN_PER_M;
export const offMinutes = (m, up) => m * OFF_TRAIL_FACTOR / WALK_M_PER_MIN + up * CLIMB_MIN_PER_M * OFF_CLIMB_FACTOR;

/* Multi-source Dijkstra on minutes. `free(e)` says an edge costs nothing (you are driving it);
   `sources` start at `initial(n)`, which is zero for the hike — the car is already there — and the
   drive time for the drive, where getting deeper costs minutes. Tracks, per node, the metres walked,
   the climb, the node the walk started from, and the edge it arrived by — so a figure can be
   explained and a line drawn. */
export function walkFrom(net, sources, free, initial = null) {
  const { W, eW, eU, eV, eLen, eUpF, eUpB, deg, adj, nNodes } = net;
  const cost = new Float64Array(nNodes).fill(Infinity), metres = new Float64Array(nNodes), climb = new Float64Array(nNodes);
  const start = new Int32Array(nNodes).fill(-1), via = new Int32Array(nNodes).fill(-1);
  const heap = [], push = (c, n) => { heap.push([c, n]); let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0;
    for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  for (const n of sources) {
    const c0 = initial ? initial(n) : 0;
    if (!isFinite(c0) || c0 >= cost[n]) continue;
    cost[n] = c0; start[n] = n; push(c0, n);
  }
  while (heap.length) {
    const [c, n] = pop(); if (c > cost[n]) continue;
    for (let k = net.deg[n]; k < net.deg[n + 1]; k++) {
      const e = adj[k], w = W[eW[e]]; if (!walkable(w)) continue;
      const fwd = eU[e] === n, m = fwd ? eV[e] : eU[e];
      const isFree = free(e, n, m);
      const up = fwd ? eUpF[e] : eUpB[e];
      const nc = c + (isFree ? 0 : walkMinutes(eLen[e], up));
      if (nc < cost[m] - 1e-9) {
        cost[m] = nc; metres[m] = metres[n] + (isFree ? 0 : eLen[e]); climb[m] = climb[n] + (isFree ? 0 : up);
        start[m] = isFree ? m : start[n]; via[m] = e; push(nc, m);
      }
    }
  }
  return { cost, metres, climb, start, via };
}

/* ---------- each cell ---------- */

/* The best way onto a cell: some point on some walkable edge within `radiusM` of the centre, reached
   at the lowest total effort — the walk to that point, plus a straight off-trail line to the centre.
   Every edge in range is a candidate, not just the nearest: a slightly farther trail that starts at
   the car usually beats the nearest one that starts miles away.

   `elevAt(lat, lon)` gives the centre's height for the candidate's off-trail climb estimate; the
   winner's off-trail climb is measured properly afterwards by the bake. */
export function bestApproach(net, walk, free, lat, lon, elevAt, radiusM = 2500, maxOffM = Infinity) {
  const r = scanApproaches(net, walk, free, lat, lon, elevAt, radiusM, maxOffM);
  return Number.isFinite(maxOffM) ? r.within : r.fastest;
}

/* Which approach a cell is given. The fastest one that stays within BUSHWHACK_M off trail, if there is
   one; a bushwhack only when there is not. Picking the fastest outright made 27% of cells bushwhack,
   and 5,725 of those had an approach inside 800 m — 2,025 of them for fifteen minutes more or less.
   Under a three-to-one weighting, 900 m of brush from the car can beat 4 km of trail, but that is not
   the approach a forager takes, and the bucket should describe the one they would. Where going
   straight through the brush would save DIRECT_SAVES_MIN or more, it is returned too, so the sheet
   can say so rather than hide it. */
export function approaches(net, walk, free, lat, lon, elevAt, radiusM = 2500, limitM = BUSHWHACK_M) {
  const r = scanApproaches(net, walk, free, lat, lon, elevAt, radiusM, limitM);
  const primary = r.within || r.fastest;
  const direct = r.within && r.fastest && r.fastest !== r.within && r.within.total - r.fastest.total >= DIRECT_SAVES_MIN ? r.fastest : null;
  return { primary, direct };
}

/* Every walkable edge within radiusM of a point, with where the point falls on it and how far off the
   route it leaves you. One scan, shared by the walk and the drive: what differs between the two modes
   is what reaching that point costs, not which points there are. A motorway is not in it — you cannot
   park on one — though the drive may travel one to get there. */
function nearbyEdges(net, lat, lon, radiusM) {
  const { W, cum, eW, eA0, eA1 } = net;
  if (!net.egrid) {                                        // edges by grid cell, unpadded
    net.egrid = new Map();
    for (let e = 0; e < net.E; e++) {
      const wi = eW[e]; if (!walkable(W[wi])) continue;
      const g = W[wi].geom, c = cum[wi];
      let i0 = 1; while (i0 < c.length - 1 && c[i0] <= eA0[e]) i0++;
      const p0 = pointAt(g, c, eA0[e]), p1 = pointAt(g, c, eA1[e]);
      const seq = [p0]; for (let i = i0; i < c.length - 1 && c[i] < eA1[e]; i++) seq.push(g[i]); seq.push(p1);
      for (let k = 1; k < seq.length; k++) { const [s, we, n, ee] = segBox(seq[k - 1], seq[k], 0);
        forBox(s, we, n, ee, key => { let arr = net.egrid.get(key); if (!arr) net.egrid.set(key, arr = []); if (arr[arr.length - 1] !== e) arr.push(e); }); }
    }
  }
  const pLa = radiusM / M_LAT, pLo = radiusM / mLon(lat);
  const cand = new Set();
  forBox(lat - pLa, lon - pLo, lat + pLa, lon + pLo, key => { const arr = net.egrid.get(key); if (arr) for (const e of arr) cand.add(e); });
  const out = [];
  for (const e of cand) {
    const wi = eW[e], g = W[wi].geom, c = cum[wi];
    /* project the point onto this edge's stretch of the way */
    let bd = Infinity, ba = eA0[e];
    for (let k = 1; k < g.length; k++) {
      if (c[k] < eA0[e] || c[k - 1] > eA1[e]) continue;
      const r = segProj(lat, lon, g[k - 1], g[k]);
      const a = Math.max(eA0[e], Math.min(eA1[e], c[k - 1] + r.t * (c[k] - c[k - 1])));
      const q = pointAt(g, c, a);
      const d = Math.hypot((q[1] - lon) * mLon(lat), (q[0] - lat) * M_LAT);
      if (d < bd) { bd = d; ba = a; }
    }
    if (bd > radiusM) continue;
    out.push({ e, arc: ba, off: bd, point: pointAt(g, c, ba) });
  }
  return out;
}

/* The climb a candidate's off-trail leg is judged on: the cell above the point the walk leaves from,
   from the way's own profile. The winner's is measured properly afterwards by the bake. */
function offClimbEst(net, e, arc, hCell) {
  if (hCell == null) return 0;
  const wi = net.eW[e], c = net.cum[wi], el = net.elev && net.elev[wi];
  if (!el) return 0;
  const i = Math.min(net.W[wi].geom.length - 1, Math.max(0, c.findIndex(x => x >= arc)));
  return el[i] == null ? 0 : Math.max(0, hCell - el[i]);
}

function scanApproaches(net, walk, free, lat, lon, elevAt, radiusM, limitM) {
  const { cum, eW, eA0, eA1, eU, eV, climbAt, up, down } = net;
  const hCell = elevAt ? elevAt(lat, lon) : null;
  let best = null, within = null;
  for (const cn of nearbyEdges(net, lat, lon, radiusM)) {
    const e = cn.e, ba = cn.arc, bd = cn.off;
    const wi = eW[e], c = cum[wi], u = eU[e], v = eV[e];
    let on, m, cl, from;
    if (free(e, u, v) && walk.cost[u] === 0 && walk.cost[v] === 0) { on = 0; m = 0; cl = 0; from = 'here'; }
    else {
      /* reach the point from either end of the edge; climb along a partial edge is a subtraction */
      const upU = climbAt(up[wi], c, ba) - climbAt(up[wi], c, eA0[e]);      // u -> point, forward
      const upV = climbAt(down[wi], c, eA1[e]) - climbAt(down[wi], c, ba);  // v -> point, backward
      const viaU = walk.cost[u] + walkMinutes(ba - eA0[e], upU), viaV = walk.cost[v] + walkMinutes(eA1[e] - ba, upV);
      if (!isFinite(viaU) && !isFinite(viaV)) continue;
      if (viaU <= viaV) { on = viaU; m = walk.metres[u] + (ba - eA0[e]); cl = walk.climb[u] + upU; from = u; }
      else { on = viaV; m = walk.metres[v] + (eA1[e] - ba); cl = walk.climb[v] + upV; from = v; }
    }
    const total = on + offMinutes(bd, offClimbEst(net, e, ba, hCell));
    const better = b => !b || total < b.total - 1e-9 || (Math.abs(total - b.total) < 1e-9 && bd < b.off);
    if (better(best) || (bd <= limitM && better(within))) {
      const x = { total, onMin: on, on: m, onUp: cl, off: bd, edge: e, arc: ba, from, point: cn.point };
      if (better(best)) best = x;
      if (bd <= limitM && better(within)) within = x;
    }
  }
  return { fastest: best, within };
}

/* The drive figure's approach: the one that makes the WHOLE journey fastest, drive plus walk, a
   minute of each counted the same. Where the road nearest the cell is one a car can get to, the car
   goes to the point itself and no walking is left; otherwise the walk starts wherever the drive
   ended, and the drive legs reported are that parking point's. Same bushwhack preference as the hike:
   the fastest approach that keeps the off-trail leg inside limitM, and only otherwise the fastest. */
export function driveApproaches(net, drv, driveWalk, lat, lon, elevAt, radiusM = 2500, limitM = BUSHWHACK_M) {
  const { W, cum, eW, eA0, eA1, eU, eV, climbAt, up, down, nodePt } = net;
  const hCell = elevAt ? elevAt(lat, lon) : null;
  let best = null, within = null;
  for (const cn of nearbyEdges(net, lat, lon, radiusM)) {
    const e = cn.e, ba = cn.arc, bd = cn.off;
    const wi = eW[e], w = W[wi], c = cum[wi], u = eU[e], v = eV[e];
    const upU = climbAt(up[wi], c, ba) - climbAt(up[wi], c, eA0[e]);
    const upV = climbAt(down[wi], c, eA1[e]) - climbAt(down[wi], c, ba);
    let legs, walkOn = 0, walkUp = 0, reach, park, from, stopNode = -1;
    if (drivable(w) && isFinite(drv.min[u]) && isFinite(drv.min[v])) {
      const cls = driveClassOf(w), mpm = DRIVE_M_PER_MIN[cls];
      const viaU = drv.min[u] + (ba - eA0[e]) / mpm, viaV = drv.min[v] + (eA1[e] - ba) / mpm;
      const atU = viaU <= viaV;
      legs = plusLeg(legsAt(drv, atU ? u : v), cls, atU ? ba - eA0[e] : eA1[e] - ba, atU ? upU : upV);
      reach = Math.min(viaU, viaV); park = cn.point; from = 'drive';
    } else {
      const viaU = driveWalk.cost[u] + walkMinutes(ba - eA0[e], upU), viaV = driveWalk.cost[v] + walkMinutes(eA1[e] - ba, upV);
      if (!isFinite(viaU) && !isFinite(viaV)) continue;
      const atU = viaU <= viaV, n = atU ? u : v;
      const s = driveWalk.start[n];
      if (s < 0 || !isFinite(drv.min[s])) continue;
      legs = legsAt(drv, s);
      walkOn = driveWalk.metres[n] + (atU ? ba - eA0[e] : eA1[e] - ba);
      walkUp = driveWalk.climb[n] + (atU ? upU : upV);
      reach = atU ? viaU : viaV; park = nodePt[s]; from = n; stopNode = s;
    }
    const total = reach + offMinutes(bd, offClimbEst(net, e, ba, hCell));
    const better = b => !b || total < b.total - 1e-9 || (Math.abs(total - b.total) < 1e-9 && bd < b.off);
    if (better(best) || (bd <= limitM && better(within))) {
      const x = { total, drive: legs, driveMin: driveMinutes(legs), on: walkOn, onUp: walkUp, off: bd,
                  edge: e, arc: ba, from, park, point: cn.point, stopNode };
      if (better(best)) best = x;
      if (bd <= limitM && better(within)) within = x;
    }
  }
  return { primary: within || best };
}

/* The route an approach takes, start to finish, as edges — the last one only as far as the point the
   off-trail line leaves from. Empty for a drive-up. */
export function routeOf(net, walk, a) {
  if (!a) return null;
  const edges = [];
  const onFoot = typeof a.from === 'number';        // 'here' and 'drive' both mean no walking
  if (onFoot) {
    let n = a.from, guard = 0;
    while (n >= 0 && walk.via[n] >= 0 && walk.start[n] !== n && guard++ < 100000) {
      const e = walk.via[n]; edges.push(e); n = net.eU[e] === n ? net.eV[e] : net.eU[e];
    }
    edges.reverse();
  }
  const start = onFoot ? net.nodePt[walk.start[a.from]] : a.point;
  return { edges, last: a.edge, lastFrom: onFoot ? a.from : null, end: a.point, start };
}

/* Why the car stopped where the walk starts: a mapped gate, a private or permit road, the drivable
   road turning into a rough one, or simply the end of the mapped road. Said on the sheet, because
   "as mapped" should name what the map knew. */
export function stopReason(net, node) {
  if (node < 0) return null;
  if (net.gateNode.has(node)) return 'gate';
  let rough = false, priv = false;
  for (let k = net.deg[node]; k < net.deg[node + 1]; k++) {
    const w = net.W[net.eW[net.adj[k]]];
    if (w.cat === 'road' && w.ac) priv = true;
    else if (w.cat === 'rough') rough = true;
  }
  return priv ? 'private' : rough ? 'rough' : 'end';
}
