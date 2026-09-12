# Roadmap

Not a schedule. A list of things **deliberately not built**, each with the
reasoning that led to leaving it, so the next session does not rediscover the
question and answer it worse. Where a decision is the user's to make, it says so
and stays open rather than being quietly settled here.

`CLAUDE.md` carries the rules and the current phase; this file carries the
deferred work.

---

## Access

### The roads overlay rests on OpenTopoMap's goodwill

**Shipped as the default. The fallback is wired in but not usable in production
until the user registers the domains with Stadia.**

The roads-and-trails overlay is OpenTopoMap's rendering of OpenStreetMap,
multiplied over the imagery (`ROAD_OVERLAYS` in `index.html`). OpenTopoMap runs
on donated servers: no key, fair use "provided the server is not overly
strained", no uptime promise, and the operators ask to be told about sustained
use. That is fine at today's traffic and fragile if it grows. Telling them is the
user's message to send.

**The fallback is Stadia Maps' `stamen_terrain_lines`**: transparent, lines only,
OSM-based, drawn light, so it needs no blend. It is already in `ROAD_OVERLAYS`
with its credit. `?roads=stadia` tries it on any deploy, and changing
`ROAD_OVERLAY` switches everyone — **no rebuild**, because the overlay carries no
data of ours. It needs a free Stadia account with `wheretoforage.com` and
`dev.wheretoforage.com` registered for domain authentication; until then Stadia
answers 401 from those hosts, and the 401's body is an error-message tile, so
`?roads=stadia` there covers the map in "401 Error" squares. It works from
`localhost` without one. Checked 2026-09-11: 401 from both hosts.

**Neither free tier is the permanent answer.** Stadia's free tier is
**non-commercial**, which conflicts with any premium plan on this app. If
OpenTopoMap becomes unreliable, the durable fix is a **paid Stadia tier or
self-hosting** — rendering OSM ourselves from a Geofabrik extract. Statewide
z12–15 is hundreds of thousands of tiles and gigabytes, which is past what GitHub
Pages will carry, so self-hosting also means a tile host.

### The vector tile loader is deleted; recover it from `b61b0a8`

`src/tile-source.mjs` — manifest, stamped `z/x/y` URLs, a fetch budget, an LRU
cap — went with the vector trails layer, its only consumer. It had been kept as
the seam for the 30 m rebuild, but it was the wrong shape for that: one zoom
level, JSON-only tiles, no cancellation of tiles that had scrolled away. If the
30 m layer is raster, Leaflet's own tile layer does all of it already. If it is
vector, start from

```bash
git show b61b0a8:src/tile-source.mjs
git show b61b0a8:scripts/network-tiles.test.mjs
```

and add the pyramid, a decoder hook and cancellation, rather than keeping 23
tests guarding code that nothing runs.

### ~~Bikes may ride roads closed to motor vehicles~~ — DECIDED, and reversed on purpose

**Settled 2026-09-12. Do not re-tighten this by re-reading the original
instruction.** The first instruction for the bike mode was that the USFS
closed-to-motorized layer blocks it absolutely, and v8 did that. The user reversed
it themselves after seeing the measurement, in their words: *"a bicycle isn't a
motor vehicle, a gated forest road is generally legal to ride, and riding past a
gate is exactly why you'd bring one. That's what I did at Deming."*

So since v9 `BIKE_BLOCKS_CLOSED_ROADS` is **false**, and the bike is stopped only by
designated wilderness and by `bicycle=no|private|dismount`. What it bought, measured
by baking it both ways: **4,109 cells (8.8%) quicker, by a median 12 minutes**, p90
51, max 361; where the ride ends changes for 2,430 cells and the walk bucket for
1,691 (3.6%).

The flag itself stays rather than being deleted, for two reasons: the **dirt bike**
mode is the one that layer really does stop, and a rule this project has changed its
mind about should be visible in the code rather than buried in a commit. The test in
`scripts/modes-ui.test.mjs` asserts it is false and says why, so a well-meaning
re-read of the original request fails the suite rather than shipping.

