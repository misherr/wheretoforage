# Roadmap

Not a schedule. A list of things **deliberately not built**, each with the
reasoning that led to leaving it, so the next session does not rediscover the
question and answer it worse. Where a decision is the user's to make, it says so
and stays open rather than being quietly settled here.

`CLAUDE.md` carries the rules and the current phase; this file carries the
deferred work.

---

## Access

### The tile loader is the seam the 30 m rebuild should reuse

`src/tile-source.mjs` knows about a manifest, `z/x/y` addressing, a bake stamp, a
fetch budget and an LRU cap, and nothing about roads, trails or elevation. The
trails layer is its first consumer. A 30 m raster or vector layer should be its
second rather than a second implementation of the same thing — the last thing to
go wrong in this app was one lookup living in one of four paths instead of a
shared seam, and this is that lesson applied before the fact.

What a second consumer would need that is not there yet:

- **More than one zoom level.** Today the source reads `z` from its manifest and
  serves one level. A raster pyramid wants a level per zoom and a rule for which
  one a viewport should ask for.
- **A decoder hook.** Tiles are assumed to be JSON. A PNG or a binary tile needs
  the parse step injected rather than assumed.
- **Cancellation.** Panning fast queues fetches for tiles that have already
  scrolled away. At 9 KB a tile that is waste worth ignoring; at raster sizes it
  is not.

None of that is worth building until there is a second consumer to shape it.

### Drop Overpass for a Geofabrik extract

**Not built. This is the answer if the bake gives trouble again — do not add a
fifth mirror.**

Overpass has now been the awkward part of **four separate statewide runs**:

- the main instance stopped answering mid-run (a connect timeout, not a 429), so
  a mirror list was added;
- all three mirrors were down at once and the `/status` health probe could not
  tell, because `/status` is a static string a queue-saturated server still
  serves — so the probe became a real query and a fourth mirror was added;
- a run wedged at 10 of 316 tiles and abandoned 5 sub-areas in the first 10;
- the v5 re-bake took over an hour of fetching against 36 minutes for the
  identical work a few hours earlier, purely on mirror speed.

Every fix so far has been another mirror or another probe, and each one buys a
little more redundancy against the same underlying problem: **the data is behind
somebody else's rate limiter.** There is no arrangement of mirrors that makes a
statewide query cheap or predictable.

**The actual fix is to stop querying it.** Geofabrik publishes a Washington
extract (`washington-latest.osm.pbf`, a few hundred MB) updated daily. Download
once, filter locally for the highway tags `osmCategory` already knows about, and
the 316-tile fetch becomes a local pass over a file: no mirrors, no rate limits,
no subdivision on 504s, no abandoned areas, and a re-bake that is reproducible
because the input is a file you still have.

**What it costs.** A PBF reader — the format is protobuf-framed and this repo has
no dependencies, so either a small decoder gets written (as the PNG decoder was)
or the extract is converted to a simpler form once, outside the bake. Plus a
place to keep a few hundred MB, and a note in provenance saying which extract
date the bake used, which is strictly better than "whatever Overpass returned
that afternoon".

**It has to be the PBF, not the shapefiles.** Geofabrik publishes both for
Washington — `washington-latest.osm.pbf` at 363 MB and
`washington-latest-free.shp.zip` at 722 MB, both rebuilt daily. The shapefiles
would be far easier to read (fixed binary records, assembled linestrings, no
protobuf and no node joining) but they collapse every tag into one `fclass`, and
`osmCategory` reads `abandoned:highway`, `disused:highway`, `razed:highway` and
the `service=*` sub-tag. Those decommissioned spurs are, in the words of the
comment that keeps them, "often the only thing reaching cut-over ground, and the
sort of way most apps drop entirely". Losing them would quietly degrade the access
classification, so it is the PBF: varint and protobuf framing, a string table,
delta-encoded DenseNodes, and two passes over 363 MB to resolve way nodes to
coordinates.

**Estimated cost, and why it is not a couple of hours.** The decoder is 4–8 hours
with verification. The larger half is that this changes the input to the *access
bake*, so the classification of all 46,378 cells needs re-verifying — categories,
names, the trailhead inference, the USFS merge, the walk and climb figures — which
is the whole v5 verification pass again. Realistically a day, and it puts every
cell's access figures at risk. Worth doing on its own, with its own verification;
not worth folding into a display-layer change.

**What made it less urgent.** The network tiles are now a committed artifact, so
the 101.3 MB checkpoint is no longer the only copy of anything shipped. Losing it
costs a re-fetch only if the tile filter or the tiling scheme changes.

**What it does not change.** USFS roads and trails still come from the EDW
ArcGIS endpoints, which have never given trouble, and the terrain tiles still
come from AWS. Only the OSM half moves.

### OSM route relations, so a long trail draws as one line

**Not built. Wanted, but not on the critical path.**

