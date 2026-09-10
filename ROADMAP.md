# Roadmap

Not a schedule. A list of things **deliberately not built**, each with the
reasoning that led to leaving it, so the next session does not rediscover the
question and answer it worse. Where a decision is the user's to make, it says so
and stays open rather than being quietly settled here.

`CLAUDE.md` carries the rules and the current phase; this file carries the
deferred work.

---

## Access

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

### The climb column costs 0.85 MB in the up-front download

**Open — the user's call, raised and not decided.**

`access.json` grew 4.12 → 4.97 MB at v4. Removing the geometry clip accounts for
only +0.13 MB and that lands on the lazily-fetched `access-geom.json`; the
+0.85 MB up front is the climb column plus the OSM way ids. The climb is `-1`
for most rows and could move into `access-geom.json`, which most viewers never
fetch. The cost of moving it is that the climb would not appear until the line
is fetched, so the sheet would show a walk with no climb next to it and then
change. That trade has not been made.

### 16,091 cells hold a walk figure that is never shown

**Measured 2026-09-10. Not a bug; a product question, and a behaviour change to
the access feature, so not made unilaterally.**

26,695 cells have a walk stored in at least one category, but the sheet shows a
walk for **10,604** of them, because `accessDetail` reports only the *primary*
category — the nearest one. A cell 200 m from an unnamed track with no trailhead
and 900 m from a named trail with a mapped trailhead shows the track, and no
walk, even though a perfectly good walk figure is sitting in the row.

Showing the nearest way is the right default: it is the honest answer to "what is
near this cell". Preferring a slightly further way because it has a trailhead
would be a different question, and worth asking, but it changes which way the
sheet names and which line "Show the approach" draws. Note also that only the
nearest way *per category* is stored, so a nearer way of the same category with a
trailhead is not in the data at all and cannot be recovered without a re-bake.

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