### The wilderness layer is the Forest Service's, and bikes are banned in the parks too

**Known, said on the sheet, not fixed.** The USFS EDW wilderness layer holds 28
areas intersecting Washington and not one of them is a national park wilderness —
the Olympic and North Cascades designations are NPS. Bicycles are banned on nearly
every national park trail regardless of wilderness status, so the bike figure is
optimistic inside the three parks. `BIKE_PARK_NOTE` says so wherever a bike figure
is shown.

The fix is a boundary source for the parks. The NPS ArcGIS endpoints that used to
serve them 404 now, and OSM tags US national parks as `boundary=protected_area`
relations, which this bake does not fetch. Worth doing when relations are fetched
for route names anyway (below).

### The three modes share storage; they do not triple it

**Measured 2026-09-11, after the drive landed.** The question was whether three
modes mean three copies. They do not, and the numbers matter more than the
architecture:

| file | v6 (hike) | v7 (+ drive) | v8 (+ bike) |
| --- | --- | --- | --- |
| `access.json`, over the wire | 2.08 MB | 2.43 MB | **2.93 MB** |
| `access.json`, raw | 7.75 MB | 9.0 MB | 10.8 MB |
| `access-routes.json`, over the wire | 2.41 MB | 2.55 MB | **3.46 MB** |
| `access-geom.json`, over the wire (lazy) | 2.22 MB | 2.22 MB | 2.22 MB |

Over the wire is the number that matters: GitHub Pages serves these gzipped, which
is a 3.7:1 saving, and `access.json` is fetched with `no-cache` — so a returning
viewer revalidates and pays nothing until the bake changes. Measure against the
deployed host (`curl -H 'Accept-Encoding: gzip'`); `gzip -9` locally reads about 8%
smaller than Pages sends.

The projection before building the bike was ~2.8 MB and ~3.2 MB; it came in at 2.93 and 3.46 — a
little optimistic again, which is this file's tradition. Where it went, and what is left to pull:

- **The routes file already shares.** One table of way stretches serves every
  mode; only the per-cell lists are per mode, and the drive's walk is stored only
  where it differs from the hike's — 1,764 of 25,880 cells. That is why adding a
  whole mode cost 0.08 MB.
- **Quantising the mode columns** — distances to 10 m, climbs to 5 m — measured
  −13% of the mode columns. The figures are honest to a hundred metres anyway.
- **Dropping the worst case where it does not differ** from the mode figure:
  18,529 of 46,634 cells, measured −0.15 MB. The sheet already says "no different"
  for those; it would have to read a missing group as that rather than as unknown.
- **Sharding by mode**, a base file plus one file per mode, fetched when a viewer
  switches: holds the up-front download at about 1.5 MB plus one mode no matter
  how many modes exist. Costs a fetch on a mode switch and a rewrite of the
  regional-merge path, which is tested and works; not worth it below 3 MB.
- **Sharding the routes file by region** is the one worth doing first, and not
  because of the total: it is fetched *whole* on the first "Show the route", 2.4 MB
  on whatever signal a forager has at a trailhead. In 0.5° blocks that becomes 60–120
  KB per tap, at the cost of duplicating the few edges shared across a block edge.

