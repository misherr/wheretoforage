/* How you would physically reach a cell: is a way mapped into it, and what kind.

   This is a SEPARATE AXIS FROM SUITABILITY and must stay that way. Nothing here may be read by
   src/model/, and access must never filter, weight or modify a score. A roadless cell with perfect
   habitat is still a perfect cell — it is just a longer walk, and that is the forager's call to make,
   not the model's. Keeping the two apart is also what lets access be re-baked on its own.

   The wording matters as much as the numbers. OSM and USFS coverage on private timberland is uneven,
   and absence of a mapped way is not evidence of absence of a way. So every label here says what the
   DATA says — "a trail is mapped here" — and a cell with nothing mapped nearby reads as **unknown**,
   never as "trailless". Confirmed-trailless is a claim this data cannot support. */

/* Distances are metres from the cell centre. A cell is roughly 1.6 km across, so NEAR is about "in
   this cell" and REACH is about "a short walk from it". */
export const NEAR = 800;
export const REACH = 2000;
export const CAP = 2000;          // the bake stores -1 beyond this rather than a real distance

/* Ordered by usefulness to someone deciding where to walk, which is also the order the classes were
   asked for. A cell can satisfy several; the first match wins. */
export const CLASSES = {
  trail: {
    rank: 0, label: 'Trail mapped',
    blurb: 'A trail or path is mapped in this cell.',
  },
  road: {
    rank: 1, label: 'Drivable road mapped',
    blurb: 'A road passable by vehicle is mapped in this cell.',
  },
  rough: {
    rank: 2, label: 'Rough way mapped',
    blurb: 'A track, skid road or decommissioned spur is mapped here — walkable, probably not drivable.',
  },
  near: {
    rank: 3, label: 'Mapped way nearby',
    blurb: 'Nothing mapped in the cell itself, but a way is mapped within about a mile.',
  },
  unknown: {
    rank: 4, label: 'No mapped access',
    blurb: 'Nothing is mapped within about a mile. That may mean no way exists, or simply that '
         + 'nobody has mapped one — coverage on private timberland is patchy. Treat it as unknown, '
         + 'not as trailless.',
  },
};
export const CLASS_ORDER = ['trail', 'road', 'rough', 'near', 'unknown'];

/* d is {road, trail, rough} in metres, or -1 / null where nothing was found inside CAP. */
const has = (v, limit) => v != null && v >= 0 && v <= limit;

export function classifyAccess(d) {
  if (!d) return 'unknown';
  if (has(d.trail, NEAR)) return 'trail';
  if (has(d.road, NEAR)) return 'road';
  if (has(d.rough, NEAR)) return 'rough';
  if (has(d.trail, REACH) || has(d.road, REACH) || has(d.rough, REACH)) return 'near';
  return 'unknown';
}

/* Sort key for the Top spots panel — ordering only, never a score input. Class first, then how far
   the nearest usable way is, so two "trail mapped" cells order by which one you walk less to reach.
   Unknown sorts last: it is the least actionable, not the worst habitat. */
export function accessRank(d) {
  const cls = classifyAccess(d);
  const base = CLASSES[cls].rank * 1e6;
  if (cls === 'unknown' || !d) return base;
  const ds = [d.trail, d.road, d.rough].filter(v => v != null && v >= 0);
  return base + (ds.length ? Math.min(...ds) : CAP);
}

/* Human-readable distance, in the units the rest of the app uses. */
export function accessDistance(m) {
  if (m == null || m < 0) return null;
  const ft = m * 3.28084;
  if (ft < 1000) return Math.round(ft / 50) * 50 + ' ft';
  const mi = m / 1609.34;
  return (mi < 1 ? mi.toFixed(1) : Math.round(mi * 10) / 10) + ' mi';
}

/* One line for the tap sheet: the class, then whichever ways are actually mapped and how far. */
export function accessSummary(d) {
  const cls = classifyAccess(d);
  const parts = [];
  if (d) {
    for (const [k, name] of [['trail', 'trail'], ['road', 'road'], ['rough', 'rough way']]) {
      const s = accessDistance(d[k]);
      if (s) parts.push(name + ' ' + s);
    }
  }
  return { cls, label: CLASSES[cls].label, blurb: CLASSES[cls].blurb, detail: parts.join(' · ') };
}

/* ---- what counts as what, shared with scripts/build-access.mjs ----
   Kept here so the bake and the app cannot disagree about the vocabulary, the same reason the cell
   lattice lives in src/grid.mjs. */

// OSM highway values. footway and steps are deliberately absent: in Washington they are
// overwhelmingly sidewalks and stairs, and a genuine backcountry trail is tagged path or bridleway.
export const OSM_DRIVE = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'unclassified', 'residential', 'living_street', 'motorway_link', 'trunk_link', 'primary_link',
  'secondary_link', 'tertiary_link']);
export const OSM_TRAIL = new Set(['path', 'bridleway', 'cycleway']);
// track is the workhorse tag for logging spurs and skid roads; `road` means "classification unknown".
export const OSM_ROUGH = new Set(['track', 'road']);

/* USFS operational maintenance level. 3-5 are maintained for passenger cars or better; 1-2 are
   high-clearance or closed-but-existing, which is exactly the "unmaintained way" case. */
export const USFS_DRIVABLE_ML = /^[345]/;

export function osmCategory(tags) {
  if (!tags) return null;
  // A way tagged abandoned:/disused:/razed: is a decommissioned spur — still walkable, often the
  // only thing reaching cut-over ground, and the sort of way most apps drop entirely.
  if (tags['abandoned:highway'] || tags['disused:highway'] || tags['razed:highway']) return 'rough';
  const h = tags.highway;
  if (!h) return null;
  if (h === 'service') return tags.service ? 'rough' : null;   // forestry spurs only; see the query
  if (OSM_TRAIL.has(h)) return 'trail';
  if (OSM_ROUGH.has(h)) return 'rough';
  if (OSM_DRIVE.has(h)) {
    // A drivable classification that is gated, 4wd-only or unpaved dirt is really a rough way.
    if (tags['4wd_only'] === 'yes') return 'rough';
    if (tags.surface && /^(dirt|earth|ground|mud|sand|grass)$/.test(tags.surface)) return 'rough';
    return 'road';
  }
  return null;
}
