# Access: how you would reach a cell

A per-cell classification of what is **mapped** as a way into each square mile —
a trail, a drivable road, a rough or decommissioned way, or nothing.

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

Access is **optional** at runtime: if `data/access.json` is missing the app works
exactly as before and every cell reads as unknown.

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
