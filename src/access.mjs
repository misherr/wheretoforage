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

/* The lattice, so that "which cell contains this point" has exactly one answer. Importing grid.mjs
   is allowed and importing anything from src/model/ is not — a test enforces both directions. */
import { cellKey, WA } from './grid.mjs';

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

/* How the tapped approach line is coloured, by the category of the way it follows.

   Lightness carries the category, not hue. The fills already occupy the palette — yellow through red
   for chance, greens for habitat, blues for rain, olives for soil — and the approach line once used
   #e58a2b for a road, which is exactly the chance layer's "Good" band. A line whose colour means
   something on another layer is worse than no line. The dash and width fields are left over from the
   vector trails layer, which drew every way with them; the roads-and-trails overlay is now a rendered
   raster (see index.html), and only the approach line reads this table. */
export const LINE_STYLE = {
  rough: { label: 'Rough road', colour: '#cfc6ae', width: 1.9, dash: [7, 5], order: 0,
           note: 'logging spurs and unmaintained roads' },
  road:  { label: 'Drivable road', colour: '#f2ede0', width: 2.5, dash: null, order: 1,
           note: 'a car road, by its mapped classification' },
  trail: { label: 'Trail', colour: '#5dcaa5', width: 1.9, dash: [2, 4], order: 2,
           note: 'path, bridleway or USFS trail' },
};
export const LINE_CASING = '#0f150f';

/* What to call the on-route leg of an approach. A road is not a trail, and saying "4.8 mi on the
   trail" about a forest road is the sort of small wrongness that makes a reader discount the
   numbers next to it. The off-trail leg keeps its own name in every case: it describes the leg, not
   the way, and there is no way there at all. */
export const ON_ROUTE_LABEL = { road: 'on the road', trail: 'on the trail', rough: 'on the track' };
export const onRouteLabel = cat => ON_ROUTE_LABEL[cat] || 'along the way';

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
/* The stored format version. The row stride has now changed twice, and a file from the other side of
   such a change decodes into confident nonsense rather than failing: v3 rows are 3 wide per category
   and v4 rows 4, so a v5 reader takes one category's distance as another's way index. The app refuses
   a version it does not know and reads every cell as unknown instead, which is the answer it would
   give with no file at all.

   v5 splits the approach into its two legs, because v4's single "walk" number was measured from the
   trailhead to the point on the way nearest the cell and stopped there — it never included getting
   from that point to the cell, which is why 924 cells reported a walk of exactly 0 while the way was
   up to 1.9 km away. See docs/access.md. */
/* v9 splits the file: the base carries the categories and the worst case, and each mode's columns
   live in their own file, fetched when that mode is on screen. See MODE_FILES and BASE_WIDTH.

   v10 gives each RIDING mode its own worst case. Up to v9 the "if the gravel is gated" figure was one
   walk from the pavement, shown under all four modes — and for a rider that is the wrong quantity, not
   a conservative one. See RIDE_WORST_NOTE. */
export const ACCESS_FORMAT = 10;
export const ROW_STRIDE = 5;
export function decodeRow(row) {
  const d = {};
  CATS.forEach((c, n) => {
    const at = 2 + n * ROW_STRIDE;
    /* d is the OFF-TRAIL leg: straight-line metres from the cell centre to the nearest point on the
       stored route. It is also what the class is decided on, and measuring both from the stored
       geometry is deliberate — the number shown has to describe the line drawn. */
    d[c] = row[at];
    d[c + 'Way'] = row[at + 1];
    d[c + 'Walk'] = row[at + 2];
    d[c + 'Gain'] = row[at + 3];
    d[c + 'OffGain'] = row[at + 4];
  });
  return d;
}

/* The approach to a cell, in the two legs it actually has.

   v4 reported one number called "the walk": the distance along the way from its trailhead to the
   point on the way nearest the cell. It stopped at the trail. Getting from that point to the cell
   was never in the figure, and for 2,460 of 10,604 displayed walks the omitted part was LONGER than
   the part shown. 924 cells reported exactly 0 — true, useless, and read as "no walk at all" when
   the honest answer was "1.9 km of off-trail bushwhacking from a point next to the trailhead".

   So the answer has three numbers and the sheet shows all three:

     onTrail   trailhead -> the nearest point on the route, along the route
     offTrail  that point -> the cell centre, in a STRAIGHT LINE
     total     the two added

   The off-trail leg is the honest part and the dangerous one: it ignores terrain, brush, water and
   whether anyone has ever walked it. A quarter mile of Cascade slide alder is not a quarter mile of
   trail. OFF_TRAIL_NOTE says so, and the sheet always shows it alongside the number.

   The total exists because neither leg alone answers "how far in is it". A zero on-trail leg with a
   1.9 km off-trail leg is now visibly a 1.9 km problem rather than invisibly a 0. */
