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
ways: [ [name, ref, type, catIndex, trailheadKind, geomDelta], ... ]
rows: [ [i, j, dRoad, wRoad, walkRoad, dTrail, wTrail, walkTrail, dRough, wRough, walkRough], ... ]
```

Per cell, per category: the straight-line distance, an index into `ways`, and
the walk along that way from its trailhead. `-1` anywhere means "not found
within the cap", "no way", or "walk unknown". A cell with nothing mapped at all
gets **no row** — the app reads a missing row as unknown, which is the same
answer and costs nothing to store.

### Geometry lives in its own file, fetched on demand

The up-front download is `access.json` — rows, way names, types, distances:
**4.12 MB**. The polylines are `access-geom.json`, **5.39 MB**, and the app does
not touch it until someone taps "Show the approach on the map". Most viewers
never will, and nobody needs 53,200 polylines to draw one line.

That took the app's total static payload from 20.6 MB to **15.2 MB**, and the
9.51 MB combined access data from 46% of the download to 27% of it. The two
files are index-aligned and stamped from the same run; `mergeInto` moves
geometry in lockstep with the ways table, because drifting indices would draw
the wrong line for a cell, and a test asserts they stay paired.

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
- **Clipped** to the stretch within 2.6 km of a cell that references it. This
  one turned out to be nearly a no-op — 621,072 points became 598,127, a 3.7%
  saving — because the ways that get referenced are mostly short forest ways
  already sitting next to their cells rather than long highways. It is kept
  because it costs nothing and bounds the worst case, but it is not where the
  savings came from.

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

## Running the bake

```bash
node scripts/build-access.mjs                 # the whole state, ~316 tiles
node scripts/build-access.mjs --resume        # after an interruption
node scripts/build-access.mjs --region=coast  # merged into the existing file
```

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

46,383 cells of 48,032 have a mapped way within 2 km; the other 1,649 (3.4%)
read as unknown. 53,200 distinct ways, 30,770 of them named or numbered, so
**71% of cells name a real route** and the rest say "unnamed track" or similar.
10,001 cells (22%) have a walk-from-trailhead figure; 921 mapped trailhead nodes
were found statewide, and 16,326 ways got an inferred trailhead against 1,037
mapped ones.

It cost 638 Overpass requests, 799 retries and 939 MB over ten hours, and
**20 tiny areas were abandoned** after failing at every mirror and every
subdivision — 33 sq km of 184,000. 80 cells sit within 2 km of one, 76 of which
still got data from an overlapping sub-quadrant, so 4 cells read unknown that
might not have. A targeted re-run with `--bbox` would close that if it ever
matters.

### Overpass is the awkward part

Three things bit during the first statewide run, and the script handles all
three:

- **The main instance stopped answering entirely** partway through — a connect
  timeout, not a 429. A single hard-coded endpoint turns that into a dead job,
  so there is a mirror list and the script moves on to the next one.
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
