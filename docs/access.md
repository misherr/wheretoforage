# Access: how you would reach a cell

For each cell: **which** way is mapped into it, what kind, how far, and enough
geometry to draw the approach. Not just "this is accessible" — the useful answer
is *which* trail or road, and how far along it.

## It is a separate axis, and must stay one

Access never filters, weights or modifies a score. A roadless cell with perfect
habitat is still a perfect cell; it is just a longer walk, and that is the
forager's call rather than the model's.

Three things keep that structural rather than a rule someone has to remember:

- it lives in `src/access.mjs`, **outside** `src/model/`, and the model imports
  nothing from it;
- it bakes to its own file, `data/access.json`, not into `data/cells.json`;
- `scripts/build-access.test.mjs` asserts that no file under `src/model/` so
  much as contains the word "access", and that `src/access.mjs` imports nothing
  from the model.

In the app it appears in its own "Getting there" section of the tap sheet, below
the score, and as a **sort** option in Top spots — reordering cells that were
already selected by score, never changing which cells qualify.

## What it says, and what it refuses to say

Coverage is uneven, especially on private timberland, so every label describes
the *map* rather than the ground: "a trail is mapped here", not "a trail exists
here". A cell with nothing mapped within about a mile reads as **unknown**, never
as "trailless" — confirmed-trailless is a claim this data cannot support, and
absence of a mapped way is not evidence of absence of a way.

| class | meaning |
| --- | --- |
| `trail` | a trail or path is mapped within `NEAR` (800 m) |
| `road` | a road passable by vehicle is mapped within `NEAR` |
| `rough` | a track, skid road or decommissioned spur is mapped within `NEAR` |
| `near` | nothing in the cell, but something within `REACH` (2 km) |
| `unknown` | nothing mapped within `REACH` |

**Naming the way does not upgrade any of that.** "Forest Road 2703" is more
useful than "road mapped", but it is still only what the map says: not confirmed
passable, not confirmed open this season, not confirmed legal to drive. The tap
sheet says so in as many words, and a test asserts the wording never drifts into
implying otherwise.

800 m is roughly "inside this cell" — a cell is about 1.6 km across — and 2 km is
"a short walk from it". Distances are stored per category and classified at load
time, so these thresholds can move without a re-bake.

## Sources

Both matter, and neither is sufficient alone.

**OpenStreetMap**, via Overpass. The only source that covers **private
timberland**, which is where the unnamed tracks, skid roads and decommissioned
spurs are. Those are the ways that actually reach cut-over ground, and the ones
most apps hide. `abandoned:highway`, `disused:highway` and `razed:highway` are
requested explicitly rather than treated as noise.

