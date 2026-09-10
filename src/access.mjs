/* How you would physically reach a cell: which way is mapped into it, what kind, how far, and
   enough geometry to draw the approach.

   This is a SEPARATE AXIS FROM SUITABILITY and must stay that way. Nothing here may be read by
   src/model/, and access must never filter, weight or modify a score. A roadless cell with perfect
   habitat is still a perfect cell — it is just a longer walk, and that is the forager's call to make,
   not the model's. Keeping the two apart is also what lets access be re-baked on its own.

   The wording matters as much as the numbers. OSM and USFS coverage on private timberland is uneven,
   and absence of a mapped way is not evidence of absence of a way. So every label here says what the
   DATA says — "a trail is mapped here" — and a cell with nothing mapped nearby reads as **unknown**,
   never as "trailless". Naming a way does not upgrade that: a named way is still only mapped, not
   confirmed passable, gated, or open this season. */

/* Distances are metres from the cell centre. A cell is roughly 1.6 km across, so NEAR is about "in
   this cell" and REACH is about "a short walk from it". */
export const NEAR = 800;
export const REACH = 2000;
export const CAP = 2000;          // the bake stores -1 beyond this rather than a real distance

/* Ordered by usefulness to someone deciding where to walk, which is also the order the classes were
   asked for. A cell can satisfy several; the first match wins. */
export const CLASSES = {
  trail: { rank: 0, label: 'Trail mapped', blurb: 'A trail or path is mapped in this cell.' },
  road: { rank: 1, label: 'Drivable road mapped', blurb: 'A road passable by vehicle is mapped in this cell.' },
  rough: { rank: 2, label: 'Rough way mapped',
    blurb: 'A track, skid road or decommissioned spur is mapped here — walkable, probably not drivable.' },
  near: { rank: 3, label: 'Mapped way nearby',
    blurb: 'Nothing mapped in the cell itself, but a way is mapped within about a mile.' },
  unknown: { rank: 4, label: 'No mapped access',
    blurb: 'Nothing is mapped within about a mile. That may mean no way exists, or simply that '
         + 'nobody has mapped one — coverage on private timberland is patchy. Treat it as unknown, '
         + 'not as trailless.' },
};
export const CLASS_ORDER = ['trail', 'road', 'rough', 'near', 'unknown'];
export const CATS = ['road', 'trail', 'rough'];      // the order they are stored in a row

const has = (v, limit) => v != null && v >= 0 && v <= limit;

export function classifyAccess(d) {
  if (!d) return 'unknown';
  if (has(d.trail, NEAR)) return 'trail';
  if (has(d.road, NEAR)) return 'road';
  if (has(d.rough, NEAR)) return 'rough';
  if (has(d.trail, REACH) || has(d.road, REACH) || has(d.rough, REACH)) return 'near';
  return 'unknown';
}

/* Which category the tap sheet should name and draw: the one the class was decided on, so the line
   on the map is the way the label is talking about. */
export function primaryCat(d) {
  const cls = classifyAccess(d);
  if (cls === 'trail' || cls === 'road' || cls === 'rough') return cls;
  if (cls === 'near') {
    let best = null;
    for (const c of CATS) if (has(d[c], REACH) && (!best || d[c] < d[best])) best = c;
    return best;
  }
  return null;
}

/* Sort key for the Top spots panel — ordering only, never a score input. Class first, then how far
   the nearest usable way is, so two "trail mapped" cells order by which one you walk less to reach.
   Unknown sorts last: it is the least actionable, not the worst habitat. */