**The trigger arrived, and the first lever has been pulled.** `access.json` reached
2.93 MB over the wire with three modes, against the 3 MB named as the point to act,
and the routes file was 3.46 MB on a single tap. **The routes are now 264 regional
files** — a median 8 KB a tap, 52 KB at worst
([access.md](docs/access.md#the-routes-are-fetched-one-region-at-a-time)).

What is left, in order of value:

1. ~~**Per-mode files for `access.json`**~~ — done 2026-09-12, with the dirt bike. The base file is
   1.50 MB over the wire and one mode 0.59–0.74 MB, so the up-front download is **2.09 MB with four
   modes** against 2.93 MB with three in one file, and it stays there as modes are added.
2. **Quantising the mode columns and dropping the redundant worst case** — measured
   at about 20% together, no new plumbing, no format change beyond the values.

### QUEUED: ask Overpass for node ids, and stop inferring junctions

**Queued at the user's request, 2026-09-11, with the cost measured.** This is the
fix for the weakest part of the access build: 9.3% of the network's 1.56 million
joins are connections OpenStreetMap does not assert, and removing them all moves
6.2% of hike figures and 1.7% of difficulty buckets
([access.md](docs/access.md#the-inferred-junctions-are-wrong-about-9-of-the-time-and-it-costs-about-17-of-the-buckets)).

**What it is.** The fetch asked for `out geom`, which returns each way's geometry
and not its node ids, so the checkpoint has no topology and `buildNetwork` infers
it — ends within 15 m, an end on a side, two lines crossing. `out skel` returns the
opposite: way id plus node ids, no tags and no coordinates. **Two ways sharing a
node id are connected. Full stop.** No snap radius, no crossing test, no judgement.

**What it costs — measured, same selector, same mirror, 2026-09-11:**

| tile | `out geom` (the fetch) | `out skel` (the backfill) |
| --- | --- | --- |
| Seattle, dense | 24.71 MB, 6 s | 4.59 MB, 3 s |
| Snoqualmie forest | 3.67 MB, 1 s | 0.85 MB, 1 s |
| Columbia basin, sparse | 1.03 MB, 1 s | 0.25 MB, 1 s |

**19% of the payload**, so about **180 MB over the same 316 tiles** against the
~930 MB the statewide fetch moved — and minutes rather than the hours that fetch
took, because the tiles are cheap to answer and nothing is re-simplified. It is a
**checkpoint schema 4 upgrade**, exactly like schema 2 (USFS by page) and schema 3
(the tags that close a road to cars): the geometry already in hand is kept, one new
field is added per way, and everything after the fetch re-assembles for free.

**What it would fix.** Every OSM-to-OSM join becomes a fact: the ~87% OSM confirms
stay, the rest go, and the 4.3% of real connections the inference currently misses
appear. The measured error would drop to whatever the USFS ways contribute, which
is the part node ids cannot settle — a USFS way can never share an OSM node, so
those joins stay inferred and keep the sampled rates as their error bar. The
`onJoin` hook is where the rule would go: it already sees both way ids.

**Why it is not urgent.** The errors concentrate where nobody forages: 4.6%
unconfirmed where both ways are forest classes against 20.4% in town, and the
buckets — which is what the sheet actually shows — move by 1.7% even if every
unconfirmed join is deleted. The figures are honest about being "as mapped"
already.

**Two notes for whoever does it.** Node ids say *whether* two ways meet, not
*where*: keep the existing geometric contact point and gate it on the shared node,
rather than trying to place a junction from an id. And do not build anything on
vertex evidence — 25 m simplification deletes the shared node from the stored line,
so that test fails on 81% of real crossings.

**A narrower stopgap, if it is ever wanted without the 180 MB:** backfill bridge,
tunnel and layer tags the way schema 2 and 3 backfilled the road descriptors —
23,250 bridge ways, 3,273 tunnel and 24,056 with a layer tag statewide — and let
the hook veto a crossing between two different layers. That is the 2.5% of joins
that are certainly false, for a few tag-only queries. The **Geofabrik extract**
below is the other end of the scale: it makes the question disappear rather than
answering it.

### The bake holds Washington's roads only, so a border cell drives the long way

**Measured, said out loud, not fixed.** The five deepest drives in the state — up
to 134 minutes and 35 miles — are cells within three kilometres of the Idaho line
whose nearest pavement is 4 miles east, in Idaho, which the bake does not hold. 167
of the 780 cells with a drive over an hour are within 15 km of a border, against
11% of cells overall. The worst-case walk and the hike have the same edge.

Since 2026-09-11 the tap sheet **names it** on the cells it can affect — 892 of
46,923, once per sheet, naming the neighbour
([access.md](docs/access.md#the-edge-of-the-data-is-a-figure-of-its-own)). That
turns a wrong number into a caveated one, which is the honest interim; it does not
make the figure right.

The fix is an apron: fetch a 20 km band into Idaho, Oregon and British Columbia and
keep it in the network without stamping cells from it. It is a re-fetch of new
tiles — hours of Overpass — so it waits for the Geofabrik extract, which would make
it a bbox change rather than a fetch.

### ~~The routes file is fetched whole~~ — done 2026-09-12

Was one file: 25,880 hike routes, 1,758 drive walks and 14,063 rides over 140,677
stretches of way, 12.8 MB and 3.4 MB over the wire, fetched **whole** on the first
"Show the route" — at a trailhead, on one bar of signal. The estimate before
building it had been 1.9 MB; it counted edges but not the per-cell lists and the
partial last edges.

Now **264 regional files** of 16 cells square: a median 8 KB a tap, 52 KB at worst,
and the same total to within 2% because an edge is nearly always used by cells in one
shard only. The shard size was chosen by measuring five candidates on the real file
rather than picking one
([access.md](docs/access.md#the-routes-are-fetched-one-region-at-a-time)). The user
called the priority: *"a 3.46 MB fetch landing on whatever signal I have at a
trailhead is exactly the wrong place for it — that's where the app has to work and
where the connection is worst."*

### ~~The worst case is always on foot, even for a rider~~ — done in v10, 2026-09-12

Every mode's "if the gravel is gated" figure was the same walk from the nearest paved road: the
honest pessimistic bound for a walker, and the **wrong quantity** for a machine a gate does not stop.
At Deming it read 5.5 h on foot under all four modes, the dirt bike in the user's own garage
included.

Now one more Dijkstra per rider, seeded at the pavement instead of at the car, nine columns in each
riding mode's file. The before-and-after this deserved:

| Deming, if the gravel is gated | v9 | v10 |
| --- | --- | --- |
| hike, drive | 5.5 h on foot | unchanged — a closure strands both at the pavement |
| bicycle | 5.5 h on foot | **3 h** — 2.5 h riding 7.7 mi and 3,600 ft, then 35 min on foot |
| dirt bike | 5.5 h on foot | **1.5 h** — 45 min riding the same road |

Statewide the bicycle's bound beats the walk for 38,349 cells (82%) by a median 58 minutes and the
dirt bike's for 37,255 (80%) by a median 74; for 12,638 cells the dirt bike saves more than two hours
against the figure v9 showed. The largest correction is 14 h against 2 h, a cell 28 miles up a road
in the Colville forest. Two properties hold it to being a bound — never quicker than the mode's own
figure, never slower than walking the same road — and both are checked on every cell, at 0.4% with
causes named in [verification.md](docs/verification.md#the-riders-worst-case-checked). Every legal
block still applies, so a road closed to motor vehicles stops the dirt bike whatever the gravel is
doing.

The user's framing, which is the reasoning worth keeping: *"for a rider that gated gravel is a
20-minute ride, so the bound is overstated tenfold in exactly the case a dirt bike exists for."* The
measured factor at Deming is 3.7 rather than ten, because that road climbs 3,600 ft and a motor pays
2 minutes per 100 m for it; at the worst cell in the state it is 7. The direction was the point.

**An overstatement is not automatically the safe direction.** That is the general lesson, and it cuts
against a habit this project has rightly built: pessimism where nothing is known. Pessimism about a
*quantity nobody measured* is prudence. A pessimistic answer to a **different question** than the one
asked is just a wrong number, and "how long is that walk" is a different question from "how long is
that ride". The dirt bike's designation rule leans the other way — silence means closed — and both
calls are right, because each is conservative about the thing that can actually hurt the rider: a
citation on one side, a wasted day on the other.

### A way with a road at both ends is walked from its first end, not the nearer one

**Open — the user's call. Measured 2026-09-10, not acted on.**

`inferTrailheads` checks a way's first end, then its last, and records the
first that meets a drivable road. That is one trailhead per way, and every cell
on the way measures its walk from it. **24,984 of 60,408 inferred-trailhead ways
(41.4%) meet a drivable road at both ends** — mostly tracks and spurs running
between two roads — so for the cells nearer the other end, the walk shown is
longer than the walk that exists.

The fix is to store both ends as candidate trailheads and let each cell take the
nearer one along the way. It would shorten a large number of shipped walks,
which is why it is not folded into a verification-sized change: it wants its own
before/after, and a decision about whether "the nearer end" should also prefer a
paved road over a high-clearance one when both are drivable.

**The hike figure (v6) does not have this problem**: it walks the network from
wherever a car can reach, so a way with a road at each end is entered from
whichever end is quicker. It remains for the per-category "Getting in" figures
under it on the sheet.

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

**What made it more urgent again.** The vector trails layer's tiles briefly made
the 101.3 MB checkpoint something other than the only copy of the fetched
network. They were deleted with the layer, so it is the only copy once more:
losing it costs a full re-fetch, through Overpass.

**It would also give the route network real junctions.** v6 infers them — ends
within 15 m, an end on another way's side, lines that cross — because the
checkpoint has no node ids. A PBF has them, so the network would stop guessing
where ways meet, and a bridge would stop being a junction.

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

**v6 made the question bigger: 5.3 MB → 7.75 MB.** The hike columns have to be up
front — the filters and Top spots read them for every cell — but the worst case
and the straight-in alternative are only read on a tap and could move to the
lazily fetched routes file, about 1 MB. Also the user's call.

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

### QUEUED: the 30 m habitat rebuild — fetch to a checkpoint first, decide what to emit after

**Measured 2026-09-12. Nothing built, by instruction. Needs the user's sign-off before anything is:
it changes what `vegSummary()` and `hostFromSamples()` read, which is hard rule 2 territory, and
[src/model/CLAUDE.md](src/model/CLAUDE.md) governs the model half.**

**This was promoted from an aside.** Before today it had no entry — only a passing reference inside
"The vector tile loader is deleted" ("it had been kept as the seam for the 30 m rebuild"). There was
no prior plan, so nothing here is a revision of one, and nobody should go looking for the design that
was supposedly agreed earlier. The named next inputs were and are PRISM, SSURGO and NIFC.

#### Why the user wants it, in their words

> *"A cell with cliffs, talus, a lake and one good bench averages to mediocre and hides where to
> actually walk — I want to know where the good acre is, not that one exists."*

Keep that sentence. It is the whole test for whether a version of this is worth building, and the two
options below differ precisely in whether they answer it.

#### What is sampled today

Four **quarter points** per cell (`quarterPoints()` in `scripts/build-cells.mjs`), 250 cells per
request, so 1,000 sample points a call and **579 LANDFIRE requests** for the three layers across
48,032 cells — inside a 162-second bake. `cells.json` format 2 stores the four type codes, a
tree-class bitmask, canopy, height and tree fraction: 4.4 MB raw, **1.05 MB over the wire**.

#### The point-sampling service cannot deliver 30 m. This is the arithmetic that decides the shape

A lattice cell is `DLAT` × `DLON` — 1,614 × 1,609 m at 47.5°, so 2.60 km² and **2,886 pixels of
30 m** (`DLON` is fixed in degrees, so the count drifts with latitude; this is the mid-state figure,
not a textbook square mile). Over 48,032 cells that is **138.6 million pixels per layer, 415.9
million for three** — and at 1,000 sample points a request, **~416,000 requests against today's
579**. A factor of 718, on the order of a day of continuous calling at the rate the current bake
achieves, and the service would throttle long before the end.

So this is not a bigger version of the existing fetch. It is a **raster** fetch, and that changes
which parts are hard.

#### The raster path works, and was verified end to end rather than assumed

`LF2024_EVC_CONUS/ImageServer` on the same host the bake already uses:

| | |
| --- | --- |
| pixel size | 30 × 30 m, native |
| bands / type | 1, `S16`, `esriImageServiceDataTypeThematic` |
| spatial reference | EPSG:5070 (CONUS Albers) |
| `maxImageWidth/Height` | 100,000 |
| capabilities | `Image, Metadata, Catalog, Mensuration` — so `exportImage` is available |

`exportImage` answers with an `href` to a `.tif` that is then downloaded: a 100 × 100 request came
back as a 33,986-byte tiled, uncompressed, 16-bit signed TIFF. A minimal tag reader is enough to get
at the pixels — no GeoTIFF library needed for thematic single-band data.

#### The EPSG:5070 snapping trap, and how it was caught

**A request must be snapped to the native 30 m grid in 5070, or the service resamples and the "30 m"
in the name is a claim the data does not support.**

The first test asked for 100 × 100 pixels over a bbox in degrees (0.05° × 0.02°, about 3.7 × 2.2 km).
It came back happily — at **37 × 22 m pixels**, a resampling — and its centre pixel read EVC 177
where the `identify` service said 175 at the same coordinate. Two cover points, from a test that
looked like it had passed.

The second test snapped the bbox to multiples of 30 m in 5070 and asked for the matching pixel count:
extent came back as exactly **30.000 × 30.000 m** pixels, and **all 8 pixel centres sampled agreed
with `identify`** at the same point (asked in 5070, so no projection arithmetic of ours was involved
in the check). That is the test to write first when this is built, and it is the test that says
whether the pipeline reads LANDFIRE pixels or a picture of them.

Statewide cost: the bake's own `STATE` bbox is 390 × 605 km, so 13,000 × 20,167 pixels =
**262 million per layer, 785 million for three** — more than the 138.6 M the cells actually occupy,
because a bounding box over Washington is mostly not Washington. At 4,096² that is **16 exports per
layer, 48 for three**, and **1.57 GB** as the uncompressed `S16` the service returned
(`compression: 1`). PNG or LERC would shrink thematic data hard, and clipping requests to the cell
footprint would cut the pixel count by nearly half again; both are worth measuring rather than
assuming, and neither changes the shape of the plan.

#### Step one, which serves either outcome: fetch to a checkpoint

**The expensive step is shared.** Pulling the raster down is the same work whether the result becomes
one summary per cell or a pyramid of tiles, so it should land in a **checkpoint** first and the
emission decision should be taken afterwards, against real data rather than against this entry.

`build-access.mjs` already carries the lesson: *"The access checkpoint is kept on success and
re-assembling from it is free... Deleting it once turned an assembly change into a ten-hour
re-fetch."* A habitat checkpoint of raw 30 m pixels is the same bargain at a similar scale, and every
question below then costs minutes instead of gigabytes.

#### The fork, captured and deliberately not resolved

**Option A — one summary per cell.** Store a distribution instead of four draws: a cover histogram,
height spread, host-type fractions, a true tree fraction.

- **Buys:** a better score, and it lets `COVER_FLOOR` be **retired rather than tuned**. That constant
  is 0.55 today for exactly this reason, in `src/model/vegetation.mjs`'s own words: *"EVC is a 30 m
  average over a square mile and one number cannot tell an even 60% from a mosaic of gaps and closed
  patches."* With the distribution in hand it can tell, so a floor that exists to hedge an unknown
  stops being necessary. The 18.5% of forested cells holding a fourth vegetation type also stop being
  four draws and become a real fraction.
- **Costs:** today's veg block is about nine values a row; a distribution summary is 25–35, so
  `cells.json` grows something like 2–3× over the wire — order 2–3 MB against 1.05 MB now, on top of
  access's 2.23–2.64 MB up front. **Measure it, do not estimate it**, before choosing this shape.
- **Does not answer the question above.** It still hands the user one number per square mile. The good
  acre is inside that number, not on the map.

**Option B — per-pixel tiles.** Emit a derived per-pixel habitat quality as a raster tile pyramid the
map draws at high zoom.

- **Buys:** the actual ask — *where* the good ground is, not that it exists.
- **Costs:** the bigger build. One byte of derived quality per pixel is ~138 MB raw statewide, which
  compresses hard as thematic PNG and is **fetched lazily per viewport**, so the download is not the
  problem — the pyramid, the encoder, zoom handling and cancellation are. "The vector tile loader is
  deleted" already points the way: *"If the 30 m layer is raster, Leaflet's own tile layer does all of
  it already."* Start there rather than recovering `src/tile-source.mjs`.
- **The deep question it raises, which is the real reason not to decide now:** does the **score** go
  per-pixel, or does the score stay per-cell with the tiles as a "where to walk" overlay? Per-pixel
  scoring puts a resolution mismatch into everything downstream — Top spots ranks square miles, the
  access axis is per-cell and would stay per-cell, the filters count cells, and `withAccess()` joins
  on the cell that contains a point. An overlay avoids all of that and answers the question anyway.
  This is a design decision, not an implementation detail, and it wants its own before-and-after.

They are not exclusive: A is a cheap read off the same checkpoint, and B can follow it. Deciding
after the fetch costs nothing and lets the choice be informed.

**Both would give the sub-mile refine something to work with.** `FINE_SIZES` already re-scores at
0.007°, 0.005° and 0.0035° when the map is zoomed in far enough — 779 × 526 m down to 390 × 263 m,
which is **456, 233 and 114 pixels of 30 m**. Today that refine has the same four quarter points to
work from as the whole square mile does, so it varies by terrain and weather and not by vegetation at
all. Option B feeds it directly; option A only if the summary is stored in a form a sub-cell can be
read out of, which is a reason to think about the sub-mile case *before* choosing the summary's
shape rather than after.

#### Sequencing: the band reading comes first. The user's call, 2026-09-12

**Take the mid-October band reading on today's habitat, then rebuild.** The user's reasoning, which is
the part that gets forgotten and reversed:

> *"Band reading in October on today's habitat first, then rebuild. Four weeks costs nothing and keeps
> the season's one calibration interpretable."*

The bands (25/45/65/80) were calibrated against an older, more optimistic distribution and nothing
reaches "very high" — as of 2026-09-12 the deployed app reports **622 sq mi at medium+ of 48,032
(1.3%)** with a ceiling of **75**. A habitat rebuild re-bases habitat scores. Do both at once and the
October reading cannot separate *"the weather finally got good"* from *"habitat was re-based"*, and the
one calibration this season offers is spent. **Do not reorder this to get the rebuild started sooner.**

#### Batch the re-bake, because re-bakes are rare by rule

Hard rule 3 says `cells.json` is not regenerated unless asked, so a re-bake is an event, and
everything that wants one should ride along:

- **The elevation plausibility check** — already queued above under Terrain, explicitly *"when
  `cells.json` is next re-baked for another reason"*: reject an implausible own elevation and record
  `slope 0 / aspect null` rather than a repaired guess. 6 of 48,032 cells, all scoring ≤5.
- **PRISM precipitation multipliers, SSURGO soil water capacity, NIFC fire perimeters** — the three
  still-wanted inputs, all needing a re-bake, none belonging in the UI.

Doing the habitat rebuild as a solo re-bake and then discovering PRISM wants another one is the
avoidable mistake here.