export function approachParts(d, cat, way) {
  if (!d || !cat || !way) return null;
  const off = d[cat];
  if (off == null || off < 0) return null;
  const on = d[cat + 'Walk'], onG = d[cat + 'Gain'], offG = d[cat + 'OffGain'];
  const haveOn = way.trailhead && on != null && on >= 0;
  const p = {
    onTrail: haveOn ? on : null,
    onGain: haveOn && onG != null && onG >= 0 ? onG : null,
    offTrail: off,
    offGain: offG != null && offG >= 0 ? offG : null,
    total: null, totalGain: null,
  };
  if (p.onTrail != null) {
    p.total = p.onTrail + p.offTrail;
    /* A total climb only means anything when both halves are known. Adding a known leg to an
       unknown one and presenting the sum as the climb would be the same overclaim as measuring a
       walk from a trailhead that does not exist. */
    if (p.onGain != null && p.offGain != null) p.totalGain = p.onGain + p.offGain;
  }
  return p;
}

/* One structured answer for the tap sheet: the class, the way it is talking about, how far, and
   whether that distance is a walk along the way or a straight line. */
export function accessDetail(d, ways, geoms) {
  const cls = classifyAccess(d);
  const cat = primaryCat(d);
  const out = { cls, label: CLASSES[cls].label, blurb: CLASSES[cls].blurb, cat, wayIndex: -1,
                way: null, wayName: null, straight: null, walk: null, gain: null,
                parts: null, trailheadNote: null, walkDoubt: null, others: [] };
  if (!d || !cat) return out;
  out.straight = d[cat];
  const wi = d[cat + 'Way'];
  if (ways && wi != null && wi >= 0 && ways[wi]) {
    out.wayIndex = wi;
    out.way = decodeWay(ways[wi], geoms && geoms[wi]);
    out.wayName = wayLabel(out.way);
    out.parts = approachParts(d, cat, out.way);
    const walk = d[cat + 'Walk'];
    if (walk != null && walk >= 0 && out.way.trailhead) {
      out.walk = walk;
      const gain = d[cat + 'Gain'];
      if (gain != null && gain >= 0) out.gain = gain;
      out.trailheadNote = TRAILHEAD_NOTE[out.way.trailhead];
    }
  }
  /* The other categories, so the sheet can say "also a road 1.2 mi away" — and, since v5, with
     their own approach figures. 16,091 cells have a walk sitting in a category the sheet does not
     name, and showed nothing at all: the primary category is chosen by class precedence, so a cell
     whose nearest trail has no trailhead named that trail and went silent while the road beside it
     had a perfectly good figure. Naming the other route instead would be worse — it would rename
     16,091 cells, 12,331 of them from a road to a rough track, i.e. from the road you would drive
     to a logging spur. So the naming stands and the figures come with the alternatives. */
  for (const c of CATS) {
    if (c === cat) continue;
    if (d[c] == null || d[c] < 0) continue;
    const w = ways && d[c + 'Way'] >= 0 ? decodeWay(ways[d[c + 'Way']]) : null;
    out.others.push({ cat: c, m: d[c], name: w ? wayLabel(w) : null,
                      parts: w ? approachParts(d, c, w) : null,
                      trailheadNote: w && w.trailhead ? TRAILHEAD_NOTE[w.trailhead] : null });
  }
  out.others.sort((a, b) => a.m - b.m);
  /* After the others, because whether there is anything else nearby changes what the note can
     honestly tell you to do about it. The doubt is about the TOTAL now, not the on-trail leg: a
     3 mi trail walk plus a mile of off-trail is the same problem as a 4 mi trail walk. */
  out.walkDoubt = walkDoubtNote(out.parts ? out.parts.total : null, out.others.length > 0);
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

/* Tags that DESCRIBE a road, as opposed to classifying it. highway= is a class somebody chose, and
   USFS's maintenance level is a class too; these say what the road is actually like, and where they
   disagree with a class, the description wins. They are separate from osmCategory because the bake
   needs them again later, when OSM and USFS map the same road and one of them has to decide. */
export const OSM_PAVED = /^(paved|asphalt|concrete|concrete:plates|concrete:lanes|chipseal)$/;
export const osmPaved = tags => !!tags && OSM_PAVED.test(tags.surface || '');
/* Why a car cannot use it, or null. All three describe the road; none of them is a class. This
   project has twice been burned by access reading more optimistic than the ground, so any one of
   them is enough. */
/* Limited-access highways are the exception. On a motorway or trunk road motor_vehicle=no marks an
   HOV, transit or express lane — 150 motorway ramps and the I-5 Express Lanes in the first run — not
   a road closed to cars, and "walkable, probably not drivable" is the wrong thing to say about it. */
export const LIMITED_ACCESS = /^(motorway|trunk)(_link)?$/;
export function osmRoughReason(tags) {
  if (!tags || LIMITED_ACCESS.test(tags.highway || '')) return null;
  if (tags['4wd_only'] === 'yes') return '4wd_only=yes';
  if (tags.motor_vehicle === 'no') return 'motor_vehicle=no';
  if (/^(impassable|very_horrible)$/.test(tags.smoothness || '')) return 'smoothness=' + tags.smoothness;
  return null;
}

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
    // A drivable classification that is 4wd-only, closed to motor vehicles, impassable or unpaved
    // dirt is really a rough way: those tags describe the road, and a description beats a class.
    if (osmRoughReason(tags)) return 'rough';
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

/* Access is a property of a LATTICE CELL, not of a point, and every path that builds an entry has
   to resolve it the same way: from the cell that contains the point. That was the bug this function
   exists to prevent. The lookup lived inline in the one path that loads baked cells, so tapping the
   map and opening the same place from Top spots disagreed — and they disagreed in the worst possible
   direction, because an entry with no access reads as the `unknown` class, which the sheet renders
   as "No mapped access — nothing is mapped within about a mile". That is indistinguishable from the
   honest answer, and it was wrong: the row was sitting in the index the whole time. A false negative
   dressed as a careful one is worse than a blank.

   Undefined still means unknown, which is right when there genuinely is no row for the cell — 1,659
   of 48,032 — or no file at all. What must not happen is unknown by omission. */
export function accessAt(byCell, lat, lon) {
  if (!byCell || !Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  return byCell.get(cellKey(lat, lon));
}

/* "Nothing is mapped near this cell" and "nobody looked near this cell" are different answers, and
   only one of them is about the ground. The bake walks the cells in cells.json — 48,032 of the
   ~69,600 in-state lattice cells, the rest having been gated out as non-habitat — and writes a row
   for the 46,373 where it found something. So a missing row means one of two things:

     the cell IS in cells.json  -> examined, nothing found within CAP. `unknown` is the honest answer.
     the cell is NOT            -> never examined. `unknown` would be a claim about a lookup that
                                   never happened, which is the overclaim this whole module exists
                                   to avoid.

   The second case is not rare: 31.5% of taps that land inside the state land outside the baked set,
   because a tap goes wherever a finger goes and the bake only covers plausible habitat. Those places
   are shrub-steppe, farmland, water and town — full of roads — so "nothing is mapped within about a
   mile" there is not merely unproven, it is usually false. */
export const NOT_EXAMINED_LABEL = 'Access not checked here';
export const NOT_EXAMINED_NOTE =
  'This point is outside the cells the access bake covers, so no way was looked for near it. That is '
  + 'not the same as nothing being mapped — it means nobody asked. Tap a scored cell for access.';

/* An exact point and a sub-mile refine cell are both smaller than the cell access is measured for,
   so the sheet has to say whose access it is showing. The distances are from the cell centre, which
   can be up to about half a mile from where the user actually tapped. */
export const CELL_SCOPE_NOTE =
  'Access is for the square-mile cell containing this point, not for the exact coordinate — '
  + 'distances are measured from the cell centre.';

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

/* The off-trail leg is a straight line on a map and nothing more. It is measured to the cell CENTRE,
   which is where the score, the terrain and the vegetation are all measured, and it takes no account
   of what is in the way. Saying the number without saying that would turn the most uncertain figure
   on the sheet into the most confident-looking one. */
export const OFF_TRAIL_NOTE =
  'straight line to the cell centre — no trail, and it takes no account of terrain, brush, blowdown '
  + 'or water. A quarter mile of slide alder is not a quarter mile of trail.';

/* What to say when there is no trailhead to measure from. Computing a distance from an arbitrary end
   of the way would be worse than saying nothing: it would look like an answer. */
export const NO_TRAILHEAD_NOTE =
  'No trailhead is mapped on this way, so there is nowhere to measure a walk from — '
  + 'the figure above is a straight line from the cell to the way.';

/* The same fact, said where the off-trail leg follows it rather than precedes it. Two constants
   rather than one because a note that points at "the figure above" has to have the figure above it,
   and the approach block puts the unavailable leg first. */
export const NO_ON_TRAIL_NOTE =
  'No trailhead is mapped on this route, so there is nowhere to measure a walk along it from. '
  + 'Only the off-trail leg below is known.';

/* ===================== modes: how far in, on foot =====================

   Three independent figures per cell — drive, bike, hike — each a distance, a climb and a difficulty
   bucket. Hike is built first; drive and bike follow on the same network.

   The hike figure is the walk from where a car can get to — drivable roads connected to pavement,
   stopping at mapped gates and at private or permit-only roads — along any trail, track or gated road,
   then a straight line off trail to the cell centre. The worst case is the same walk from the nearest
   PAVED road, for when the gravel turns out to be gated where nobody mapped a gate: the Deming failure,
   made visible instead of hidden behind "as mapped". Both describe the route as mapped, never as it
   will be on the day.

   The effort model, agreed with the user: 4 km/h on anything mapped plus 10 minutes per 100 m of climb
   (Naismith); off trail at a third of the speed — a mile of Cascade brush costs what three miles of
   trail do — and twice the climb cost. The user's own Deming approach was 6 mi and 2,000 ft in 6.5 h,
   much of it off trail. */
export const WALK_KMH = 4;
export const CLIMB_MIN_PER_100M = 10;
export const OFF_TRAIL_FACTOR = 3;
export const OFF_CLIMB_FACTOR = 2;

/* The most sensitive knob, kept adjustable on purpose: at 400 m, 38% of cells were bushwhack in the
   first measurement, at 1.2 km 12%. The user will revisit it after walking a few cells in each bucket.
   A bucket is computed in the app from the stored parts, so changing this needs no re-bake. */
export const BUSHWHACK_M = 800;

/* Going straight through the brush is shown beside the approach, never instead of it, and only when it
   saves at least this much. One constant for the bake, which decides whether to store it, and the
   sheet, which decides whether to show it with the measured off-trail climb. */
export const DIRECT_SAVES_MIN = 15;

export const BUCKETS = [
  { key: 'drive', label: 'Drive-up', maxMin: 10, blurb: 'ten minutes or less on foot from where the car stops' },
  { key: 'easy', label: 'Easy walk', maxMin: 30, blurb: 'half an hour or less on foot' },
  { key: 'moderate', label: 'Moderate hike', maxMin: 120, blurb: 'up to two hours on foot' },
  { key: 'long', label: 'Long approach', maxMin: Infinity, blurb: 'more than two hours on foot' },
  { key: 'bushwhack', label: 'Bushwhack', maxMin: null,
    blurb: 'more than half a mile off trail, however long it takes — the most uncertain figure there is' },
];

/* Minutes on foot for a set of parts: { on, onUp, off, offUp } in metres. */
export function footMinutes(p) {
  if (!p) return null;
  const perMin = WALK_KMH * 1000 / 60;
  return p.on / perMin + p.onUp * CLIMB_MIN_PER_100M / 100
       + p.off * OFF_TRAIL_FACTOR / perMin + p.offUp * CLIMB_MIN_PER_100M / 100 * OFF_CLIMB_FACTOR;
}
export function bucketOf(p) {
  if (!p) return null;
  if (p.off > BUSHWHACK_M) return BUCKETS[4];
  const m = footMinutes(p);
  return BUCKETS.find(b => b.maxMin != null && m <= b.maxMin);
}
export function durationLabel(min) {
  if (min == null) return null;
  if (min < 55) return Math.max(5, Math.round(min / 5) * 5) + ' min';
  const h = min / 60;
  return (h < 10 ? Math.round(h * 2) / 2 : Math.round(h)) + ' h';
}

/* Why the vehicle stopped where the walk starts, as the bake records it. The last three are a
   bicycle's reasons; the first five a car's. */
export const STOP = { none: 0, gate: 1, private: 2, rough: 3, end: 4, wilderness: 5, bicycle: 6, closed: 7,
                      designation: 8, restricted: 9 };
export const STOP_LABEL = {
  [STOP.none]: 'from the road',
  [STOP.gate]: 'from a mapped gate',
  [STOP.private]: 'from where a private or permit-only road starts',
  [STOP.rough]: 'from where the drivable road turns rough',
  [STOP.end]: 'from the end of the mapped drivable road',
  [STOP.wilderness]: 'from the wilderness boundary, where a bicycle is illegal',
  [STOP.bicycle]: 'from where the map says no bicycles',
  [STOP.closed]: 'from a road the Forest Service has closed to motorized use',
  [STOP.designation]: 'from where the singletrack has no motorized designation recorded',
  [STOP.restricted]: 'from where motor vehicles are not allowed',
};
export const AS_MAPPED_NOTE =
  'As mapped. A gate, washout or closure nobody mapped is not in these figures — a road gated six '
  + 'miles short of the ground once read as a drive-up here.';
export const WORST_CASE_NOTE =
  'If the gravel turns out to be gated: the same walk from the nearest paved road.';

/* The same premise, for a machine a gate does not stop. A gate nobody mapped is invisible to the
   network, so every mode needs a bound for it — but "the same walk from the pavement" is that bound
   only for the two modes the closure actually strands. On foot it is the walk; in a car the car is
   stuck at the gate, so it is the same walk; on either kind of bike you unload at the pavement and
   ride, which is the whole reason the machine is in the truck.

   At Deming the walker's bound is 5.5 h. The dirt bike covers that gravel in a fraction of it, and
   until v10 the sheet said 5.5 h under the dirt bike as well — a tenfold overstatement in precisely
   the case the mode exists for. The rider's bound is still a bound: the ride starts at the pavement
   rather than wherever the car got to, and every legal block still applies, so a road the Forest
   Service has closed to motor vehicles stops the dirt bike at the gate whatever the gravel is doing. */
export const RIDE_WORST_NOTE =
  'If the gravel turns out to be gated: the same journey, unloading at the nearest paved road. '
  + 'A gate stops the car, not the machine — which is why this figure is a ride and the hike\'s is a walk.';
export const RIDE_WORST_BLOCKED_NOTE =
  'Nothing rideable leaves the pavement here, so this is the walk — the same one the hike figure gets.';

/* What stops a car, read from OSM tags — shared by the fetch and the checkpoint upgrade. Pessimistic:
   the most specific access tag wins, and anything short of a plain yes to cars is a stop. */
const CAR_RESTRICTED = /^(private|no|permit|forestry|agricultural|delivery)$/;
const carAccessValue = t => t.motorcar || t.motor_vehicle || t.vehicle || t.access || null;
export function carRestriction(tags) {
  if (!tags) return null;
  const v = carAccessValue(tags);
  return v && CAR_RESTRICTED.test(v) ? v : null;
}
export const CAR_BARRIERS = /^(gate|lift_gate|swing_gate|chain|bollard|block|jersey_barrier|log|rope|debris)$/;
/* Whether a way is DESIGNATED for motorized use, which is the only thing that lets a dirt bike onto
   singletrack. Three answers, and the third is the important one:
     1    designated: USFS says motorcycles are allowed, or OSM tags them yes.
     0    designated NOT: USFS says non-motorized.
     null nothing recorded — 69% of Washington's USFS trail mileage, and nearly every OSM-only path.
   Silence is treated as CLOSED, at the user's instruction and mine: the optimistic reading would hand
   a rider thousands of miles that are mostly illegal, and that is the error that earns a citation
   rather than a wasted drive. What is excluded is said on the sheet — see MOTO_EXCLUDED_NOTE. */
export const OSM_MOTORIZED_YES = /^(yes|designated|permissive|official)$/;
export function motoDesignation(tags) {
  if (!tags) return null;
  for (const k of ['motorcycle', 'motor_vehicle', 'vehicle']) {
    const v = tags[k];
    if (!v) continue;
    if (OSM_MOTORIZED_YES.test(v)) return 1;
    if (/^(no|private|permit|forestry|agricultural|delivery|destination)$/.test(v)) return 0;
  }
  return null;
}
/* The USFS trail attributes: TERRA_MOTORIZED is Y / N / N/A, and ALLOWED_TERRA_USE is a digit string
   whose 4 is the motorcycle — verified against the date fields, where every 4321 trail carries a
   motorcycle season and no 321 trail does. */
export function usfsMotoDesignation(a) {
  const m = String((a && a.terra_motorized) || '').toUpperCase();
  const use = String((a && a.allowed_terra_use) || '');
  if (m === 'Y' || /4/.test(use)) return 1;
  if (m === 'N' || (use && use !== 'N/A')) return 0;
  return null;
}
/* Where a bicycle is forbidden by a tag, beside carRestriction and read the same way. `dismount`
   counts: pushing a bike is walking, and the bike figure then walks that stretch, which is right. */
export const BIKE_FORBIDDEN = /^(no|private|dismount)$/;
export function bikeRestriction(tags) {
  const v = tags && tags.bicycle;
  return v && BIKE_FORBIDDEN.test(v) ? v : null;
}
/* A barrier node stops a car unless it is tagged open to cars. 808 of 67,710 were, in the first fetch. */
export function blocksCars(tags) {
  if (!tags || !CAR_BARRIERS.test(tags.barrier || '')) return false;
  return !/^(yes|permissive|designated)$/.test(carAccessValue(tags) || '');
}

/* ===================== the drive =====================

   How deep into the forest road network a cell sits: the drive from the nearest paved road to where
   the car stops, then the walk that is left. What counts as passable for a car is what the rules
   already decided — USFS maintenance level 3-5, or an OSM way OSM calls drivable — stopping at mapped
   gates and at private or permit-only roads, which is the same place the hike figure starts.

   Speeds, agreed with the user: 35 mph on pavement, 25 on a graded forest road (USFS level 4-5), 15 on
   anything rougher, which is level 3 and every gravel road nobody rated. Metres are stored per class
   and the minutes are computed in the app, so a speed can change without a re-bake. Climb is recorded
   because the user asked each figure to carry one; it does not enter the time.

   The parking point is chosen to make the WHOLE journey fastest — drive plus walk, a minute of each
   counted the same. A minute in the truck is easier than a minute on foot, so this already leans
   towards walking rather than towards driving round the mountain. The hike figure chooses on foot
   minutes alone, which is why the two can name different places to leave the car. */
export const DRIVE_MPH = { paved: 35, graded: 25, rough: 15 };
const M_PER_MIN_PER_MPH = 1609.34 / 60;
export const DRIVE_CLASSES = ['paved', 'graded', 'rough'];
export const DRIVE_CLASS_LABEL = { paved: 'pavement', graded: 'graded forest road', rough: 'rough or unrated gravel' };
export function driveMinutes(d) {
  if (!d) return null;
  let m = 0;
  for (const c of DRIVE_CLASSES) m += (d[c] || 0) / (DRIVE_MPH[c] * M_PER_MIN_PER_MPH);
  return m;
}
export const driveMetres = d => d ? DRIVE_CLASSES.reduce((s, c) => s + (d[c] || 0), 0) : null;
/* Door to cell: the drive and the walk that is left, in one number, for sorting and for the summary
   line. The filter uses the drive alone, because "within 30 minutes of driving" says driving. */
export const travelMinutes = d => d ? driveMinutes(d) + footMinutes(d.walk) : null;
export const DRIVE_NOTE =
  'The drive is from the nearest paved road, at 35 mph on pavement, 25 on a graded forest road and 15 '
  + 'on anything rougher. Snow, washouts, a locked gate nobody mapped and mud are not in it.';

/* ===================== where a route is stored =====================

   The routes are drawn from their own files, and there are 264 of them rather than one, because the
   one was 3.4 MB and it is fetched at the moment somebody standing at a trailhead taps "show the
   route" — the worst connection and the least patience in the whole app. Sharded 16 cells square,
   about 26 km, a tap costs a median 8 KB and at worst 52 KB.

   The size was measured rather than guessed, on the real file: 16, 24, 32, 48 and 64 cells square all
   cost the same in TOTAL (within 2%, because an edge is nearly always used by cells in one shard
   only), so the choice is purely about the size of one fetch. 16 won on the p90: 32 KB against 121 KB
   at 32 cells.

   The key is derived from the cell index, so the bake and the app agree by construction. A missing
   file means "no routes in this block of the state", which is a real answer — most of the Columbia
   basin has none — and not an error. */
export const ROUTE_SHARD = 16;
export const routeShardKey = (i, j) => Math.floor(i / ROUTE_SHARD) + '_' + Math.floor(j / ROUTE_SHARD);
export const ROUTE_SHARD_DIR = 'data/access-routes';
export const routeShardFile = key => ROUTE_SHARD_DIR + '/' + key + '.json';

/* ===================== the edge of the data =====================

   The bake holds Washington's roads and about 2.8 km past them — the tile padding — and nothing
   beyond that. So a cell near a LAND border can be handed a way round that exists only because the
   shorter way out of state is not in the file. The deepest drive in the state says it plainly: 141
   minutes and 35 miles, for a cell 2 km from Idaho whose nearest pavement is 4 miles east, in Idaho.
   167 of the 780 cells with a drive over an hour are within 15 km of a border, against 11% of cells
   overall.

   The rule that matters is which borders count. The first 14 vertices of the state outline are the
   land ones — the 49th parallel, the Idaho line, the 46th parallel and the Columbia. The Pacific
   coast and the Strait of Juan de Fuca are deliberately left out: no road is missing out there, and
   flagging every coastal cell would turn a real caveat into noise.

   Nothing is stored for this. A cell's position and the figure's own length are enough, which is why
   it needed no re-bake — and why a REGIONAL bake is the one case it gets wrong: its coverage ends at
   its own bbox, not at the state line. The shipped file is always a statewide bake. */
export const WA_LAND_BORDER = WA.slice(0, 14);   // ...49th parallel, Idaho, 46th parallel, the Columbia to its mouth
export const EDGE_PAD_M = 2800;          // how far past the last cell the fetch's tile padding reaches
export const EDGE_DOUBT_SHARE = 0.5;     // doubt the figure when the data ends inside half its length

const M_LAT_B = 111320;
function segMetres(lat, lon, a, b) {     // a, b as [lon, lat], the outline's own order
  const k = 111320 * Math.cos(lat * Math.PI / 180);
  const ax = (a[0] - lon) * k, ay = (a[1] - lat) * M_LAT_B, bx = (b[0] - lon) * k, by = (b[1] - lat) * M_LAT_B;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const s = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
  return Math.hypot(ax + s * dx, ay + s * dy);
}
/* How far the nearest land border is, and whose it is. */
export function borderDistance(lat, lon) {
  let m = Infinity, seg = 0;
  for (let i = 1; i < WA_LAND_BORDER.length; i++) {
    const d = segMetres(lat, lon, WA_LAND_BORDER[i - 1], WA_LAND_BORDER[i]);
    if (d < m) { m = d; seg = i - 1; }
  }
  /* segment 0 is the 49th parallel, 1 and 2 the Idaho line and the jog to the Snake, the rest Oregon */
  return { m, who: seg === 0 ? 'British Columbia' : seg <= 2 ? 'Idaho' : 'Oregon' };
}
/* Whether a figure of this length, at this place, could be an artifact of the state-shaped hole in
   the data — and if so, how far out the bake can see from here. */
export function edgeDoubt(lat, lon, metres) {
  if (lat == null || lon == null || !(metres > 0)) return null;
  const b = borderDistance(lat, lon), reach = b.m + EDGE_PAD_M;
  return reach < metres * EDGE_DOUBT_SHARE ? { who: b.who, border: b.m, reach } : null;
}
export const borderNote = d => d
  ? 'The bake holds Washington\'s roads only, and they stop about ' + accessDistance(d.reach)
    + ' from here at the ' + d.who + ' line — a shorter way in from ' + d.who + ' would not be in this figure.'
  : '';

/* ===================== the bike =====================

   The bike rides from where the car stops — level 1-2 roads, tracks and singletrack, the ways a truck
   cannot use — and walks whatever is left. Three speeds, because a graded road and a singletrack are
   not the same ride:

     road   12 mph   pavement, a graded forest road (level 4-5), a street
     rough   8 mph   level 3 and below, tracks, and every forest road nobody rated
     trail   5 mph   singletrack and paths

   plus 8 minutes per 100 m of climb, which is a steep forest road at a pace most people push rather
   than ride. As with the other modes the metres are stored per class and the minutes computed here,
   so a speed can be retuned without a re-bake.

   Two things stop a bike:

     - **Designated wilderness.** A bicycle is illegal inside one by federal law, not by a gate. From
       the USFS EDW wilderness layer, and marked per EDGE rather than per way, because a trail crosses
       a boundary in the middle of a way. The layer is FOREST SERVICE ONLY: it does not hold the
       national park wildernesses, and bicycles are banned on nearly every national park trail as
       well — BIKE_PARK_NOTE says so on the sheet.
     - **bicycle=no, private or dismount in OSM.**

   And one thing that does NOT: a road the Forest Service has closed to MOTORIZED use. A bicycle is
   not a motor vehicle, such a road is generally legal to ride, and riding past a gate is the whole
   point of bringing one. v8 blocked it — the user's first instruction, taken conservatively — and v9
   lifts it on the user's own reversal, with the measurement behind it: 4,109 cells (8.8%) quicker by
   a median 12 minutes. **Do not re-tighten this by reading the original instruction.** See
   ROADMAP.md, "Bikes may ride roads closed to motor vehicles". The DIRT BIKE, when it lands, is the
   mode that layer really does stop. */
export const BIKE_MPH = { road: 12, rough: 8, trail: 5 };
export const BIKE_CLASSES = ['road', 'rough', 'trail'];
export const BIKE_CLASS_LABEL = { road: 'road', rough: 'rough road or track', trail: 'trail' };
export const BIKE_CLIMB_MIN_PER_100M = 8;
/* False since v9, deliberately: see the reversal above. Kept as a flag rather than deleted because
   the closed-roads layer is exactly what the dirt bike mode must respect, and because a rule this
   project has changed its mind about should stay visible. */
export const BIKE_BLOCKS_CLOSED_ROADS = false;
export function rideMinutes(b) {
  if (!b) return null;
  let m = 0;
  for (const c of BIKE_CLASSES) m += (b[c] || 0) / (BIKE_MPH[c] * 1609.34 / 60);
  return m + Math.max(0, b.up || 0) * BIKE_CLIMB_MIN_PER_100M / 100;
}
export const rideMetres = b => b ? BIKE_CLASSES.reduce((s, c) => s + (b[c] || 0), 0) : null;
export const bikeTravelMinutes = b => b ? rideMinutes(b) + footMinutes(b.walk) : null;
export const BIKE_NOTE =
  'The ride is from where a car stops, at 12 mph on a road, 8 on a rough one and 5 on a trail, plus '
  + '8 minutes per 100 m of climb. Whether a trail is rideable at all is not in the map.';
export const BIKE_PARK_NOTE =
  'Wilderness and closed roads come from the Forest Service layer. It does not cover the national '
  + 'parks, and bicycles are banned on nearly every trail in them.';

/* ===================== the dirt bike =====================

   Between the bike and the drive: faster than pedalling, goes where a truck cannot, and stopped where
   a bicycle is not. The user rides one, and it is how they get past a gate on a road too rough to
   drive.

     road    25 mph   pavement, a graded forest road, a street — no faster than the truck on good road
     rough   20 mph   level 3 and below, tracks, unrated spurs, gated roads: where the mode earns its keep
     trail   10 mph   singletrack, and only where motorized use is designated

   plus 2 minutes per 100 m of climb: a motor barely notices grade, and what slows a climb is the tread,
   which the speed classes already carry. (A bicycle pays 8 and a walker 10.)

   What stops it, and this is where it differs from the bicycle:
     - designated wilderness, as for everything;
     - roads the Forest Service has closed to MOTORIZED use — this layer does apply here, and it is
       the whole reason BIKE_BLOCKS_CLOSED_ROADS was kept after the bicycle stopped needing it;
     - motor_vehicle=no and the rest of the access tags a car respects;
     - singletrack with no recorded motorized designation, which is most of it.
   A GATE does not stop it, any more than it stops a bicycle: riding round one is the point of the
   machine. What stops it is a closure that names motor vehicles. */
export const MOTO_MPH = { road: 25, rough: 20, trail: 10 };
export const MOTO_CLASSES = ['road', 'rough', 'trail'];
export const MOTO_CLASS_LABEL = { road: 'road', rough: 'rough road or track', trail: 'designated singletrack' };
export const MOTO_CLIMB_MIN_PER_100M = 2;
export function motoMinutes(b) {
  if (!b) return null;
  let m = 0;
  for (const c of MOTO_CLASSES) m += (b[c] || 0) / (MOTO_MPH[c] * 1609.34 / 60);
  return m + Math.max(0, b.up || 0) * MOTO_CLIMB_MIN_PER_100M / 100;
}
export const motoMetres = b => b ? MOTO_CLASSES.reduce((s, c) => s + (b[c] || 0), 0) : null;
export const motoTravelMinutes = b => b ? motoMinutes(b) + footMinutes(b.walk) : null;
export const MOTO_NOTE =
  'The ride is from where a car stops, at 25 mph on a road, 20 on a rough one and 10 on singletrack, '
  + 'plus 2 minutes per 100 m of climb. A gate is not counted as a stop; a closure that names motor '
  + 'vehicles is.';
/* A conservative mode has to be legible as conservative: say what is being left out rather than let a
   rider assume the trails are not there. The mileage comes from the bake, in the mode file. */
export function motoExcludedNote(x) {
  if (!x) return 'Only singletrack recorded as open to motorcycles is counted. Trails with no '
    + 'designation recorded are left out, and most have none.';
  const mi = n => Math.round(n).toLocaleString();
  return 'Only singletrack the Forest Service records as open to motorcycles is counted — '
    + mi(x.designated_mi) + ' mi of it. Left out: ' + mi(x.undesignated_mi) + ' mi of USFS trail with '
    + 'no designation recorded, ' + mi(x.nonmotorized_mi) + ' mi recorded as non-motorized, and '
    + mi(x.osm_only_mi) + ' mi of path that only OpenStreetMap maps, which rarely says either way. '
    + 'Motorized designation is the thing in this figure most likely to be wrong.';
}

/* ===================== the files, and what is in a row =====================

   v9 SPLITS the data. Up to v8 every mode's columns sat in one row of one file, and with three modes
   that file was 2.93 MB over the wire before a fourth was written — every byte of it fetched by a
   viewer who uses one mode. So:

     data/access.json        the base: the three category columns, the worst case, and which mode
                             files exist. Fetched always.
     data/access-hike.json   the hike figure and the straight-in alternative
     data/access-drive.json  the drive
     data/access-bike.json   the bicycle
     data/access-moto.json   the dirt bike, plus what its designation rule excludes

   Each mode file is fetched when that mode is on screen and cached for the session, so the up-front
   download stops growing with the number of modes. Rows are keyed by cell index in every file, so a
   mode file can be missing, stale-checked and refused on its own.

   The rows, all metres, all -1 for "no figure" in the group's first column — and note that 0 is a
   real answer for several of them (no pavement on the drive, no road on a ride), which is why the
   sentinel is negative and not zero:

     base:   i, j, then per category [d, wayIndex, walk, gain, offGain], then worst [on, onUp, off, offUp]
     hike:   i, j, on, onUp, off, offUp, parkE, parkN, stop, then direct [on, onUp, off, offUp]
     drive:  i, j, pavedM, gradedM, roughM, up, on, onUp, off, offUp, parkE, parkN, stop
     bike:   i, j, roadM, roughM, trailM, up, on, onUp, off, offUp, parkE, parkN, dismountE, dismountN, stop,
             then the mode's own worst case [roadM, roughM, trailM, up, on, onUp, off, offUp, stop]
     moto:   i, j, the same shape as bike

   The base file's worst case still serves the hike and the drive, because a gate strands both of them
   on foot at the pavement; only the two riding modes carry one of their own, and only they need nine
   more columns for it. The rider's worst case has no park point and no route: the sheet states the
   figure and draws the mode's actual approach, and a second geometry per cell per riding mode would
   cost more than the bound is worth.

   A park point is metres east and north of the cell centre rather than an index into a table, so a
   regional merge has nothing to re-point. */
export const WORST_AT = 2 + 3 * ROW_STRIDE;
export const BASE_WIDTH = WORST_AT + 4;
export const MODES_IN_FILE = ['hike', 'drive', 'bike', 'moto'];
export const RIDE_MODES = ['bike', 'moto'];
export const MODE_WIDTH = { hike: 13, drive: 13, bike: 24, moto: 24 };
/* Where a riding mode's own worst case starts in its row: nine columns, the last the stop reason. */
export const RIDE_WORST_AT = 15;
export const modeFile = mode => 'data/access-' + mode + '.json';

const modeGroup = (row, at) => row[at] != null && row[at] >= 0
  ? { on: row[at], onUp: Math.max(0, row[at + 1]), off: row[at + 2], offUp: Math.max(0, row[at + 3]) } : null;
const parkAt = (row, at, lat, lon) => lat != null && lon != null
  ? [lat + row[at + 1] / 111320, lon + row[at] / (111320 * Math.cos(lat * Math.PI / 180))] : null;

/* The walker's worst case, in the BASE file because the hike and the drive share it: a closure leaves
   both of them on foot at the pavement. The riding modes have their own, below, and every mode's block
   shows one or the other. */
export const decodeWorst = row => modeGroup(row, WORST_AT);

/* A rider's own worst case: unloading at the nearest paved road and riding from there. The walk left
   at the end is usually the mode figure's own — the ride ends at the same blocked edge whether it
   started at the pavement or at the gate, only later — so -1 in its first column means "that walk",
   which is smaller on the wire and is also the thing the sheet wants to be able to say. */
const rideWorst = (row, at, walk) => {
  if (!(row[at] >= 0)) return null;
  return { road: row[at], rough: row[at + 1], trail: row[at + 2], up: Math.max(0, row[at + 3]),
           walk: row[at + 4] >= 0 ? modeGroup(row, at + 4) : walk,
           stop: row[at + 8] >= 0 ? row[at + 8] : STOP.none };
};

/* One mode's row, decoded into the shape the sheet reads. The ride modes share a shape — a bicycle
   and a dirt bike differ in their speeds and in what stops them, not in what is recorded. */
export function decodeModeRow(mode, row, lat, lon) {
  if (mode === 'hike') {
    const hike = modeGroup(row, 2);
    if (hike) { hike.park = parkAt(row, 6, lat, lon); hike.stop = row[8] >= 0 ? row[8] : STOP.none; }
    return { hike, direct: modeGroup(row, 9) };
  }
  if (mode === 'drive') {
    if (!(row[2] >= 0)) return {};
    return { drive: { paved: row[2], graded: row[3], rough: row[4], up: Math.max(0, row[5]),
                      walk: modeGroup(row, 6) || { on: 0, onUp: 0, off: 0, offUp: 0 },
                      park: parkAt(row, 10, lat, lon), stop: row[12] >= 0 ? row[12] : STOP.none } };
  }
  if (RIDE_MODES.includes(mode)) {
    if (!(row[2] >= 0)) return {};
    const walk = modeGroup(row, 6) || { on: 0, onUp: 0, off: 0, offUp: 0 };
    return { [mode]: { road: row[2], rough: row[3], trail: row[4], up: Math.max(0, row[5]), walk,
                       park: parkAt(row, 10, lat, lon), dismount: parkAt(row, 12, lat, lon),
                       stop: row[14] >= 0 ? row[14] : STOP.none,
                       worst: rideWorst(row, RIDE_WORST_AT, walk) } };
  }
  return {};
}

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