export function accessRank(d) {
  const cls = classifyAccess(d);
  const base = CLASSES[cls].rank * 1e6;
  if (cls === 'unknown' || !d) return base;
  const ds = CATS.map(c => d[c]).filter(v => v != null && v >= 0);
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

/* ===================== naming a way ===================== */

/* How each way type reads in prose. The point of naming the route is that "Forest Road 2703" tells
   you something you can act on and "trail mapped" does not. */
export const TYPE_LABEL = {
  path: 'trail', bridleway: 'bridleway', cycleway: 'cycleway',
  track: 'track', road: 'unclassified way',
  motorway: 'highway', trunk: 'highway', primary: 'highway',
  secondary: 'road', tertiary: 'road', unclassified: 'road', residential: 'street',
  living_street: 'street', service: 'forestry spur',
  motorway_link: 'highway ramp', trunk_link: 'highway ramp', primary_link: 'road',
  secondary_link: 'road', tertiary_link: 'road',
  nfsr: 'Forest Service road', 'nfsr-closed': 'Forest Service road (closed to vehicles)',
  nfst: 'Forest Service trail',
};

/* Title-case a shouted USFS name: "SHUKSAN LAKE" -> "Shuksan Lake".
   Two things are left alone. Anything already mixed case, because OSM names are entered properly
   and re-casing them damages "McKenzie" and the like. And a short single all-caps token, because
   that is an acronym rather than shouting — "PCT" must not become "Pct". Five characters is a
   heuristic, not a rule: no trail in the state is named by a six-letter acronym, and the USFS names
   this is for ("SETTLER", "SHUKSAN LAKE") are all longer. */
export function tidyName(s) {
  if (!s) return null;
  const t = String(s).trim();
  if (!t) return null;
  if (!/^[^a-z]*$/.test(t)) return t;
  if (t.length <= 5 && !/\s/.test(t)) return t;
  return t.toLowerCase().replace(/\b([a-z])/g, (_, c) => c.toUpperCase());
}

/* The line the tap sheet shows. `unnamed` is said out loud rather than hidden: an unnamed track is
   often exactly the thing that reaches cut-over timber, and pretending it has no identity would
   throw away the distinction between "nothing here" and "something here without a name". */
export function wayLabel(w) {
  if (!w) return null;
  const kind = TYPE_LABEL[w.type] || w.type || 'way';
  const name = tidyName(w.name);
  const ref = w.ref ? String(w.ref).trim() : null;
  if (w.type === 'nfsr' || w.type === 'nfsr-closed') {
    const num = ref ? 'Forest Road ' + ref : 'Forest Service road';
    return name ? num + ' (' + name + ')' : num;
  }
  if (w.type === 'nfst') return name ? (/trail/i.test(name) ? name : name + ' Trail') : (ref ? 'Forest Trail ' + ref : 'Forest Service trail');
  if (name) return /^(trail|road|path|way)$/i.test(name) ? name + ' (' + kind + ')' : name;
  if (ref) return kind.replace(/^./, c => c.toUpperCase()) + ' ' + ref;
  return 'unnamed ' + kind;
}

/* Where the walk is measured from. A mapped trailhead is authoritative; an inferred one is simply
   where the trail meets a drivable road, which is where you would leave the car. Saying which is
   which matters — the second is a deduction from the map, not something a surveyor recorded. */
export const TRAILHEAD_NONE = 0, TRAILHEAD_MAPPED = 1, TRAILHEAD_INFERRED = 2;
export const TRAILHEAD_NOTE = {
  [TRAILHEAD_MAPPED]: 'from the mapped trailhead',
  [TRAILHEAD_INFERRED]: 'from where the way meets a drivable road',
};

/* ===================== the encoded file ===================== */

/* Geometry is delta-encoded integers at 1e5 (about a metre), shared by way rather than duplicated
   per cell. Duplicating measured 47 MB statewide; sharing full geometry measured 74 MB because the
   referenced ways average 78 points each; sharing simplified and delta-encoded lands near 8 MB.
   See docs/access.md. */
export const GEOM_SCALE = 1e5;

export function decodeGeom(flat) {
  const out = [];
  let lat = 0, lon = 0;
  for (let i = 0; i < flat.length; i += 2) {
    lat += flat[i]; lon += flat[i + 1];
    out.push([lat / GEOM_SCALE, lon / GEOM_SCALE]);
  }
  return out;
}
export function encodeGeom(coords) {
  const out = [];
  let lat = 0, lon = 0;
  for (const [a, b] of coords) {
    const A = Math.round(a * GEOM_SCALE), B = Math.round(b * GEOM_SCALE);
    out.push(A - lat, B - lon); lat = A; lon = B;
  }
  return out;
}

/* ways[k] = [name, ref, type, catIndex, trailheadKind, osmId, segments]  — geometry lives in a
   SEPARATE file.
   Splitting them is not tidiness. Everything the tap sheet needs to NAME a route is a few bytes;
   the polyline to draw it is most of the file. Measured: 4.12 MB of names and distances against
   5.39 MB of geometry. Loading the second up front would mean every viewer downloading 5 MB to draw
   one line if and only if they ask for it, so the app fetches it on the first request and not
   before. `geomFlat` is that file's entry for the same index, or omitted. */
export function decodeWay(w, geomFlat) {
  if (!w) return null;
  return { name: w[0] || null, ref: w[1] || null, type: w[2], cat: CATS[w[3]],
           trailhead: w[4] || TRAILHEAD_NONE,
           osmId: w[5] != null && w[5] > 0 ? w[5] : null,
           segments: w[6] || 1,
           geom: geomFlat ? decodeGeom(geomFlat) : null };
}

/* rows[k] = [i, j] then four numbers per category: distance, way index, walk, elevation gain.
   -1 anywhere means "not found within CAP" / "no way" / "not computable". Gain is only ever present
   alongside a walk, because both are measured from a trailhead and mean nothing without one. */
/* The stored format version. The row stride and the way-entry width have both changed once, and a
   file from the other side of that change decodes into confident nonsense rather than failing: v3
   rows are 3 wide per category, so a v4 reader takes one category's distance as another's way index.
   The app refuses a version it does not know and reads every cell as unknown instead, which is the
   answer it would give with no file at all. */
export const ACCESS_FORMAT = 4;
export const ROW_STRIDE = 4;
export function decodeRow(row) {
  const d = {};
  CATS.forEach((c, n) => {
    const at = 2 + n * ROW_STRIDE;
    d[c] = row[at];
    d[c + 'Way'] = row[at + 1];
    d[c + 'Walk'] = row[at + 2];
    d[c + 'Gain'] = row[at + 3];
  });
  return d;
}

/* One structured answer for the tap sheet: the class, the way it is talking about, how far, and
   whether that distance is a walk along the way or a straight line. */
export function accessDetail(d, ways, geoms) {
  const cls = classifyAccess(d);
  const cat = primaryCat(d);
  const out = { cls, label: CLASSES[cls].label, blurb: CLASSES[cls].blurb, cat, wayIndex: -1,
                way: null, wayName: null, straight: null, walk: null, gain: null,
                trailheadNote: null, walkDoubt: null, others: [] };
  if (!d || !cat) return out;
  out.straight = d[cat];
  const wi = d[cat + 'Way'];
  if (ways && wi != null && wi >= 0 && ways[wi]) {
    out.wayIndex = wi;
    out.way = decodeWay(ways[wi], geoms && geoms[wi]);
    out.wayName = wayLabel(out.way);
    const walk = d[cat + 'Walk'];
    if (walk != null && walk >= 0 && out.way.trailhead) {
      out.walk = walk;
      const gain = d[cat + 'Gain'];
      if (gain != null && gain >= 0) out.gain = gain;
      out.trailheadNote = TRAILHEAD_NOTE[out.way.trailhead];
    }
  }
  // the other categories, so the sheet can say "also a road 1.2 mi away"
  for (const c of CATS) {
    if (c === cat) continue;
    if (d[c] == null || d[c] < 0) continue;
    const w = ways && d[c + 'Way'] >= 0 ? decodeWay(ways[d[c + 'Way']]) : null;   // name only
    out.others.push({ cat: c, m: d[c], name: w ? wayLabel(w) : null });
  }
  out.others.sort((a, b) => a.m - b.m);
  /* After the others, because whether there is anything else nearby changes what the note can
     honestly tell you to do about it. */
  out.walkDoubt = walkDoubtNote(out.walk, out.others.length > 0);
  return out;
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
   high-clearance or closed, which is exactly the "unmaintained way" case. */
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

export function osmType(tags) {
  if (!tags) return 'unknown';
  return tags.highway || tags['abandoned:highway'] || tags['disused:highway'] || tags['razed:highway'] || 'unknown';
}

/* Feet, because the rest of the app is in feet. Rounded coarsely: the terrain tiles are ~76 m per
   pixel and the geometry is simplified to 25 m, so a figure to the nearest foot would be false
   precision. */
export function gainLabel(m) {
  if (m == null || m < 0) return null;
  const ft = m * 3.28084;
  if (ft < 50) return 'negligible climb';
  return Math.round(ft / 50) * 50 + ' ft of climb';
}

/* Past this, a walk figure stops describing a walk and starts describing the data. The figure is
   real — it is the distance along the route from the only trailhead mapped on it — but at this
   length nobody is walking it to pick mushrooms, and reading it as an approach would be a mistake.

   10 miles is the 95th percentile of the walks the sheet actually shows: 522 of 10,604 statewide,
   against a median of 1.3 mi. It is also about four hours each way on a trail.

   It is a label, not a cap. Capping would replace a measured number with a made-up one; hiding it
   would leave the cell looking as though nothing is known about reaching it, which is false. Both
   would be less honest than saying what the number is and what it probably means. */
export const WALK_DOUBT = 16093;                     // metres — 10 miles
export function walkDoubtNote(m, hasOthers) {
  if (m == null || m < WALK_DOUBT) return null;
  return 'Almost certainly not the real approach. This is the distance along the whole route from the '
    + 'only trailhead mapped on it, and a nearer way in is likely unmapped, or mapped without a '
    + 'trailhead.' + (hasOthers ? ' Check "Also nearby".' : '');
}

/* What to say when there is no trailhead to measure from. Computing a distance from an arbitrary end
   of the way would be worse than saying nothing: it would look like an answer. */
export const NO_TRAILHEAD_NOTE =
  'No trailhead is mapped on this way, so there is nowhere to measure a walk from — '
  + 'the figure above is a straight line from the cell to the way.';

/* ===================== external links =====================

   AllTrails is deliberately absent. Every AllTrails URL form — a trail page, the explore map with
   bounds, and their search — answers HTTP 403 to any programmatic request, so none of it can be
   verified to work, and their per-trail pages need a slug this data does not contain. Linking their
   search with a trail name would be exactly the "may land on the wrong trail" case to avoid: the
   same name recurs across the state, and a wrong trail is worse than no link.

   So: the OpenStreetMap way page where the way came from OSM, because that identifies the *exact*
   way the sheet just named (verified 200 against real way ids), and CalTopo centred on the cell
   otherwise, because it works for USFS features too and a topo view is what you want for an
   approach. Gaia GPS was tried and its map deep link did not resolve. */
export function externalLinks(way, lat, lon) {
  const out = [];
  if (way && way.osmId) {
    out.push({ label: 'This way on OpenStreetMap',
               url: 'https://www.openstreetmap.org/way/' + way.osmId,
               note: 'the exact way named above' });
  }
  out.push({ label: 'Open in CalTopo',
             url: 'https://caltopo.com/map.html#ll=' + lat.toFixed(5) + ',' + lon.toFixed(5) + '&z=14&b=t',
             note: 'topo map centred on this cell' });
  return out;
}