**USFS EDW**, authoritative on national forest. System roads carry an
`oper_maint_level`; 3–5 are maintained for passenger cars or better and count as
drivable, 1–2 are high-clearance or closed and count as rough. There is a
separate layer of roads closed to motorized use, which is decommissioned spurs
directly. Trails come from the NFS trails layer. All three are fetched by page
for the whole region — about 25 requests, where the per-tile fetch made 948 —
with **one way per path** of each record, and trails keep their `trail_type` so
the over-snow routes can be dropped. See
[Two sources, one road](#two-sources-one-road).

Attribution: OSM data is ODbL, and the licence is recorded in the output's
`provenance.sources`.

### Tags deliberately excluded

- `footway` and `steps` — in Washington these are overwhelmingly sidewalks and
  stairs. A genuine backcountry trail is tagged `path` or `bridleway`. Including
  them added 35,000 ways to a single Seattle tile and no trails anyone would
  walk to forage.
- bare `highway=service` — driveways and parking aisles. `service=forestry`,
  `forest` and `logging` **are** kept: that is how a lot of timber spurs are
  mapped.

### Tags that look drivable and are not

A drivable `highway=` value with `4wd_only=yes`, `motor_vehicle=no`, or
`smoothness=impassable`/`very_horrible` — or with a dirt/earth/ground surface —
is reported as **rough** rather than as a road. Those tags describe the road, and
a description beats a class. So is `highway=road`, which means "classification
unknown" rather than "drivable".

Where USFS also maps the road, its maintenance level decides instead, and the
same three describing tags still override it — as does a paved surface in the
other direction. See [Two sources, one road](#two-sources-one-road).

## What is stored

```
ways: [ [name, ref, type, catIndex, trailheadKind, osmId, segments], ... ]
rows: [ [i, j,  dRoad, wRoad, walkRoad, gainRoad,
              dTrail, wTrail, walkTrail, gainTrail,
              dRough, wRough, walkRough, gainRough], ... ]
```

Per cell, per category: the straight-line distance, an index into `ways`, the
walk along that way from its trailhead, and the cumulative climb over that
stretch. `-1` anywhere means "not found within the cap", "no way", or "not
computable". A cell with nothing mapped at all gets **no row** — the app reads a
missing row as unknown, which is the same answer and costs nothing to store.

A way carries its OSM way id where it came from OSM, which is what makes an
exact external link possible, and a segment count, which is what lets the sheet
say a route was assembled from several mapped pieces. `osmId` is `null` for USFS
features; `segments` is 1 for a way that needed no joining.

**Gain never appears without a walk.** Both are measured from a trailhead, so a
climb with no start point would be a number with no meaning. `accessDetail`
enforces that, and a test asserts a stray gain value cannot surface on its own.

### Geometry lives in its own file, fetched on demand

The up-front download is `access.json` — rows, way names, types, distances,
walks and climbs: **4.97 MB**. The polylines are `access-geom.json`, **5.52 MB**,
and the app does not touch it until someone taps "Show the approach on the map".
Most viewers never will, and nobody needs 50,614 polylines to draw one line.

That keeps the up-front payload at **15.9 MB** of a 21.4 MB total. The two files
are index-aligned and stamped from the same run; `mergeInto` moves geometry in
lockstep with the ways table, because drifting indices would draw the wrong line
for a cell, and a test asserts they stay paired. They also carry a **format
version** that the app checks: rows went from 3 numbers per category to 4 and
ways from 5 fields to 7, and a v3 file read by a v4 reader does not fail — it
takes one category's distance as another's way index and reports it with a
straight face. A version the app does not know is refused and every cell reads
as unknown.

### The geometry URL carries the bake stamp, and that is load-bearing

`access-geom.json` is fetched `force-cache` — "use the cached copy whatever its
age" — which is right for a 5.5 MB file that never changes at a given URL and
wrong for one that gets re-baked. On the first v4 deploy the server served
`access.json` v4 while `access-geom.json` came back **v3 from the browser's disk
cache**: 53,200 entries against 50,614, and it would have stayed that way
indefinitely for any returning viewer.

The format check turned that into "Could not load the line" instead of wrong
lines drawn in silence, which is the honest failure — but the feature was still
broken, and before that check existed the same staleness would have drawn a
previous bake's geometry with no sign of trouble. So the URL is keyed on the
bake's own `generated` stamp, which makes the cache entry change exactly when the
data changes and `force-cache` both safe and optimal. `access.json` is fetched
`no-cache`, so the stamp is always the live one.

Caught by verifying the deployed site rather than the local one. A local server
sends no far-future caching and had nothing stale to serve.

### What removing the clip and adding the figures actually cost

Measured, not projected — the projection was made first from the v3 statewide
file and came in 4% high:

| | v3 | v4 | |
| --- | --- | --- | --- |
| `access.json` (up front) | 4.12 MB | **4.97 MB** | +20.4% |
| `access-geom.json` (lazy) | 5.39 MB | **5.52 MB** | +2.5% |
| total | 9.51 MB | **10.49 MB** | +10.3% |

The attribution matters. **Storing full geometry costs +0.13 MB, and only on the
lazily-fetched file.** The +0.85 MB up front is the climb column and the OSM way
ids — the walk and the external link, not the un-clipping. If that ever needs
reclaiming, the climb column is the place to look: it is `-1` for most rows and
could move into the geometry file, at the cost of the climb not appearing until
the line is fetched.

### Geometry is shared, not duplicated — measured, not assumed

Storing a copy of the relevant geometry against every cell was measured at
**47 MB** statewide. Sharing by way and storing full geometry was measured at
**74 MB** — *worse*, because the ways that end up referenced average 78 points
each and only 10.3% of fetched ways are ever a nearest. What works is sharing
**and** compressing:

| encoding | projected statewide |
| --- | --- |
| duplicated per cell | 47 MB |
| shared, full geometry | 74 MB |
| shared, simplified 20 m | 15.0 MB |
| shared, simplified + 4 dp | 13.9 MB |
| **shared, simplified + delta-encoded** | **8.0 MB** |
| shared, simplified 40 m + delta | 6.6 MB |
| rows alone, no geometry | 1.7 MB |

Measured on six real tiles covering 1,518 cells and scaled by 31.6×. So:

- **Douglas-Peucker at 25 m.** Keeps 16% of the points; about 2 px at zoom 14,
  which is the zoom you look at an approach from. Applied only to the STORED
  copy — distances are computed from full geometry, so simplification can never
  move a cell's class.
- **Delta-encoded integers at 1e5** (about a metre). Halves it again.
There used to be a third step, and it has been removed:

- **~~Clipped~~ to the stretch within 2.6 km of a cell that references it.** It
  saved 3.7% of points — 621,072 became 598,127 — and it truncated every tapped
  trail whose far end ran past the cells that reference it. A trail that draws as
  a partial line is the feature not working, so a 3.7% saving was not a trade
  worth making. Full geometry is now stored for every way a cell references, and
  a test asserts a way running well past the cells keeps its whole length.

Since geometry lazy-loads on tap it is no longer part of the up-front payload,
which is what makes storing it in full affordable at all.

## A route, not a segment

The reported symptom was "trails draw truncated". The clip was the obvious
suspect, and measuring it first is what stopped a plausible diagnosis from being
the whole answer: it accounted for 3.7% of points, the median drawn way was
2.14 mi and p90 8.03 mi, and the specific trail that prompted the report was a
single complete 1.02 mi way that was never clipped at all.

The dominant cause is **fragmentation**. OSM splits a named way at every tag
change and every junction, so a long route arrives as many separate ways: 68 of
them tagged "Pacific Crest Trail", 71 tagged "US 101". Drawing only the segment
nearest the cell looks like a fragment of a trail because it is one.

In the bake, 2,091 of 50,614 stored routes were assembled from more than one
mapped way. The clearest single case: Baker Lake Trail arrived as ways of 7.18 mi
and 2.37 mi and is stored as one 9.54 mi route, 68 points, verified drawn
end-to-end in the browser.

So segments are chained before anything is stored. Two segments join when they
share `cat`, `type`, `name` and `ref` and an endpoint within 40 m. Both parts of
that matter — a name shared across the state ("Forest Road 23") is not one
route, and neither are two unnamed tracks that happen to touch, so an unnamed
way is never joined to anything.

**A junction is never chained through.** Guessing a path through a fork would
invent a route nobody can walk. The test for that is endpoint *degree* computed
over the whole group: a point where exactly two segment ends meet is a join,
three or more is a junction. Two bugs found while writing it, both of which a
single happy-path fixture would have missed:

- Asking "is there exactly one unused candidate left?" is a different question.
  At a three-way fork the first seed correctly refuses, and by the time the
  second seed looks the first is already marked used, so the fork looks
  unambiguous and gets joined. Degree is a property of the group, not of how far
  the loop has got.
- The incoming segment has to run *into* the join whichever end of the chain is
  growing: appending at the tail needs a segment that starts at the point,
  prepending at the head needs one that ends there. Reversing on the matched end
  alone is right for one case and backwards for the other, which produced a
  chain with a doubled point and a silently dropped segment.

A joined route keeps the strongest trailhead found on any member and the OSM id
of its longest constituent, and records how many pieces it came from so the
sheet can disclose it. The walk and the climb are re-measured on the joined
geometry, so the figures describe the line that is drawn.

**Joining is deliberately conservative, and the PCT shows the limit.** Its 68
"Pacific Crest Trail" ways collapse to 28 stored routes, not to one: it crosses
side trails constantly, and every one of those is a junction the chaining refuses
to pass through. That is the right trade — a wrong through-route drawn with
confidence is worse than a real route drawn in pieces — but it means a long trail
crossing a dense network still draws in sections, and the fix for that would be
OSM route *relations*, which are a separate data source, not a tweak to this.

Grouping is also by exact name, so the same trail tagged "Pacific Crest Trail"
on one way and "PCNST" on the next stays two routes. Loosening that would start
merging genuinely different ways, which is the failure the strictness is for.

The largest gain from joining is not the drawn line at all: **cells with a walk
figure went from 10,001 to 26,695**, because a cell in the middle of a route now
inherits the trailhead on the segment at its far end. (Of those, 10,604 are cells
where the sheet *shows* the walk — see "Stored is not the same as shown" below.)

## How far along the way

Straight-line distance is not what determines the walk, so where a trailhead is
known the stored figure is the distance **along** the way from it.

There is no USFS trailheads dataset in EDW, and OSM's dedicated
`highway=trailhead` tag is sparse — 13 nodes across six sample tiles. Relying
on it alone would leave a walk figure for almost nobody. So trailheads come from
two places, and which one is used is recorded and shown:

- **mapped** — an OSM `highway=trailhead` node within 150 m of the way;
- **inferred** — the way ends within 60 m of a drivable road. That is where you
  leave the car, it is derivable from data already fetched, and the tap sheet
  labels it "from where the way meets a drivable road" rather than dressing a
  deduction up as a surveyed point.

Where neither applies, the sheet reports the straight-line distance and says
that is what it is.

## Distance and climb to the spot

For the named route the sheet reports the walking distance from the trailhead to
the cell and the cumulative climb over that stretch.

The climb is **cumulative positive difference sampled at every vertex of the
stored geometry**, not the difference between the two endpoints. A rolling
approach that climbs 300 m in four rises and gives most of it back is a 300 m
climb to walk; endpoint subtraction would call it flat. The samples come from
the same Terrarium tiles at the same zoom the cell bake reads, so the climb and
the cell's own elevation cannot disagree about the terrain.

The figures are rounded coarsely on purpose — the tiles are ~76 m per pixel at
z10 and the stored geometry is simplified to 25 m, so anything finer than the
nearest 50 ft would be false precision. Under 50 ft reads "negligible climb".

What is *not* done matters as much:

- **No trailhead mapped or inferrable** → the walk and the climb are reported as
  unavailable, and the sheet gives the straight-line distance labelled as such.
  Measuring from an arbitrary end of the way would produce a figure that looks
  like an answer.
- **Trailhead inferred** → the figures are shown and the sheet still says the
  start point is where the way meets a drivable road, not a surveyed trailhead.
- **Profile unavailable** (a terrain tile failed) → the walk is shown and the
  climb says it is unavailable. `-1`, never `0`.

## The DEM is not clean, and cumulative gain amplifies that

Cumulative positive difference is the right measure for a rolling approach and
the wrong measure for noisy data: every spurious upward step is added and none
is ever subtracted back out.

The Terrarium tiles contain patches of garbage. On tile `10/164/363`, in the
Mount St Helens blast zone, five adjacent pixels read 618, 101, 1295, 2820,
3087 where the terrain is around 900 m:

```
py=7:   953  818   752  1173  1480  1241  1055
py=8:  1143  618   101  1295  2820  3087  3072   <- garbage
py=9:  1203  459   -90   770   762   758   759
```

**That is not a decoding fault.** The browser's own PNG decoder returns the
identical bytes for that tile, which is how it was ruled out — worth repeating
before blaming the decoder, because the same check is what proved the decoder
right when `cells.json` was re-baked. It is what the source data says.

One such pixel pair contributed 2,719 m of the 4,608 m total on USFS trail 211 —
59% of the figure — and would have shipped as "15,100 ft of climb" on a 12 mi
trail. So the profile is filtered before it is accumulated, in two stages:

1. **A three-point median.** These artefacts are isolated single pixels, and a
   median removes an isolated spike of any magnitude while leaving a genuine
   slope untouched: the median of three monotone samples is the middle one.
2. **A gradient gate**, `MAX_GRADE` = 300%, as a backstop for two bad pixels in
   a row, which a three-point median cannot fix. The threshold is physical
   rather than tuned: over 4,159 steps sampled from 333 real routes the steepest
   implied gradient was **141%**, and 300% is 72° — neither walkable ground nor
   a real DEM slope. The step is skipped rather than clamped, so a spike adds
   nothing on the way up and no spurious rise on the way back down.

Both filters under-count across a bad patch rather than inventing metres, which
is the right direction for a figure presented as the climb to expect. Neither is
redundant, and a test proves it: a 400 m spike over a 165 m step is a 242%
gradient, under the gate, and only the median removes it.

What it did to the statewide figures:

| | before | after |
| --- | --- | --- |
| median climb | 102 ft | **46 ft** |
| p90 | 2,287 ft | **1,818 ft** |
| p99 | 6,972 ft | **4,777 ft** |
| max | 16,486 ft | **10,587 ft** |
| cells over 5,000 ft | 267 | **109** |

7,053 cells fell, 5,205 were unchanged and 4 rose by a metre or two. The 109
cells still over 5,000 ft are not noise — they are the long-walk cases below.

### The walk figure is unbounded, and past 10 miles it says so

It is the distance along that way from the only trailhead mapped on it, which is
what the data supports. Usually that is a short number, but the tail is long.
Measured over the 10,604 walks the sheet actually shows:

| | |
| --- | --- |
| median | 1.3 mi |
| p90 | 6.6 mi |
| p95 | 9.8 mi |
| p99 | 23.4 mi |
| max | 68.5 mi |
| over 10 mi | 522 cells, 4.9% of shown walks |
| over 20 mi | 143 cells, 1.4% |

The 68.5 mi case is a cell in the middle of the PCT whose only mapped trailhead
is at one end — and whose "Also nearby" line lists an unnamed trail **0.3 mi**
away. Nobody walks 68 miles to pick boletes; the real approach is unmapped, or
mapped without a trailhead.

**So past 10 miles the sheet says so, and does not touch the number.**
`WALK_DOUBT` is 16,093 m, the 95th percentile of shown walks and about four hours
each way, and `walkDoubtNote` adds: *"Almost certainly not the real approach.
This is the distance along the whole route from the only trailhead mapped on it,
and a nearer way in is likely unmapped, or mapped without a trailhead."* Where
another kind of way is within reach it adds *"Check Also nearby"*, and where
nothing is — 168 of the 522 — it does not, because sending a reader to an empty
section would be its own small lie.

The three obvious alternatives are all worse:

- **Capping it** replaces a measurement with an invention, and "10+ mi" hides
  that the honest answer is 68.
- **Hiding it** leaves the cell looking as though nothing is known about reaching
  it, which is false — the way, its name and its trailhead are all known.
- **Preferring a way with a nearer trailhead** would change which way the sheet
  names and which line it draws, and only the nearest way *per category* is
  stored, so the nearer trailhead usually is not in the data at all. Noted in
  [ROADMAP.md](../ROADMAP.md), not done.

The label is styled as a caveat rather than an error, because the figure is not
an error. It is a correct answer to a question nobody asked.

## The external link

**AllTrails does not work and is deliberately absent.** Checked rather than
assumed: a trail page, the explore map with bounds, the explore map with a
centre, and their search all answer HTTP 403 to a programmatic request, and
their per-trail URLs need a slug this data does not contain. Linking their
search with a trail name would be exactly the wrong-trail risk to avoid — the
same trail names recur across the state.

What is linked instead:

| link | when | why |
| --- | --- | --- |
| `openstreetmap.org/way/<id>` | the way came from OSM | it identifies the *exact* way the sheet just named. Verified 200 against real ids, e.g. way 174583494, "Baker Lake Trail" |
| `caltopo.com/map.html#ll=<lat>,<lon>` | always | works for USFS features too, and a topo view is what an approach needs. Verified 200 |

Gaia GPS was tried; its map deep link did not resolve, so it is not offered.

## Running the bake

```bash
node scripts/build-access.mjs                 # the whole state, ~316 tiles
node scripts/build-access.mjs --resume        # after an interruption
node scripts/build-access.mjs --region=coast  # merged into the existing file
```

**The checkpoint is kept on success, not deleted.** It holds the fetched,
unclipped geometry, and everything after the fetch — joining, elevation, the row
format, what gets stored — is assembly. Deleting it meant a change to any of
that cost a ten-hour re-fetch, which is exactly what happened once. With it
kept, `--resume` re-assembles in **30 seconds and zero network requests**. That
is the single most useful thing learned from this bake.

Rows are keyed by cell index `[i, j]`, not by position in `cells.json`, so a
re-bake of the cell file cannot silently shift the association. The output
records the `generated` stamp of the `cells.json` it was built against, and the
app warns in the console if they do not match.

Access is **optional** at runtime, and so is its geometry: with
`data/access.json` missing the app works exactly as before and every cell reads
as unknown, and with only the geometry file missing every route is still named,
just not drawable. Verified by deleting them: the statewide score hash is
211802998 either way.

### What the statewide bake actually produced

**46,373 cells** of 48,032 have a mapped way within 2 km; the other 1,659 (3.5%)
read as unknown. 461,608 ways were fetched, 53,361 of them were some cell's
nearest, and those joined into **50,614 stored routes** — 2,091 of them assembled
from more than one mapped way. 28,070 routes (55.5%) are named or numbered;
43,498 carry an OSM way id and so get an exact external link. 17,136 routes have
a trailhead, mapped or inferred, and **26,695 cells carry a walk figure** against
10,001 under the pre-join bake: joining is what earns that, because a cell in the
middle of a route now inherits the trailhead on the segment at its end. 33,416
walk values are stored in all, since a cell can have one per category, and 33,389
of them carry a climb.

**Stored is not the same as shown, and the difference is large.** `accessDetail`
reports only the *primary* category — the nearest way, which is what the class and
the drawn line are about — so the sheet displays a walk for **10,604 cells**, not
26,695. The other 16,091 have a walk sitting in a category the sheet is not
talking about: a cell 200 m from an unnamed track with no trailhead and 900 m from
a named trail with one shows the track. That is the right default and a real
limitation; it is in [ROADMAP.md](../ROADMAP.md) rather than fixed here, because
changing it changes which way the sheet names. 618,866 geometry points are stored, and elevation came
from 271 terrain tiles with no failures.

**0 areas were abandoned**, against 20 in the previous run, and only one tile
needed subdividing at all. That is not a code improvement — it is what a working
mirror looks like; see below.

It cost 309 Overpass requests, 59 retries and 901 MB, and the fetch took **36
minutes** rather than ten hours. Re-assembling from the checkpoint afterwards —
joining, elevation, rows, both files — takes **183 s and zero requests**, which is
what made the de-spiking fix above affordable to discover late.

### Overpass is the awkward part

Three things bit during the first statewide run, and the script handles all
three:

- **The main instance stopped answering entirely** partway through — a connect
  timeout, not a 429. A single hard-coded endpoint turns that into a dead job,
  so there is a mirror list and the script moves on to the next one.
- **All three mirrors went down at once, and the health probe could not tell.**
  A later run stalled at 10 of 316 tiles: two mirrors refused connections and
  the third answered `/status` in 16 s and then timed out at 90 s on a query
  returning six ways. `/status` is a static string that a queue-saturated server
  still serves, so it was kept as "up" while being useless — every tile paid two
  long timeouts before rotating off it, and 5 sub-areas were abandoned in 10
  tiles. Two fixes: **the probe is now a real query** (a tiny bbox, one cheap
  request per mirror per run, testing the thing we actually use), and there is a
  **fourth mirror**, because three is not redundancy if all three can be down
  together. It is still a pass/fail gate — the survivors keep their declared
  order, and nothing is ranked by how fast it answered, which is the older lesson
  below and still holds. The next run fetched 306 tiles in 36 minutes and
  abandoned nothing.
- **Dense tiles 504 on every mirror.** Overpass answers an over-expensive query
  with a failure rather than a partial result, and "expensive" tracks way
  density, so metro tiles fail while forest tiles answer in two seconds. On
  failure the script asks for quarters of the area instead, recursively. That
  adapts automatically, which is better than hard-coding a list of cities or
  dropping the urban classes and losing real access data with them.
- **Whole-tile responses are large.** A Seattle tile is ~100 MB unfiltered.
  Ways are streamed through a callback as each piece arrives rather than
  accumulated, so a metro area never has to fit in memory at once.

A way that spans a split line comes back from both halves. The stamp is a
minimum, so seeing it twice costs a little time and changes no answer.

## How the distances are computed

Each way's polyline is walked at 40 m steps and every cell centre within 2 km of
each step gets its minimum updated. The densification is not decoration: a
single long straight segment between two distant vertices would otherwise skip
straight past a cell it runs through, and that cell would read as unknown while a
highway crosses the middle of it. `scripts/build-access.test.mjs` has a test for
exactly that case.

Cells are a regular lattice, so the candidates for any point are a small fixed
box of cell indices rather than a spatial search.

## A tap and a Top spots row must be the same cell

Reported: access appeared when opening a cell from Top spots and not when
tapping the map, including on cells next to ones that worked. Both paths read the
same per-cell data, so this was a join bug, and it turned out to be two of them.

### The lookup lived in one path instead of all of them

`e.access` was assigned in exactly one place — the loop that loads baked cells.
Four places build an entry:

| path | builds | had access |
| --- | --- | --- |
| the baked-cell loader | every cell in `cells.json` | yes |
| `pointEntry` | an exact point | **no** |
| `buildCells` → `refine()` | sub-mile cells when zoomed in | **no** |
| `scoreBlocks` | cells on the live (non-public) load | **no** |

Top spots hands `showPoint` a baked cell, so it always worked. A map tap resolves
`cells.get(cellKey(lat,lon))` and **falls through to `pointEntry` whenever that
misses** — which it does for every point outside the 48,032 baked cells.

The keying was never the problem, though it looks like the obvious suspect:
`STATIC.access.byCell` is keyed `i:j` from the row's own first two fields, and
`cellKey(lat,lon)` produces exactly that string. Both paths agreed about the key.
One of them simply never asked.

**What made it dangerous rather than merely missing.** An entry with no access is
`undefined`, `classifyAccess(undefined)` is `unknown`, and the sheet renders that
as *"No mapped access — Nothing is mapped within about a mile. That may mean no
way exists, or simply that nobody has mapped one."* Careful, hedged, and false:
the row was in the index the whole time. Measured on the same coordinates,
46.49425,-121.4343:

| path | Access |
| --- | --- |
| tap | **PCNST Trail** (9 mapped segments joined), 68.5 mi walk, "Also nearby: unnamed trail 0.3 mi" |
| the same point, exact | **No mapped access** |

A false negative dressed as a careful one is worse than a blank, because nothing
about it invites a second look.

The fix is a wrapper, `withAccess()`, around every `makeEntry` call. It cannot go
inside `makeEntry`: that lives in `src/model/`, and the model may not know how
reachable a cell is — two tests enforce that, in both directions. A wrapper at the
one shared constructor is what makes a fifth path get access for free instead of
silently reading as trailless.

### And a cell the bake never examined was told that nothing is mapped

The first fix does nothing for a point with no row at all, and that is the more
common case. The bake walks the cells in `cells.json` and writes a row where it
found something:

- 46,373 rows, **all** of them for baked cells (0 fall outside it)
- 1,659 baked cells with no row — examined, nothing within `CAP`. Honestly unknown.
- everything else in the state — **never examined**, because `cells.json` holds
  48,032 of roughly 69,600 in-state lattice cells and the rest were gated out as
  non-habitat.

**31.5% of taps that land inside Washington land outside the baked set.** A tap
goes wherever a finger goes; the bake only covers plausible habitat. Those places
are shrub-steppe, farmland, water and town — full of roads — so "nothing is
mapped within about a mile" there is not just unproven, it is usually flatly
wrong. Verified at 46.8628,-119.7086 near Othello.

So coverage is now tracked separately from content. `STATIC.access.examined` is
the set of cells the bake walked, and a point outside it reads *"Access not
checked here — this point is outside the cells the access bake covers, so no way
was looked for near it. That is not the same as nothing being mapped."* With no
examined set (an older `access.json`, or `cells.json` missing) the app assumes
examined, which is the previous behaviour rather than a map that says "not
checked" everywhere.

This is the same rule the file-level guard already applied — with no access file
the section is omitted rather than rendered as "nothing is mapped" — applied per
cell instead of per file.

### An exact point says whose access it is

An exact point and a sub-mile refine cell are both smaller than the square mile
access is measured for, and the distances are from the **cell centre**, up to
about half a mile from the tap. Both now carry: *"Access is for the square-mile
cell containing this point, not for the exact coordinate — distances are measured
from the cell centre."*

One edge worth knowing: `exactPoint` rounds the tap to 4 dp before building the
entry, which can move it by ~5 m, so a tap within 5 m of a cell boundary can be
attributed to the neighbour. On a 1.6 km cell that is the right trade, and the
sheet describes the cell it actually resolved. The parity test's containment
assertion is what surfaced it — it caught a bad fixture of mine on the first run.

## "The walk" was the wrong quantity

Reported: cells showing a walk of 0 ft with no trail entering the area. Traced
end to end before changing anything, on real cells. It is both a definitional
error and three bugs, and the definitional error is the bigger half.

### What the number actually measured

`walk = |arc(nearest point on the route to the CELL CENTRE) − arc(trailhead)|`

Distance along the way, from its trailhead, to **the point on the way nearest the
cell**. It stops at the trail. Getting from there to the cell was never in it.

Three traced cells, all reporting 0:

| | cell 3272:-5605 | cell 3297:-5792 | cell 3181:-5678 |
| --- | --- | --- | --- |
| centre | 47.45125,-119.93630 | 47.81375,-123.93810 | 46.13175,-121.49850 |
| route | Moses Stool Road | unnamed track | South Climb Trail (2 joined) |
| trailhead | inferred | inferred | inferred |
| route length | 7,688 m | 1,580 m | 5,187 m |
| nearest point to the cell | **at arc 0** | **at arc 0** | **at arc 0** |
| its distance from the cell | 1,949 m | 1,909 m | 442 m |
| trailhead arc | 0 | 0 | 0 |
| **reported walk** | **0 m** | **0 m** | **0 m** |

In each case the route's closest approach to the cell *is its own start*, the
inferred trailhead is pinned to that same start, and the subtraction is zero. The
route then runs away from the cell — it never comes near it at all. The figure
was true and useless, and it read as "no walk", which is the opposite of the
truth: 1.9 km of trackless ground.

And it is not only inferred trailheads. Cell 3299:-5750 (47.84275,-123.03930) is
on the USFS trail MT. TOWNSEND with a **mapped** trailhead, and reports a 27 m
walk — because the mapped node happens to sit beside the point on the trail
nearest the cell, which is itself 1,511 m away.

### Confirmed, ruled out, quantified

Over the 10,604 cells that displayed a walk:

**A zero by construction, from a trailhead coinciding with the nearest point —
confirmed.** 924 cells reported exactly 0 and 1,589 under 100 m. 8,329 of the
displayed walks come from an inferred trailhead, and **92.1% of those are
consistent with a trailhead arc of 0**, because the bake left `thArc` at 0 for
every inferred trailhead. 95 cells reported 0 while the way was more than 800 m
from the cell centre.

**Nearest point to the centre or to the boundary — the centre.** 91.2% of stored
distances equal the centre projection exactly. A cell is 1,611 × 1,609 m, so at a
corner the boundary is up to 1,139 m nearer than the centre. This stays: the
centre is where the score, the terrain and the vegetation are all measured, and a
distance to the nearest corner of a square mile would be a distance to somewhere
nobody is going. It is now labelled as being to the centre.

**A way selected that never comes near the cell — confirmed.** A way is recorded
for a cell when any point on it is within `CAP` (2 km) of the cell centre.
**1,281 cells (12.1%) name a route that never enters the cell**, and 2,247
(21.2%) have their closest approach at a route *endpoint* — the route stops short
and runs away. That selection is not itself wrong; "the nearest mapped way within
2 km" is what the class means. What was wrong was reporting a walk along it as
though it reached the cell.

**Joining broke the along-way distance — half confirmed.** The cell side was
fine: the code re-projects the cell onto the joined geometry. The trailhead side
was not. 1,388 cells sit on a multi-way route and **60.2% of those were pinned to
arc 0 of the whole chain**, which can be a different member entirely, since
`joinRoutes` reverses and reorders members as it builds one.

**And one more, found while checking the above: the walk was often measured from
the wrong end.** The inference recorded *that* a way met a road, never *which
end* did. Sampling 25 inferred-trailhead routes and checking both ends against
OSM drivable roads **and** the USFS road layer:

| | routes |
| --- | --- |
| arc 0 is at a road, the far end is not | 7 |
| both ends are at a road (loops, through-routes) | 12 |
| **only the FAR END is at a road — measured backwards** | **5** |

Tyler Peak Trail is the clearest: its arc 0 sits **1,971 m** from the nearest
drivable road of any kind, its far end is on one, and the walk was measured from
arc 0. (A sixth case, BEAR LAKE, looked like a trailhead with no road at either
end until the USFS layer was queried too — a road is 1 m from its arc 0. That one
was my error, not the bake's, and it is why both sources had to be checked.)

**The leg that was missing.** From the nearest point on the route to the cell
centre: median **386 m**, p90 1,002 m, p99 1,783 m, max 1,993 m. For **2,460 of
10,604 displayed walks the omitted leg was longer than the reported one**.

### So: an approach has two legs, and v5 reports both

```
on-trail    trailhead ──────────────► nearest point on the route     along the route
off-trail   nearest point ──────────► cell centre                    STRAIGHT LINE
total       the two added
```

The off-trail leg is the honest part and the dangerous one. It is a straight line
over ground nobody has walked, and the sheet always says so:

> straight line to the cell centre — no trail, and it takes no account of
> terrain, brush, blowdown or water. A quarter mile of slide alder is not a
> quarter mile of trail.

Its climb is measured the same way as the on-trail figure — the same Terrarium
tiles at the same zoom, sampled every 100 m, the same 3-point median, the same
cumulative positive difference with the same 300% gradient gate — because two
numbers shown side by side and then added must not be measured two different
ways.

A **total climb is only reported when both halves are known.** Adding a measured
leg to an unmeasured one and calling the sum "the climb" would be the same
overclaim as measuring a walk from a trailhead that does not exist.

The 10-mile caveat now judges the **total**, not the on-trail leg: 3 mi of trail
plus a mile of bushwhacking is the same problem as a 4 mi trail walk, and a cell
with a 0 m on-trail leg and 1.9 km off-trail was previously flagged by nothing.

### The three fixes in the bake

1. **A trailhead is a place, not a flag.** Both kinds now record a coordinate —
   the way end that met the road, or the mapped node — and `thArc` is that point
   projected onto the finished route. One code path instead of two, immune to
   which end matched and to `joinRoutes` reversing a member.
2. **A trailhead that cannot be placed gets no walk**, rather than a walk from an
   assumed end. `provenance.counts.trailheads_unplaced` reports how many, so a
   regression shows up in the file.
3. **The category distance is measured on the stored geometry**, not on the
   pre-join, pre-simplify original. It is therefore exactly the off-trail leg, the
   two legs meet at the same coordinate, and every number describes the line the
   app draws. It also means the class is decided on the geometry you can see.

### v5, and what it costs

Row stride 4 → 5: `[d, wayIndex, onWalk, onGain, offGain]` per category, where
`d` is the off-trail leg. One extra column rather than two, because the off-trail
*distance* is the category distance once both are measured on the stored
geometry — a redefinition that pays for itself.

### Every category carries its own approach now

26,695 cells hold a walk value and only **10,604 displayed one**, because
`accessDetail` reported the primary category alone. The primary is chosen by
class precedence, so a cell whose nearest trail has no trailhead named that trail
and went silent while the road beside it had a perfectly good figure.

**The naming does not change, and that was a decision rather than an omission.**
Switching the named route to whichever one carries a walk would rename 16,091
cells — **12,331 of them from a road to a rough track**, which is to say from the
road you would drive to a logging spur. So the figures go to the alternatives
instead: "Also nearby" now carries each category's own off-trail leg, on-trail
leg and total, with where it measured from.

## Coordinates in and out

`src/coords.mjs`. Out: `47.45125, -119.93630` — decimal degrees with a minus
sign rather than a hemisphere letter, because that form pastes into onX, Gaia,
CalTopo, AllTrails and Google Maps and `119.93630 W` does not work reliably in
any of them. Selectable as well as copyable: `navigator.clipboard` is
unavailable on an insecure origin and refused outright by some browsers, and a
readout you cannot select would then be a dead end.

In: an input that accepts what people actually paste — decimal degrees in any
spacing, hemisphere letters leading or trailing, and the degrees-minutes-seconds
the iPhone Compass app shows (`47°27'04" N 119°56'11" W`), including the primes,
curly quotes, masculine ordinals and en-dashes that real clipboards deliver.

It is **strict**, and that is the design: anything it cannot read returns null and
the panel says so. A pin dropped in the wrong drainage is worse than an error
message, because the user would drive to it. Two consequences worth knowing:

- `47 27.07 N 119 56.18 W` is **refused**. Without symbols those digits are
  genuinely ambiguous with the pair (47, 27.07), and every app that emits a
  minutes form includes the symbols.
- `-119.9363, 47.45125` is **repaired** to lat 47.45125, because a first value
  beyond 90 cannot be a latitude. `47, -46` is *not* repaired — both are valid
  latitudes, so the conventional order stands rather than a guess being made.

A pasted coordinate resolves through `showAt()`, the same function a map tap
uses. That is deliberate: the last thing to go wrong in this area was two paths
into `showPoint` that disagreed about a cell.

## Two sources, one road

OSM and USFS both map most forest roads on national forest land, and the bake
used to keep both copies, each with its own category, each stamped onto cells and
each able to carry a trailhead. Where they disagreed about the same road, a cell
could read "drivable road mapped" off one copy while its rough entry was the
other. Three fixes, applied at assembly in this order, and then everything
downstream of a category — trailheads, which way each cell is nearest, the walks
— is recomputed.

Each was measured on its own by re-assembling the same checkpoint with one more
rule switched on (the method is in
[verification.md](verification.md#measuring-the-access-rules-one-at-a-time)):

| step | what changed | cells whose class changed | walks gone / new |
| --- | --- | --- | --- |
| USFS by page, one way per path | the geometry | 1 | 10 / 1 |
| over-snow routes dropped | 604 ways, 3,440 km | 850 | 883 / 31 |
| describing tags on OSM-only roads | 169 roads | 6 | 5 / 7 |
| USFS decides, with the exceptions | 1,347 roads | 894 | 722 / 427 |

Against the file that shipped, cell by cell: **1,609 cells change class** — 743
from drivable road to rough, 577 from trail to drivable road, 270 from trail to
rough — **1,753 lose a walk and 536 gain one**, 297 get longer, 420 shorter, and
8,150 are unchanged. The "almost certainly not the real approach" label is added
to 96 cells and removed from 227.

### Over-snow routes are not trails

604 USFS "trails" (3,440 km) are `trail_type=SNOW` — groomed snowmobile and ski
routes, many along roads, one along SR 20. In autumn they are the road, or
nothing. Dropping them moved **850 cells**: 727 from "trail mapped" to "drivable
road mapped", because the road the route ran along is what is there; 120 to
rough; 3 to "mapped way nearby". 883 walks went with them, most measured from a
trailhead inferred where the route met a road — a sno-park.

### USFS decides, and a description of the road overrides it

Where an OSM road or track runs along a USFS road record — within 20 m for at
least 150 m and half the shorter of the two — the two are one road. **10,522 OSM
ways have such a twin.** Where the USFS record covers at least half of the OSM
way, its maintenance level decides the category: 1,093 OSM ways change from
drivable to rough (OSM `unclassified` over a level-2 "high clearance vehicles"
record, mostly) and 254 from rough to drivable (OSM `track` over a level-3
"suitable for passenger cars" record).

Two exceptions, because those OSM tags describe the road rather than classify
it:

- **paved** (`surface=paved`, `asphalt`, `concrete`, `chipseal`) stays drivable
  over a level 1–2 record — 38 roads. USFS records lag; Bogachiel Road is paved
  in OSM and gravel in USFS. Not over the closed-roads layer: paving says nothing
  about a gate.
- **`4wd_only=yes`, `motor_vehicle=no`, `smoothness=impassable` or
  `very_horrible`** is rough over a level 3–5 record — 25 roads — and on an
  OSM-only road too, which moved 6 cells. Where the two exceptions collide, rough
  wins.

And two limits, both found by checking the result against the live sources:

- **USFS never decides a state or federal highway** (`motorway` to `secondary`
  and their links) — 28 kept. The first run demoted State Route 410,
  `highway=primary`, to rough.
- **USFS decides only what it covers.** That same SR 410 way was 3.3 km long and
  its "twin" a 337 m level-2 spur beside 7% of it: a genuine duplicate where they
  overlap, and no basis for the other 93%. 533 OSM ways covered less than half by
  their twin keep their own category.

The OSM copy keeps its geometry, which is joined to the rest of the network. The
USFS copy stays as well — it carries the road's number and covers what OSM lacks
— and takes its twin's category only when an exception flipped the twin and the
flipped twins cover 80% of it (22 records). 97 OSM ways run along two USFS
records that disagree with each other and take the one they run along longest.
253 USFS records still disagree with part of a twin, all partial overlaps.

**Cost: 894 cells change class, 886 of them from drivable road to rough.** That is
the intended direction — a level-2 road is not where a passenger car should be
sent — and it is the rule's largest effect on walks, below.

### A USFS record is one way per path

An ArcGIS polyline is a list of paths, and **60 EDW records** in the bake's area
arrive as several: 20 roads, 5 closed roads and 35 trails, 151 pieces between
them. The old fetch flattened each into one line, which drew a straight segment
across every gap — **91 of them, median 75 m, 90th percentile 879 m, and one of
9,948 m on a trail**. 58 of those gaps are wider than the 40 m that joinRoutes
bridges, so those pieces now stay separate and **43.6 km of line that was never
road or trail is gone**. The other 33 gaps are close enough that joinRoutes
chains the pieces again, as it would any segments of one named route.

### Trailheads are inferred after all of that

A trailhead is inferred where a non-road way ends within 60 m of a **drivable**
road, so every rule above reaches it. Inferred trailheads fell from 58,661 to
54,282; mapped ones barely moved (2,362 → 2,357, the difference being snow
routes).

**The check that mattered: no approach keeps a figure measured from a trailhead
that is not one any more.** A trailhead counts as lost when no way, referenced by
a cell or not, has a trailhead within 30 m of it after the rules: **1,476 of
16,089** — 1,339 with no drivable road within 60 m any more, 137 on dropped snow
routes. 3,301 approaches in 2,948 cells, counting every category a cell carries
and not only the named one, walked from one of them. After the rules:

| outcome | approaches |
| --- | --- |
| **no walk at all** — the way has no trailhead left | 2,596 |
| a walk from a different point, longer | 266 |
| a walk from a different point, shorter | 435 |
| a walk from a different point, within 25 m of the old figure | 4 |
| **the old figure, from the old point** | **0** |

Every new point was checked independently of the code that chose it: of 14,957
routes with an inferred trailhead, **0** lack a way the rules call drivable
within 60 m of the point. 145 of the moved approaches now start at a surveyed
trailhead node.

**Why 435 got shorter**, since the expectation was longer or none:

- 316 — a different way is now the nearest in that category. Typically the OSM
  copy of a road USFS calls high-clearance is now rough, so it becomes the cell's
  nearest rough way, with its own trailhead where it meets a road a car can use;
  or the old way was a snow route and the next trail has a nearer trailhead.
- 86 — the same route, walked from its **other end**. The first-end rule had put
  the trailhead at the end that met the demoted road; that end no longer counts,
  and the other end, at a real road, is nearer this cell. (41% of inferred-
  trailhead ways meet a drivable road at both ends — see
  [ROADMAP.md](../ROADMAP.md).)
- 33 — the same route, now from a mapped trailhead node.

**And against the sources themselves.** For a spread of 33 of those cells, both
sources were asked live what lies around the old point and the new one. Every
old point sat on a road USFS rates level 1–2 or closed — Forest Roads 41, 77, 78
and 4104, Pinto Road, Foss River Road — or on a snow route that was dropped.
Every new point sat on a level 3–5 road, a paved OSM road, an OSM road with no
USFS record at all, or a surveyed trailhead node. Where a live query failed, the
reconciled categories around the point were read instead, and agreed.

The same check is what found both of the rule's limits above. The first run
demoted **State Route 410** to rough off a 337 m spur, and made **150 motorway
ramps and the I-5 Express Lanes** rough because they carry `motor_vehicle=no`.
On a limited-access road that tag marks an HOV, transit or express lane, not a
closed road, so `motorway` and `trunk` are exempt from it. `primary` and
`secondary` are not: the closed stretch of Spirit Lake Highway is still rough.

One judgement it surfaced and left standing: a paved OSM road lying along a USFS
**closed-layer** record stays rough — All Seasons Drive near Cle Elum, 896 m
along SPEX ARTH. A gate is not a surface, and the closed layer is the only thing
in either source that records one.

### Moving the work to assembly was not free, and it was measured first

Categories, trailheads and cell stamping moved from the fetch to assembly so the
rules could run before them. Done alone, with no rule, that renamed the way in
**1,344 cells at a median distance change of 3 m** (90th percentile 12 m):
stamping on the stored, 25 m-simplified geometry breaks near-ties between the
OSM and USFS copies of one road differently from the full geometry the fetch
used. 245 walks went — 112 because the named way flipped to a twin with no
trailhead, 133 because a trail end fell just outside 60 m of a simplified road —
and 182 appeared, mostly where the statewide road index found a road the per-tile
check had not. About 0.3% of cells, measured and left, because the alternative
is keeping full geometry in a checkpoint that is already 101 MB.

### What the checkpoint holds now

Schema 2: what the sources said — each OSM way's own classification plus the
tags that describe the road (`pv` paved, `rd` the rough-describing tag), each
USFS path with its maintenance level (`ml`) or trail type (`tt`) — and nothing a
rule derives. A schema-1 checkpoint is upgraded on `--resume` rather than
refused: USFS by page (about 25 requests) and the describing tags by tag (a few
Overpass requests; the statewide query with a `highway` regex timed out on every
mirror, so it asks by tag alone and splits an area that fails).

## How far in, on foot: the hike mode

Three figures per cell were asked for — drive, bike and hike, each a distance, a
climb and a difficulty bucket. **Hike is built first**, because the network, the
buckets and the filters are shared, and it was worth getting them right on one
mode before triplicating them. Drive and bike follow on the same network.

The single-route model this sits beside — "the nearest trail, walked from its own
trailhead, then straight to the centre" — is what put *Porter Creek Logging Road,
609 m, drive up* on the user's Deming target, where the road was gated six miles
short. It knew the road, not the network, and nothing about where a car stops.

### The network

Every way the bake fetched, joined where ways meet: ends within 15 m of each
other, an end within 15 m of another way's side, and lines that cross — including
at a shared vertex, which is what an OSM intersection becomes when simplification
keeps it. Statewide: **816,915 junctions and 1,128,091 stretches of way**, from
1.01 million end joins, 357,634 side joins and 188,942 crossings.

Junctions are inferred because the checkpoint holds 25 m-simplified geometry and
no node ids. That errs towards connecting: a trail passing under a bridge becomes
a junction. The Geofabrik extract in [ROADMAP.md](../ROADMAP.md) would give the
true topology.

### The inferred junctions are wrong about 9% of the time, and it costs about 1.7% of the buckets

Measured 2026-09-11, because "some false connections" is not a number. Method in
[verification.md](verification.md#the-false-junction-rate-measured); what it found:

- The network makes **1,559,805 join offers** — 64% end to end, 23% an end onto a
  side, 12% two lines crossing. (An end-to-end join is offered from both ways, so
  the distinct count is lower.)
- Against Overpass, which holds the node ids the checkpoint threw away: of 3,089
  sampled joins between two OSM ways, **82% are confirmed by a shared node within
  40 m** and 13.6% are not.
- The rate depends almost entirely on **what kind of ways and how big the gap**.
  Both ways a forest class — track, path, unclassified, service, forest road:
  **4.6% unconfirmed**. Anything else, which is town streets, cycleways and
  highway ramps: **20.4%**. An end-to-end join with a gap under a metre is
  essentially always real (2 of 499 unconfirmed); over a metre it is a coin flip.
  An end onto a side runs from 2% at a metre to 41% at 15 m in town, 8% in forest.
- **Vertex evidence is useless**, which is worth knowing because it looks like the
  obvious cheap test: only 192 of 12,297 OSM-to-OSM crossings have a vertex within
  a metre of the crossing point, yet 81% of them are real. Douglas-Peucker at 25 m
  removes the shared node from the line. Do not build a rule on it.
- **What it costs.** Vetoing joins at the measured rate per class removes 144,922
  of them and changes **6.2% of hike figures** (forested cells 6.8%) and **1.7% of
  difficulty buckets**; 18 cells of 46,634 lose a figure entirely, and the car
  reaches 88.5% of drivable road instead of 91.2%. The median affected cell moves
  17 minutes. Vetoing *every* crossing — an absurd upper bound — changes 22.6% of
  figures and 1.05% of buckets.
- **"OSM does not confirm it" is not "it is not there."** Eight forest-class
  unconfirmed joins checked against imagery were all passable on foot: two pieces
  of one trail with a gap, two tracks meeting at a visible junction, a path
  crossing a forest road at grade. Some are the same named way on both sides. The
  6.2% is therefore an upper bound on the real error, not an estimate of it.
- **The misses, too**: of 1,461 connections OSM really has between ways the bake
  holds, the inference finds 1,398 — **95.7% recall**, 63 missed.
- No route runs over water: none of the 25,880 stored routes crosses the Columbia,
  Snake, Skagit, Yakima or Spokane, and 32 have a vertex inside a lake polygon,
  all of them shoreline trails. (2,393 cross a smaller mapped river, where forest
  roads and trails do have bridges and fords.) An earlier note about a route
  running onto an island in the Columbia did not survive this check.

### Where a car can get to

Pessimistic on purpose — this project has twice been burned by access reading
better than the ground:

- **drivable roads only** — the categories after the rules above;
- **connected to pavement**: breadth-first from every road that is `motorway` to
  `tertiary` or tagged paved, along drivable roads;
- **stopping at mapped gates**: barrier nodes that lie *on* a road (asked for as
  `node(w)` of the fetched ways, so a gate in a field beside a road never counts),
  kept six metres off any junction so a gate on a spur never blocks the road it
  leaves. 65,120 block cars; 739 tagged open to cars are left out; 35,748 land on
  a drivable road;
- **stopping where a private or permit-only road starts** — `access`,
  `motor_vehicle` or `motorcar` of private, no, permit, forestry, agricultural or
  delivery, most specific tag winning: 36,139 ways. They are still walked.

91.2% of drivable road is reachable from pavement that way. The other 9% is
behind a gate, a private road, or no mapped link at all.

### The walk

Minutes on foot along the network from wherever a car can reach, driving costing
nothing: 4 km/h plus 10 minutes per 100 m of climb on anything mapped, then a
straight line off trail to the cell centre at a third of the speed and twice the
climb cost. Motorways are driven, never walked.

**Which approach a cell gets.** Every stretch of way within 2.5 km is a
candidate, not only the nearest. The approach given is the fastest one that keeps
the off-trail leg within `BUSHWHACK_M` (800 m), and a bushwhack only when there is
none. Picking the fastest outright made 27% of cells bushwhack — under a
three-to-one weighting, 900 m of brush from the car beats 4 km of trail — and
5,725 of those had an approach inside 800 m, 2,025 of them for fifteen minutes
more or less. The bucket should describe the approach a forager would take. When
going straight through the brush would save 15 minutes or more, the sheet says so
beside it (3,439 cells), never instead of it.

**The worst case** is the same walk from the nearest **paved** road, for when the
gravel turns out to be gated where nobody mapped a gate. It is longer than the
hike figure by more than five minutes in 28,105 cells.

**Why the car stopped** is recorded and shown: from the road itself (20,754
cells), where the drivable road turns rough (17,858), the end of the mapped
drivable road (4,686), a mapped gate (2,137), a private or permit-only road
(1,199).

### The buckets

The effort model and the thresholds are the user's calibration: brush at three
times trail — their Deming day was 6 mi and 2,000 ft in 6.5 h, much of it off
trail — and bushwhack past an 800 m off-trail leg, kept adjustable because it is
the most sensitive knob.

| bucket | rule | cells |
| --- | --- | --- |
| Drive-up | 10 min or less on foot | 8,869 |
| Easy walk | 30 min or less | 9,243 |
| Moderate hike | 2 h or less | 12,405 |
| Long approach | over 2 h | 8,813 |
| Bushwhack | off-trail leg over 800 m, whatever the time | 7,304 |

Of 48,032 cells, 46,634 have a hike figure. **Minutes and buckets are computed in
the app from the stored parts**, with the constants in `src/access.mjs`, so a
threshold can move without a re-bake. Which approach a cell is *given* depends on
`BUSHWHACK_M` at bake time, so moving that constant relabels cells at once and
re-routes them on the next `--resume` (about 2.5 minutes).

### Deming

| | on the network | off trail | minutes | bucket |
| --- | --- | --- | --- | --- |
| hike | 0 — the car gets there, as mapped | 609 m, +85 ft | 33 | Moderate hike |
| worst case | 7.7 mi, +3,582 ft from the pavement on Middle Fork Road | 609 m | 328 | Long approach |
| on the ground | the road was gated ~6 mi short; approached from the south | | ~390 | |

The hike figure is still wrong at Deming, because the gate is not in OSM. That is
what "as mapped" means, and the sheet says it in those words. The worst case is
what makes the failure visible: five and a half hours from the pavement, against
the six and a half the user actually walked.

### Filters

"Within a 2-hour hike", on the map and in Top spots. **Off by default, never
touching a score, and always saying how many cells they hide** — and how many of
those have no mapped route, which is unmapped, not unreachable. Hard rule 8 was
amended for this; see `CLAUDE.md`. The mode is a global setting remembered per
device, and Top spots can override it for its own list.

### Checked

Every stored route adds up to its hike figure: across 25,880 routes the difference is a median 1 m, 6 m at the 99th percentile, and one route of 25,880 is off by more than 50 m (122 m). Every "mapped gate" stop lies within 31 m of a mapped gate
(median 9 m), and every "private road" stop but one within 30 m of a restricted
road. Live, against OSM: 8 of 8 sampled gate stops have a barrier within 40 m, and
7 of 7 private-road stops that answered have a road tagged private, forestry or
`access=no` right there. How: [verification.md](verification.md#the-hike-network).

### What it costs

- `access.json` grows from 5.3 MB to 7.75 MB up front — the mode columns for every
  cell. `access-routes.json`, the routes for drawing, is 8.6 MB and fetched only
  when someone asks to see one. Both are in [ROADMAP.md](../ROADMAP.md).
- Inferred junctions: some false connections, and none of OSM's missed.
- An unmapped gate is invisible to the hike figure. The worst case is the answer
  to that, not a fix for it.

## Getting there by car: the drive mode

Built after the hike (v7), on the same network and the same stopping rules. The
question it answers is the user's: **how deep into the forest road network does
this cell sit** — and then, what is left on foot.

### The drive

Minutes from the nearest paved road, along drivable roads only, never through a
mapped gate and never onto a private or permit-only road. Pavement is the same
`paved()` the worst case uses, so "from the nearest paved road" means one thing
everywhere in the app. Three speeds, agreed with the user:

| class | speed | what is in it |
| --- | --- | --- |
| pavement | 35 mph | motorway–tertiary, or a surface tag that says paved |
| graded | 25 mph | USFS maintenance level 4–5 — and a town street |
| rough | 15 mph | level 3, and every forest road nobody rated |

**A street is in the graded class on the strength of a measurement.** 61% of the
drivable network that `paved()` does not call pavement is `highway=residential`
and 31% is `unclassified`; only 8% is a USFS road. Rural and small-town streets
are simply mapped without a surface tag. Timing those at 15 mph made a cell on the
far side of a village read minutes deeper into the forest than it is — that is not
erring pessimistic, it is being wrong about a street. An unrated *forest* road
stays in the slow class, which is where the pessimism belongs.

Metres are stored per class and per cell, plus the climb; **the minutes are
computed in the app**, so a speed can be retuned without a re-bake. Of the metres
actually driven across all 46,634 cells, 1.8% are pavement, 24.3% graded and 73.8%
rough — the drive figure is, in effect, gravel miles from the end of the tarmac.

(Those shares are the v8 numbers. In v7 they read 1.8 / 17.7 / 80.5, because the
maintenance level never reached the network: `computeModes` copies each way by hand
and `ml` was missing from the copy, so the whole graded class was town streets. The
drive figures moved a little when the bike exposed it — the state's deepest drive
from 141 minutes to 134 — and the class rule itself was never in doubt.)

### Where the car is left

The hike chooses its parking point on **foot minutes alone**. The drive chooses on
the **whole journey** — drive plus walk, a minute of each counted the same, because
someone deciding where to go today is deciding about a day, not about a leg. A
minute in the truck is easier than a minute walking, so counting them equally
already leans towards walking rather than towards driving round the mountain.

The two agree for **43,881 of 46,634 cells (94.1%)**. Where they differ, the drive
has found a closer place to leave the car at the price of a longer walk, or the
reverse. The routes file stores the drive's walk only for the 1,764 cells where the
line is actually different; everywhere else the app draws the hike's.

In 20,643 cells (44%) the car reaches the point nearest the cell and there is no
walk at all. In 1,397 (3%) the road runs into the cell itself.

### What the sheet says

The mode on screen decides which figure leads. In drive mode:

> **Drive** — 20 min *from the nearest paved road*
> 7.2 mi · 500 ft of climb — *4.6 mi graded forest road, 2.6 mi rough or unrated gravel*
> **Long approach 2.5 h** *on foot from there*
> 2.4 mi · 350 ft of climb *on trails, tracks and roads, from a mapped gate*
> 0.5 mi · 500 ft of climb *off trail* — Show the route
> *Door to cell, 2.5 h. The drive is from the nearest paved road, at 35 mph on
> pavement, 25 on a graded forest road and 15 on anything rougher. Snow,
> washouts, a locked gate nobody mapped and mud are not in it.*

The worst case — the same walk from the nearest paved road — sits beside the drive
exactly as it sits beside the hike, and for the same reason: **a gate nobody mapped
is invisible to both figures.** The filter is "within 30 minutes of driving", which
counts the drive alone because that is what it says; the "easiest access" sort
counts the whole journey, because ordering by the drive alone would put a
five-minute drive and a four-hour walk above a ten-minute drive that ends at the
cell.

### Deming, in drive mode

The user's own trip: the target at 48.8003140, -122.0556248, where the road was
gated about six miles short and they walked in from the south — 6 miles, 2,000 ft,
6.5 hours.

> Drive **30 min** from the nearest paved road, 7.7 mi of rough or unrated gravel,
> 3,600 ft of climb. Then **35 min** on foot, all of it the 0.4 mi off-trail leg.
> Door to cell, 1 h.
> **If the gravel is gated: 5.5 h**, a long approach — 7.7 mi and 3,600 ft from
> the nearest paved road, then 0.4 mi off trail.

The gate is still not in OpenStreetMap, so the drive still reads as a drive. The
worst case is the figure that describes the day they actually had.

### Checked

- Every stored drive is a real breakdown: no negative metres, and the minutes
  recomputed from the stored parts match the speeds exactly.
- **The hike is never the longer walk of the two** — the drive's walk starts
  somewhere a car can get to, so the hike's foot minutes cannot be worse. 249 rows
  of 46,634 (0.5%) read otherwise, all of them explained by the off-trail climb
  being *estimated* while a candidate is chosen and *measured* afterwards; the
  median disagreement is small and both figures describe a real approach.
- **The worst case never beats walking the drive's own road**: 182 rows (0.4%),
  the same cause.
- The deepest drives in the state — 134 minutes, 35 miles — are a **border
  artifact**, and the sheet now says so; see below. 167 of the 780 cells with a
  drive over an hour are within 15 km of a border, against 11% of cells overall.

### The edge of the data is a figure of its own

The bake holds Washington's roads and about 2.8 km past them — the fetch's tile
padding — and nothing beyond. So near a **land** border the way round it found may
be the only way it can see. The state's deepest drive is the proof: 134 minutes and
35 miles for a cell 2.7 km from the Idaho line, whose nearest pavement is 4 miles
east in Idaho, 1.6 km outside the data.

Reporting that as 35 miles and saying nothing is the failure mode this project
keeps legislating against, so the sheet says it:

> *The bake holds Washington's roads only, and they stop about 3.4 mi from here at
> the Idaho line — a shorter way in from Idaho would not be in this figure.*

The rule: `edgeDoubt(lat, lon, metres)` fires when the border plus the padding is
closer than **half** the figure's own length, which is `EDGE_DOUBT_SHARE`. It is
computed per figure, so a short drive near the line says nothing while a long one
does, and it is printed **once per sheet**, on the first figure it applies to —
three copies of the same paragraph is how a caveat becomes furniture. It fires for
892 of 46,923 cells (1.9%): 578 near British Columbia, 176 near Idaho, 138 near
Oregon; 501 on a drive figure, 464 on a hike, 822 on a worst case.

Which borders count is the part worth getting right. `WA_LAND_BORDER` is the first
fourteen vertices of the state outline — the 49th parallel, the Idaho line, the
46th parallel and the Columbia to its mouth. **The Pacific coast and the Strait of
Juan de Fuca are left out on purpose**: no road is missing out there, and including
them would put the caveat on every coastal cell, which is how a real warning gets
ignored.

Nothing is stored for any of this — a cell's position and the figure's own length
are enough — so it needed no re-bake and no format bump. The one case it gets
wrong is a **regional** bake, whose coverage ends at its own bbox rather than at
the state line; the shipped file is always statewide.

### What it costs

- `access.json` goes from 7.75 MB to 9.0 MB, which is 2.08 MB to **2.43 MB over
  the wire** — Pages serves it gzipped, and that is the number that matters on a
  phone. (Measure it with `curl -H 'Accept-Encoding: gzip'` against the deployed
  host, not with `gzip -9` locally: Pages compresses less hard, by about 8%.)
- `access-routes.json` grows from 2.41 MB to 2.55 MB over the wire, because the
  modes **share** the table of way stretches and differ only in the per-cell
  lists — 1,764 of 25,880.
- Bike will add about as much again. The size plan, with the levers measured, is
  in [ROADMAP.md](../ROADMAP.md#the-three-modes-share-storage-they-do-not-triple-it).

## By bike: the third mode

Built after the drive (v8), on the same network and the same two-phase shape: the
vehicle goes as far as it may, and whatever is left is a walk. What makes the bike
worth a mode of its own is that it rides the ways a truck cannot — level 1–2 roads,
tracks, singletrack — which is exactly the ground a gated forest road leads to.

### The ride

| class | speed | what is in it |
| --- | --- | --- |
| road | 12 mph | pavement, a graded forest road (level 4–5), a street |
| rough | 8 mph | level 3 and below, tracks, and every forest road nobody rated |
| trail | 5 mph | singletrack and paths |

Plus **8 minutes per 100 m of climb** — steeper than that and most people push,
which is about the same speed either way. As with the other modes the metres are
stored per class and the minutes computed in the app, so a speed can be retuned
without a re-bake. Of the metres actually ridden: 2.2% road, 79.0% rough, 18.8%
trail. Half a mile of singletrack costs what a mile and a half of graded road does,
which is the point of splitting the classes.

### The bike is carried, not ridden, to where the car stops

The ride starts from **every node a car can reach**, at zero cost: the bike is on
the back of the car. But a car does not stop at a node — it stops anywhere along a
road — so the bike is also **carried to any point on a drivable, car-reachable
edge**, which is the same predicate the hike uses for its drive-ups.

Without that, the bike was made to *ride* the last few hundred metres of a road the
car could have driven, and **9,157 cells (20%) read slower by bike than on foot** —
which cannot be true of the same route. With it, 222 cells (0.5%) do, all of them
the off-trail climb being estimated when a candidate is chosen and measured
afterwards, the same wrinkle the drive has. The invariant to keep: **a bike figure
is never worse than the hike figure.**

### Two things stop a bike — and one that does not

- **Designated wilderness.** A bicycle inside one is illegal by federal law, not by
  a gate. 28 areas intersect Washington, from the USFS EDW wilderness layer, kept
  in the checkpoint as rings simplified to 60 m and tested **even-odd per area**, so
  an inholding inside a wilderness is not wilderness. 26,785 edges blocked.
- **`bicycle=no`, `private` or `dismount` in OpenStreetMap** — 9,106 ways, 28,450
  edges. `dismount` counts because pushing a bike is walking, and the figure then
  walks that stretch, which is exactly right.
And one thing that does **not** stop it, though v8 had it stopping: a road the
Forest Service has closed to **motorized** use. A bicycle is not a motor vehicle,
such a road is generally legal to ride, and riding past a gate is the whole reason
to bring one. The user asked for the conservative reading first, saw the
measurement, and reversed it: **4,109 cells (8.8%) quicker, by a median 12 minutes**,
p90 51, max 361, with the walk bucket moving for 3.6%. `BIKE_BLOCKS_CLOSED_ROADS` is
false from v9 and a test asserts it, because the original instruction is still in the
conversation history and reads the other way. The closed-roads layer is what the
**dirt bike** must respect; that is where those 92,026 edges belong.

Blocks are marked **per edge**, not per way, because a trail crosses a boundary in
the middle of a way. An edge runs junction to junction, so an edge that straddles
the line is blocked whole — pessimistic, which is the right direction for a legal
boundary, and worth knowing when reading a figure. In practice a wilderness
dismount sits a median of **40 m** from the boundary (p90 146 m).

**What the wilderness layer does not cover: the national parks.** It is a Forest
Service layer; the Olympic and North Cascades park wildernesses are not in it, and
bicycles are banned on nearly every national park trail whether or not it is
wilderness. `BIKE_PARK_NOTE` says exactly that on the sheet, because the data
cannot.

### What it is worth

- **24,902 cells (53.4%) are quicker by bike than on foot**, saving a median 32
  minutes and 114 at the 90th percentile.
- **21,254 (46%) have nothing to ride** — the car gets as far as a bike would — and
  in 21,007 of those the walk left is exactly the hike figure, which is the
  passthrough check for the whole mode.
- Where the ride ends: 39,644 at the road (nothing blocked it), 2,958 at a
  wilderness boundary, 2,344 at a road closed to motorized use, 1,690 where the map
  says no bicycles.

### The one vehicle, twice

The drive and the bike are one pair of functions — `vehicleReach` and
`vehicleApproaches` — given different descriptors: which edges the vehicle may use,
how fast each class is, where it starts, and what stops it. The rest, including the
"arrive at a mid-edge point" case and the walk seeded with the vehicle's own cost,
is shared. Writing the bike as a copy of the drive would have been half the work
and would have drifted by the second change.

**A bug the sharing exposed:** for a candidate the vehicle could reach, the scan took
the ride-to-the-point branch and never priced *walking* there instead — so a bike
rode 48 miles round a ridge rather than walk 17 km. All three ways to arrive are now
priced and the cheapest wins.

### What it costs

- `access.json`: 9.0 MB to **10.8 MB**, which is 2.43 MB to **2.93 MB over the
  wire**, measured against the deployed host.
- `access-routes.json`: 8.8 MB to **12.8 MB**, 2.55 MB to **3.46 MB over the wire**
  — the bike's line is stored for 13,741 cells, because unlike the drive's walk it
  is rarely the hike's, and because the ride itself is drawn. The drive's roads are
  not drawn: the overlay already shows them, while nobody believes a ride past a
  gate until they see the line.

## Roads and trails on the map are somebody else's rendering

The tap sheet answers "how would I reach this cell", one cell at a time, from
`access.json`. The map answers "which ground has a route at all". Those are
**separate jobs**, and two attempts to do the second with the data built for the
first are why the map now draws a rendered raster instead.

### Why not our own vector layer

**The first version drew the cells' references.** `access.json` stores one
nearest way per cell per category — 53,252 of the 460,370 ways the bake fetched
(11.6%), and 597 of 43,587 in the Seattle tile (1.4%). Drawn as a map, that was a
scatter of stubs on the square-mile lattice: 1.1 ways per connected piece, against
5.3 in the real Seattle network. Clipping, the 2 km referencing radius and missing
cells were each ruled out by measurement; selection was the whole cause.

**The second drew the whole network**, every fetched way, from z12 tiles, and
showed a different fault: roads that OSM and USFS both map appeared **twice, a
median 7 m apart, often as two different kinds**. 45,491 of the 309,394 km drawn
(15%) was doubled. The pairs that visibly disagreed:

| class | pairs | km | what the sources said (10 random samples each) |
| --- | --- | --- | --- |
| OSM drivable, USFS rough | 1,018 | 4,777 | OSM `unclassified`, USFS maintenance level 2 |
| OSM rough, USFS drivable | 274 | 807 | OSM `track`, USFS maintenance level 3 |
| a road under a USFS trail | 1,235 | 4,073 | the "trail" was a **snowmobile route**, `trail_type=SNOW` |

Where the two copies coincided the solid line hid the dashed one, so one road
seemed to flip between drivable and rough along its length. Only 0.9% of the
category changes between consecutive pieces of a named road were real.

Fixing that on a map is conflation — deciding, road by road, which of two sources'
geometries is the road — and a renderer that draws a single source has already
solved it for that source. The access data needed its own fixes for the same
disagreement; they land separately, because they change figures rather than
pixels.

### The overlay

OpenTopoMap's rendering of OSM, `https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png`,
native to z17. Chosen from ten candidates, tile-probed at two forest sites:

- It is the only free, keyless source that draws the whole OSM network,
  **including logging roads on private timber**. At Green River, z16, a logging
  road plainly visible in the imagery was drawn by OpenTopoMap, faintly by Stadia,
  and not at all by USFS, the USGS National Map transportation layer or Esri World
  Transportation. The government sources are right where they have data, and much
  bolete ground is private or state timber.
- CalTopo's terms forbid use without written consent. USFS FSTopo tiles 404. USGS
  topo and Thunderforest are opaque basemaps. Waymarked Trails draws only named
  long-distance routes.

Its tiles are opaque, so it is **multiplied** over the imagery, through a filter
that first pushes its area fills to white so the multiply leaves the imagery
alone: `saturate(.35) brightness(1.3) contrast(1.8)`. The satellite basemap is
the default precisely so terrain and canopy can be read, so the tint was measured
rather than judged: plain multiply darkened the imagery 21–22% and greened it,
and this filter darkens it 1–1.5% over gentle forest and about 4% over steep,
hillshaded slopes, with no colour shift. The method is in
[verification.md](verification.md#the-roads-overlay).

**Credit**: `Map data: © OpenStreetMap contributors, SRTM | Map style: ©
OpenTopoMap (CC-BY-SA)`, the wording OpenTopoMap's terms ask for. It is one
constant, shared by the basemap and the overlay. The old basemap credit, "©
OpenStreetMap, SRTM | OpenTopoMap", left out the licence and the style credit.

**Fallback**: Stadia Maps' `stamen_terrain_lines`, transparent and lines-only,
selectable with `?roads=stadia` or by changing `ROAD_OVERLAY`. It needs the
domains registered with Stadia, and its free tier is non-commercial; see
[ROADMAP.md](../ROADMAP.md).

### What it costs

- **It cannot be tapped or filtered by category.** Accepted: it has to be correct
  and detailed, and the tap sheet still names the way, its kind and the approach
  for any cell.
- **It is another service's goodwill.** OpenTopoMap is fair-use, with no uptime
  promise.
- **It stands down on the OpenTopoMap basemap**, where it would only darken the
  same map, and the legend says so.
- **What is drawn is still only what is mapped.** The menu and legend say so — a
  rendered line is no more a promise about the ground than one of ours was.

### What deleting the vector layer reclaimed

`data/network-tiles` (3,663 files, 16.1 MB tracked), `scripts/build-network-tiles.mjs`
and its 23 tests, `src/tile-source.mjs`, the canvas layer in `index.html` and two
layer-only constants: about 700 lines, and 16 MB off every checkout and every
Pages deploy. Git history keeps all of it — the pack does not shrink unless
history is rewritten, and a mirrored branch is not worth rewriting for 16 MB.
Recover from `b61b0a8`.

**The checkpoint is the only copy of the fetched network again.** The tiles had
briefly made it redundant. Losing `data/access.json.checkpoint.json` now costs a
full re-fetch; do not tidy it up.
