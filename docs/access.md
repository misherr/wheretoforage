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
directly. Trails come from the NFS trails layer.

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

`highway=unclassified` with `4wd_only=yes`, or with a dirt/earth/ground surface,
is reported as **rough** rather than as a road. So is `highway=road`, which means
"classification unknown" rather than "drivable".

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

## The trails layer draws a network, not the cells' references

The tap sheet answers "how do I reach this cell" one cell at a time. The layer
answers "which ground has a route at all". The first version of it got that
wrong in a way worth recording, because the mistake was conceptual rather than
mechanical.

### What went wrong: a layer made of cell references

The layer was built from `access.json`'s ways — and those are exactly **one
nearest way per cell per category**:

```js
for (const rec of state.nearest.values())
  for (const c of CATS) if (rec[c]) referenced.add(rec[c].wid);
```

**53,252 of the 460,370 ways the bake fetched — 11.6%.** In the Seattle tile,
**597 of 43,587 — 1.4%.** Drawn as a map that produced short parallel stubs on a
one-square-mile grid, trails starting and ending nowhere, and whole areas blank.

Measured, which is what settled it:

| | full network | the referenced set |
| --- | --- | --- |
| Seattle tile 164/357 | 43,587 ways in 8,184 connected pieces (**5.3 ways/piece**) | 597 in 562 pieces (**1.1**) |
| Green River tile 166/359 | 1,862 ways in 846 pieces (2.2/piece) | 419 in 304 pieces (1.4) |

1.1 ways per connected piece is the whole diagnosis: almost every drawn way was
its own island. The grid pattern was the cell lattice showing through — 226 baked
cells in that tile, up to three categories each, one way apiece.

Three things it was *not*, all ruled out by measurement:

- **Not clipping.** 41,678 of 41,678 single-way routes matched their fetched
  source length to within 2% or 30 m; `clipped: false`.
- **Not the 2 km referencing radius.** 438,521 of 460,370 ways (95%) lie within
  2 km of a baked cell. Eligibility was never the constraint; selection was.
- **Not only sparseness.** A tile with no baked cells stores nothing at all —
  tile 163/366 fetched 1,586 ways and kept 0, because no cell there passed the
  habitat gate. That is why roads went missing in blocks rather than thinning out.

### What replaced it

`data/network-tiles/12/<x>/<y>.json`, written by
`scripts/build-network-tiles.mjs` from **every way the bake fetched**, with its
own category per piece and its own manifest. It consults neither the cell
references nor the ways table, and the app does not need `access.json` loaded to
draw it. That independence is the fix: the conflation is what caused the bug.

| | |
| --- | --- |
| ways | 257,250 (of 460,370 fetched; 203,120 urban dropped) |
| tiles | 3,662 at z12 + a 40 KB manifest |
| on disk | 16.0 MB |
| a forest viewport | **8 tiles, 87 KB uncompressed, ~35 KB gzipped** |
| a Seattle viewport | 12 tiles, 527 KB uncompressed, ~210 KB gzipped |

### Why z12, and why the gate moved with it

The total barely depends on the tile size — 5.89 MB gzipped at z10 against
6.52 MB at z12 — but the **viewport** does, and that is what a phone pays:

| tiling | worst 2×2 view | worst 4×4 |
| --- | --- | --- |
| z10 | 494 KB | 1,094 KB |
| z11 | 224 KB | 498 KB |
| **z12** | **83 KB** | **234 KB** |

A phone covers 8 z12 tiles at app zoom 12 and 28 at zoom 11, so the gate moved
from z11 to **z12**. At z12 a pixel is 26 m and a square-mile cell is 62 px,
which is where a 25 m-simplified line reads as a line anyway. Below the gate the
legend says "zoom in to see them".

### The urban street grid is left out, and the legend says so

`residential` alone is 191,941 ways and 493,227 vertices — **27% of all the
geometry**, and the entire reason a full-network viewport costs 1.1 MB in Seattle.
This app is for timber; "which ground has a route" is never answered by a
residential street. Excluded by type: `residential`, `living_street`,
`service`, `cycleway`, `footway`, `steps`. Everything else survives — every
`track`, `path`, `bridleway`, `unclassified`, the USFS layers, and the arterials
you drive to reach them.

**Filtering by name does not work.** 93% of residential ways are named, so a
"major or named" filter keeps the entire city grid — measured at 437,743 of
460,370 ways kept, which is no filter at all. Type is the only thing that
separates them.

The manifest carries the exclusion list, and the legend states it where the lines
are: *"city streets left out"*, with the full sentence on hover — **"their absence
is not missing data"**. That wording exists because the bug this replaced looked
exactly like absent ways, and an unexplained gap would read as the same fault
twice.

### Why the checkpoint mattered, and still does

None of this needed a re-fetch. `data/access.json.checkpoint.json` holds all
460,370 fetched ways with geometry, category and type, so the tiles are a local
transform of a file already on disk — about a minute. The bake also calls
`writeNetworkTiles` itself from its in-memory ways, so a re-bake produces them
without anyone remembering.

That checkpoint is gitignored and 101.3 MB, which is over GitHub's hard per-file
limit, so it cannot be committed. **The tiles are now the durable artifact**: once
they are in the repo, losing the checkpoint costs a re-fetch only if the filter or
the tiling scheme changes. See [ROADMAP.md](../ROADMAP.md) for the Geofabrik item
that removes the dependency altogether.