Routes are currently assembled by `joinRoutes` in `scripts/build-access.mjs`:
ways are grouped by `category | type | name | ref`, and two ways are chained only
where their endpoints meet and **nothing else meets them there** — endpoint
degree exactly 2. That works: 2,091 of 50,614 stored routes are assembled from
more than one mapped way, and Baker Lake Trail arrives as ways of 7.18 mi and
2.37 mi and is stored as one 9.54 mi route.

**Where it stops.** The Pacific Crest Trail's 68 "Pacific Crest Trail" ways
collapse to **28 stored routes, not one**, because it crosses side trails
constantly and every junction is a place the chaining refuses to pass through.
A long trail in a dense network still draws in sections.

**Why the junction guard stays anyway.** Chaining through a junction means
guessing which of three or more branches continues the route. Guess wrong and the
app draws a confident line down a side trail and reports a walk and a climb
measured along it — wrong, and with no sign that it is wrong. Drawing a real
route in pieces is visible to the user and honest; the alternative fails
silently. Loosening the name match has the same shape of problem: "Pacific Crest
Trail" and "PCNST" on adjacent ways stay separate routes, and relaxing that
starts merging genuinely different trails that share a name.

**Why relations are the actual fix.** An OSM *route relation* records the ordered
member ways of a named route as **data**, which is the answer to the question
`joinRoutes` is currently guessing at. A query of the shape
`relation["route"="hiking"]["name"="Pacific Crest Trail"]` returns the
membership; the assembly would then follow the relation's own ordering and never
infer a continuation at all.

**What it would cost.** A second Overpass query shape (relations, plus recursing
down to member ways), a third table in `access.json` keyed by relation id, a rule
for a way belonging to several relations, and a format bump. Relation coverage in
Washington is good for the long named trails and absent for most USFS trails,
which often have no OSM presence at all — so relations would **add to**
`joinRoutes` rather than replace it, and both paths would need to stay.

**Why it can wait.** This changes how a long trail *draws*. It does not change
whether a cell has access, what the way is called, the walk, or the climb — all
of which come from the nearest way and its trailhead, and none of which get
better with relations. Worth doing when the drawn line matters more than it does
today.

### The approach columns cost about 1.4 MB in the up-front download

**Open — the user's call, raised and not decided.**

`access.json` grew 4.12 → 4.97 MB at v4 — the climb column plus the OSM way ids,
not the un-clipping, which cost +0.13 MB and landed on the lazily-fetched
`access-geom.json`. v5 adds the off-trail climb column on top of that.

Both climb columns are `-1` for most rows and could move into
`access-geom.json`, which most viewers never fetch. The cost is that the climbs
would not appear until the line is fetched, so the sheet would show distances
first and grow numbers beside them a moment later. That trade has not been made.
If it ever is, **both** columns move together: the two climbs are added and shown
as one total, so having one arrive late and the other immediately would be worse
than either arrangement.

### ~~16,091 cells hold a walk figure that is never shown~~ — done in v5

"Also nearby" now carries each category's own off-trail leg, on-trail leg and
total, so the 16,091 cells whose approach sat in a category the sheet does not
name are no longer silent.

**The naming deliberately did not change**, and that was measured before it was
decided: switching the named route to whichever one carries a walk would rename
16,091 cells, **12,331 of them from a road to a rough track** — from the road you
would drive to a logging spur.

What remains open, and cannot be evaluated without a re-bake: only the nearest way
**per category** is stored. A cell whose nearest trail has no trailhead cannot be
offered the second-nearest trail, only the nearest road or track. Storing two
candidates per category would change that, at a cost in file size nobody has
estimated yet.

---

## Terrain

### Fold an elevation plausibility check into the next `cells.json` re-bake

**Measured 2026-09-10, deliberately not acted on. Full measurement in
[docs/terrain.md](docs/terrain.md#the-terrarium-tiles-contain-garbage-at-waterland-boundaries).**

The Terrarium garbage that corrupted cumulative climb also reaches `terrainAt`,
but it lands on **6 of 48,032 cells** for slope and aspect and 2 more for
elevation, all of them river or urban water cells that already score ≤5. Porting
the climb fix's median filter would be the wrong tool — the corruption comes in
patches of 13–43 pixels, so a median's neighbourhood is contaminated and it
repairs a 1,141 m error only down to 139 m — and re-baking 48,032 cells to move
ten of them is a bad trade against hard rule 3.

What to do **when `cells.json` is next re-baked for another reason** (PRISM,
SSURGO or fire perimeters, below): reject an implausible own elevation and record
`slope 0 / aspect null` for that cell, which the model already reads as "no
aspect information", instead of a repaired guess. That is the terrain form of the
honesty invariant, and it costs nothing on a re-bake that is happening anyway.

---

## Scoring

Nothing here without the user's explicit sign-off — see hard rule 2.

- **The score bands (25/45/65/80)** were calibrated against the old, more
  optimistic distribution and nothing currently reaches "very high". Held
  deliberately until mid-October; **do not retune against one dry week.** Also in
  `CLAUDE.md`.
- **Still wanted, all needing a re-bake:** PRISM precipitation multipliers,
  SSURGO soil water capacity, NIFC fire perimeters. None of them belongs in the
  UI.
