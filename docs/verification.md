# Verification that has actually caught bugs
Checks that look like overkill and are not: each one here caught something real.
Followed by the traps worth not rediscovering.

## Verification that has actually caught bugs

This app fails quietly. A broken weather join renders an empty map while every
tap still returns correct data; a broken merge produces confident scores from
rotten history. Checks that look like overkill here have each caught something
real — prefer them to "it loaded fine".

- **Count unresolved cells, don't trust the coverage guard.** `loadFromStatic()`
  only complains when >20% of anchors are missing, which silently tolerated a
  join that was resolving **0 of 475**. Run this in the console after a load and
  demand exactly zero:
  ```js
  let n=0; for(const r of STATIC.cells.rows){ if(!anchorHit(r[0],r[1]).w) n++; } n
  ```
  With two grids, also check how far the fallback is being used — during a
  backfill this is expected to be non-zero and should shrink to zero as the
  dense grid fills:
  ```js
  const d={}; for(const r of STATIC.cells.rows){ const h=anchorHit(r[0],r[1]);
    for(let s=WBASE;s<=WCOARSE;s*=2){ const a=snapLattice(r[0],r[1],s);
      if(key(a[0],a[1])===h.k){ d[s]=(d[s]||0)+1; break; } } } d
  ```
- **Prove a request did *not* happen.** Wrap `window.fetch` and count. That is
  how the refine fix was confirmed to make zero Open-Meteo calls in
  `PUBLIC_MODE`, rather than assuming the guard held.
- **Measure the seam, don't eyeball the map.** The step a naive join creates is
  invisible on the overlay and lethal to the flush model. Compare the last dense
  day with the first forecast day across every anchor and demand the corrected
  join beat the raw one:
  ```js
  let raw=0,fix=0,n=0; for(const [,v] of wcache){ const w=v.w; if(!w||!w.tmax) continue;
    const i=w.today; if(w.tmax[i]==null||w.tmax[i+1]==null) continue;
    fix+=Math.abs(w.tmax[i+1]-w.tmax[i]); n++; }
  console.log('mean |ΔTmax| at the seam:', (fix/n).toFixed(2), 'over', n, 'anchors');
  ```
  A day-to-day temperature change of ~1 °C is weather; a systematic 2–3 °C jump
  concentrated exactly at `today` is the seam.
- **Corrupt the archive and watch the merge repair it.** Setting a known-bad
  value inside the rolling window and another outside it proves the window
  boundary exactly: the first is repaired to match a full fetch, the second
  persists. Equality against a fresh full fetch alone would not show that. Do
  this per grid — the dense grid's window is 3 days, the coarse grid's is 1.
- **Cross-check retained history after a densification** against the archive you
  started from — otherwise "it kept the history" is an assumption.
- **Test the budget guard by starving it.** Run with `DAILY_CALL_CEILING` set
  low enough to stop mid-backfill, then re-run with a higher one and confirm the
  second run resumes rather than refetching. That is how the ledger's
  cross-process persistence was confirmed, and how the `FORECAST_RESERVE`
  hold-back was shown to actually bind.
- **Test the resume guard per grid, not once.** Re-run immediately and confirm
  *both* grids skip; then confirm the windows differ (19.2h vs 9.6h) and that
  12h on, the coarse grid is due and the dense one is not. A single shared
  window passes the first check and fails the second.
- **Simulate the clock, don't reason about timezones.** Stubbing `Date` proved
  a viewer one day ahead resolved index 27 instead of 26 — tomorrow's forecast
  shown as now. See `today_index` below.
- **Test host guards as a matrix**, including a hostile lookalike. The staging
  guard is checked against `wheretoforage.com`, `www.`, `dev.`, `localhost`,
  `127.0.0.1` and `evil-wheretoforage.com`.
- **CORS: test from a real second origin.** `curl` showed
  `Access-Control-Allow-Origin: *`, but only a browser fetch from
  `localhost:8080` to `wheretoforage.com` proves the browser agrees. (In JS the
  header itself reads `null` — it is not CORS-safelisted. A successful parse is
  the proof, not the header.)

## Traps worth not rediscovering

- **Open the tap sheet from the console.** It is the part of the app no test
  reaches — a `dim is not defined` crash in the access block got through the
  whole suite and was only found by tapping a cell. `showPoint` and the Leaflet
  map are exposed for this:
  ```js
  const e = cells.get('3361:-5681');          // any cell index, i:j
  leafletMap.setView([e.lat, e.lon], 13); showPoint(e);
  document.getElementById('sheet-body').innerText
  ```
  To check the drawn approach is the whole route rather than a fragment, click
  the link and measure what landed on the map:
  ```js
  document.querySelector('#sheet-body a.drawway').click();
  // after it loads:
  let pl; leafletMap.eachLayer(l => { if (l.getLatLngs && !pl) pl = l; });
  const p = pl.getLatLngs(); let m = 0;
  for (let i = 1; i < p.length; i++) m += p[i-1].distanceTo(p[i]);
  console.log(p.length, 'points,', (m/1609.34).toFixed(2), 'mi');
  ```
  Baker Lake Trail is the case that proves the joining: it was two ways of
  7.18 mi and 2.37 mi, and draws as one 9.54 mi route with 68 points.
- **The console verification snippets need the names exposed deliberately.** The
  inline script is a module, so its scope is not the global scope and
  `anchorHit`, `cells`, `wcache`, `STATIC`, `snapLattice`, `key`, `WBASE`,
  `WCOARSE` and `WLATTICE` are re-exported onto `window` at the end of it for
  exactly that reason. `WBASE`/`WCOARSE`/`WLATTICE` are bound as live getters,
  not copied — they are reassigned when the archive loads. If a snippet below
  starts reporting `undefined`, check that list before concluding the join broke.
- **`today_index` beats the viewer's clock.** `todayIndex()` prefers the value
  written in the archive's own timezone and only falls back to a local-date
  lookup, then the `past_days` clamp. Don't "simplify" it back to
  `time.indexOf(localISO(new Date()))`. With two grids it is the **dense** grid's
  index that defines today, because the dense grid is what ends there.
- **Grid membership is per anchor, never per stride.** Deciding by
  `stored.stride % grid.stride === 0` discards 464 perfectly good coarse anchors
  from a stride-4 archive. See "Membership decides which grid an anchor belongs
  to".
- **A checkpoint write must not be able to kill the run.** `writeOut` renames a
  temp file into place, retries, and only throws on the final write. A transient
  Windows sharing violation on `data/weather.json` destroyed a 1,300-call run
  before that; the checkpoint it had already written survived intact, which is
  the only reason it was cheap to recover.
- **Both 0–7 cm soil variables are accepted by Open-Meteo and return all-null**
  under the default model. Only `models=ecmwf_ifs025` populates them, and
  pinning that would change the provenance of precipitation and temperature and
  move every score. The probe drops them automatically; they will switch on by
  themselves if Open-Meteo starts serving them. This is why we ship 8 usable
  variables, not 10.
- **`UND_ERR_CONNECT_TIMEOUT` is normal on GitHub runners**, several per run,
  always recovering within the 8 retries. It is the original bug that killed the
  pre-rewrite script. Only worry if retries approach the ceiling.
- **`node --test scripts/` fails on Node 24** — it resolves the directory as a
  module. Pass the file: `node --test scripts/fetch-weather.test.mjs`.
- **PowerShell reports git's stderr as an error** even on success. `git push`
  writing progress to stderr is not a failure; read the actual result line.
- **This machine had neither Node nor Python** (the `python` on PATH is the
  Windows Store stub). Node 24 is now installed at `C:\Program Files\nodejs`;
  `gh` 2.100 is installed and authenticated.
- **`taskkill //IM node.exe` kills every node process on the machine**,
  including Adobe Creative Cloud's. Kill by PID.
- **Local runs and Actions runs draw on different Open-Meteo quotas** — the free
  tier is rate-limited by IP, so building an archive locally does not spend
  production's allowance. The ledger in `data/weather.json` is per file, so a
  local build and a runner build each keep their own count; don't read one as
  authoritative for the other.
- **A bare `git push --force` to `preview` can destroy someone else's commit** —
  it did nearly hide the staging repo's rogue weather job. Use
  `--force-with-lease`, and `git fetch preview` first or the lease goes stale.

## Does the DEM garbage reach slope and aspect?

Terrarium contains patches of garbage at water/land boundaries — see
[terrain.md](terrain.md#the-terrarium-tiles-contain-garbage-at-waterland-boundaries).
It corrupts `terrainAt` for 6 of 48,032 cells today. The check that measures it,
rather than assuming either way:

1. Fetch every z10 tile covering the state bbox **plus one tile of margin** —
   de-spiking a pixel on a tile edge needs neighbours from the next tile over.
2. Call a pixel an outlier when it sits more than 300 m from the median of its 8
   neighbours (statewide p99.99 is 130 m, so 300 m is well clear of real ground).
3. Recompute every cell's slope and aspect **twice from the same tiles**, once raw
   and once with outliers replaced. Comparing raw against the checked-in
   `cells.json` instead would confound the answer with the one-sided-gradient
   edge cells — 1,192 of them, and all 1,192 turned out to have a neighbour that
   is not itself a baked cell, which is the proof that the reconstruction is
   faithful rather than a coincidence.
4. Cross-check the affected sample points against **USGS 3DEP** (`epqs.nationalmap.gov`),
   not against a median. This is what showed that a median cannot repair these
   patches: it takes the worst error from 1,141 m only to 139 m, because the
   garbage is 13–43 pixels wide.
5. Then ask what the user would see. The two worst cells score **2 and 1** out of
   100, because the LANDFIRE samples are 50% Open Water and the vegetation
   multiplier is 0.15. A terrain error that cannot move a score is not worth a
   re-bake.

The habitat gate is the part worth re-checking after any elevation change:
`everHabitat(lat, lon, elev, doy) > 0.08` decides whether a cell exists at all,
so a garbage elevation can *create* a cell (46.26225,-123.5957, a Columbia River
cell reading 965 m) or *delete* one (47.68325,-122.2475 reading -503 m). Count
that directly; it does not show up in any distribution of the cells you have.

## Driving the walk caveat by hand

522 cells show the long-walk caveat. The longest is cell (3206, -5675), centre
46.49425,-121.4343 — a PCT cell claiming 68.5 mi from its only mapped trailhead,
with an unnamed trail 0.3 mi away in "Also nearby", which is the whole reason the
caveat exists. With the app open:

```js
const e = [...cells.values()].find(c => Math.abs(c.lat-46.49425)<1e-6 && Math.abs(c.lon+121.4343)<1e-6);
showPoint(e);
document.querySelector('#sheet-body .caveat').textContent
```

The assertion in `build-access.test.mjs` proves the caveat is *rendered*; only
opening it shows that it reads as a caveat and not as an error, and that the
number above it is still 68.5 mi.

## A tap and Top spots on the same cell

The invariant that was missing, and the reason it was missing is that no test
compared the two paths. Two halves, and both are needed:

```js
// behavioural: any point inside a cell resolves to that cell's row
accessDetail(accessAt(byCell, tapLat, tapLon), ways)
  === accessDetail(accessAt(byCell, centreLat, centreLon), ways)
```

```js
// structural: every makeEntry call site is wrapped, so a fifth path cannot skip it
lines.filter(l => /makeEntry\(/.test(l)).forEach(l => assert.match(l, /withAccess\(makeEntry\(/))
```

The behavioural half alone would have passed on the broken app — the lookup it
tests was always correct. The structural half is the one that would have caught
the bug, because the bug was that three of four call sites never called it.

By hand, with the app open, the three cases that must agree:

```js
// 1. tap a baked cell    2. the same point as an exact point    3. a point outside the baked set
const e = [...cells.values()].find(c => Math.abs(c.lat-46.49425)<1e-6 && Math.abs(c.lon+121.4343)<1e-6);
leafletMap.fire('click', {latlng: L.latLng(e.lat, e.lon)});     // -> PCNST Trail, 68.5 mi
document.getElementById('btn-exact').click();                   // -> identical, plus the scope note
leafletMap.fire('click', {latlng: L.latLng(46.8628, -119.7086)}); // -> "Access not checked here"
```

Case 3 is the one to keep an eye on: before the fix it read "No mapped access —
nothing is mapped within about a mile", which is a claim about a lookup that
never happened. It is reachable from a third of in-state taps, and no assertion
about `cells.json` cells would ever have exercised it.

## Tracing a walk figure end to end

The check that found the zero-walk bug, and the one to repeat on any figure that
looks wrong. Per cell, from the shipped files alone:

1. `decodeRow` → which category, its distance, its way index.
2. `decodeWay` → the name, the trailhead **kind**, how many ways were joined.
3. `nearestOnWay(geom, cellLat, cellLon)` → `{d, arc, pt}`: how far the route is
   from the cell centre, and how far along the route that point sits.
4. Solve for the trailhead arc: the shipped walk is `|proj.arc − thArc|`, so
   `thArc` is `proj.arc ± walk`. Print the coordinate at each candidate and how
   far it is from the cell.
5. Compare the route's start and end against the cell. If the closest approach is
   at arc 0 or at the far end, the route does not come near the cell at all.

What that showed: three cells reporting 0 whose closest approach was **at arc 0**,
1.9 km from the cell, with the inferred trailhead pinned to the same arc 0.

Do not trust a trailhead flag without checking the ground under it:

```
# is the arc-0 end of an inferred-trailhead route actually at a road?
Overpass: way["highway"~"^(motorway|trunk|...|residential)$"](bbox around the route)
USFS:     EDW_RoadBasic_01/0/query, keep OPER_MAINT_LEVEL matching /^[345]/
then nearestOnWay(road, end) <= TH_SNAP_M (60 m) for BOTH ends
```

**Query both sources.** Checking OSM alone made one route (BEAR LAKE) look like a
trailhead with no road at either end; the USFS layer has a drivable road 1 m from
its arc 0. Five of 25 sampled routes had only their far end at a road, and that
finding only survives because both sources were checked.

## The coordinate round trip

```js
// the app's own readout must parse back to the same place
parseCoords(formatCoords(47.45125, -119.9363))   // -> {lat: 47.45125, lon: -119.9363}
// and a tap and a paste must resolve identically
showAt(47.45125, -119.9363)                      // the same function the map click uses
```

A test that never runs is worse than no test: `test:data` names its files
explicitly rather than globbing, and `scripts/coords.test.mjs` passed ten
assertions for a while without being run by `npm test`. Two mutations that should
have failed did not, which is how it was noticed. **After adding a test file,
check the count in `npm test` actually went up.**

## The roads overlay

It is a third party's raster, so there is little of ours to break — and what can
break does it silently: a blend that multiplies against nothing, a credit that
goes missing, a fallback that answers 401.

**The blend is on the pane, and it is applied.** With the overlay switched on:

```js
leafletMap.getPane('roads').getAttribute('style')
// z-index: 420; pointer-events: none; mix-blend-mode: multiply; filter: saturate(0.35) brightness(1.3) contrast(1.8);
leafletMap.getPane('approach').style.zIndex     // 430: above the roads, or the road darkens the line
```

A blend set on the tile layer's own container, inside the pane, multiplies
against the pane's empty backdrop: the tiles draw opaque and the imagery vanishes
under a topo map.

**Measure the tint; do not eyeball it.** Composite the same tiles in a canvas —
`globalCompositeOperation='multiply'`, `globalAlpha` and `ctx.filter` are the same
arithmetic as the CSS — and compare mean luminance against the satellite alone.
Esri, OpenTopoMap and Stadia all send `Access-Control-Allow-Origin: *`, so the
canvas stays readable. Over three forest views:

| treatment | brightness against the satellite alone |
| --- | --- |
| multiply, 100% | −21 to −22%, and greened |
| multiply at 70% / 50% | −15% / −11%, with the lines faded just as much |
| multiply, greyscale | −22% |
| multiply, `saturate(.35) brightness(1.15) contrast(1.6)` | −3.5 to −5.5%, but −9% on steep ground |
| **multiply, `saturate(.35) brightness(1.3) contrast(1.8)`** | **−1 to −1.5%, −4% on steep ground, no colour shift** |

**Measure a steep view too.** The first filter looked finished on three gentle forest views and
darkened a steep slope near Mt Baker by 9%: OpenTopoMap's hillshade is darkest exactly where the
terrain is worth reading. An average over gentle ground hides that.

Opacity is the wrong knob: it scales the lines and the tint together. Whitening
the fills removes the tint and keeps the lines. Full greyscale was rejected by
looking, not by the numbers — a blue stream becomes a black line that reads as a
track.

**The credit is the licence's, not a courtesy.** Whenever OpenTopoMap is on
screen, as basemap or overlay, the attribution control must read
`Map data: © OpenStreetMap contributors, SRTM | Map style: © OpenTopoMap (CC-BY-SA)`.

**Try the fallback before relying on it.** Load `?roads=stadia` from each
production host. Until the domains are registered with Stadia every tile is an
HTTP 401 **whose body is itself a PNG** — Stadia's "401 Error — Invalid
Authentication" tile, with a QR code — so the map fills with error tiles rather
than going blank. Checking that the tile images loaded (`complete`,
`naturalWidth > 0`) passes all of them; it did on the first check here. Check the
status code:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "Referer: https://wheretoforage.com/" \
  https://tiles.stadiamaps.com/tiles/stamen_terrain_lines/14/2564/5731.png   # 200 once registered
```

**And the lesson the vector layers left.** Both passed every test. The first drew
one nearest way per cell — 11.6% of the network, 1.4% in Seattle, 1.1 ways per
connected piece — and it took looking at Seattle to see a scatter of stubs. The
second drew the whole network and showed 15% of it twice. Look at a dense urban
view and a forest view before believing any map layer.

## Measuring the access rules one at a time

The rules that reconcile OSM with USFS all change shipped figures, and one
before/after diff cannot say which change did what. So `build()` takes
`opts.rules` — `{ snow, described, usfs }`, each on unless set `false` — and
`opts.noUpgrade`, and the verification re-assembles the same checkpoint in
stages, each about 30 s with the z10 terrain tiles cached locally:

| stage | checkpoint | rules | isolates |
| --- | --- | --- | --- |
| B0 | — | — | the file that shipped |
| B1 | schema 1, not upgraded | none | moving stamping and trailheads from the fetch to assembly |
| B2 | upgraded | none | USFS re-fetched by page, one way per path |
| B3 | upgraded | snow | over-snow routes |
| B4 | upgraded | snow, described | the describing tags on OSM-only roads |
| B5 | upgraded | all | USFS deciding, with its exceptions |

**Measure the method change before any rule.** B0 → B1 alone renamed the way in
1,344 cells, at a median distance change of 3 m (90th percentile 12 m): stamping
on the stored, 25 m-simplified geometry breaks near-ties between the OSM and USFS
copies of one road differently from the full geometry the fetch used. 245 walks
went and 182 appeared the same way. Without B1 all of that would have been
blamed on the rules.

**Check trailheads independently of `inferTrailheads`.** Rebuild the stage's
categories from its checkpoint with the same rules, then brute-force the nearest
drivable way to every inferred trailhead point. Sample roads **along** their
segments: the first version filed roads by vertex only and reported 50 failures
that were its own — a simplified straight road can have vertices a kilometre
apart and pass right by a trailhead.

**Every approach whose trailhead stopped being one** — in every category, not
only the named one — must now show no walk, or a walk from a different point that
the independent check puts at a drivable road. The old figure from the old point
is a failure, whatever else is true.

**Then ask the sources live** for a spread of those cells: Overpass and USFS
around the old point and around the new one. Query both, for the reason in
"Do not trust a trailhead flag" above.

**The upgrade's statewide tag query.** `way["highway"~...]["motor_vehicle"="no"]`
over the whole state timed out with a 504 on every mirror. Filter by the
selective tag alone — `take()` already ignores ways the checkpoint does not hold
— and split an area that fails into quarters, as the tile fetch does.

## The hike network

The figures are only as good as the network under them, and every part of the
network is inferred — so each part is checked by something other than the code
that built it.

**The route adds up to the figure.** For every cell with a stored route, sum the
decoded edges plus the partial last edge and compare with the hike figure's
on-network metres. The first version sampled twenty points per segment to find
where a route leaves the network, which left 44 routes more than 50 m off their
figure — up to 231 m on long straight segments; an exact projection fixed it.

**Why the car stopped is where it says.** Every "mapped gate" stop must lie within
the gate snapping distance of a mapped gate (it lands on the road and is kept six
metres off any junction, so 31 m at most). Every "private road" stop must lie on a
road tagged closed to cars.

**Then ask OSM live**, 40 m around a spread of those points: a barrier for each
gate stop, an `access`/`motor_vehicle` restriction for each private-road stop.

**Deming is the regression case.** 48.8003140, -122.0556248: the gate six miles
short is unmapped, so the hike figure is a drive-up and must stay honest about
that; the worst case must stay a long approach of roughly five and a half hours.
If a change makes the worst case short, something has started trusting gravel.

**A crossing on a vertex.** The first crossing test required the lines to cross
strictly inside both segments. An OSM intersection is a node shared by both ways,
and when simplification keeps it the lines meet exactly at a vertex of each — so
every one of those was missed, and the test that caught it was a synthetic
junction built on round numbers. Build fixtures on round numbers on purpose.

**Filters state their cost.** With "within a 2 h hike" on, the legend and Top
spots must both say how many cells are hidden and how many of those have no
mapped route; and turning the filter off must bring back exactly the cells it
hid, with the same scores.

## The false-junction rate, measured

Junctions are inferred, so "some false connections" was the honest description and
a useless one. Measured 2026-09-11. The scripts are throwaway; the method is not.

**1. Get the joins the real code makes, not a copy of the rules.** `buildNetwork`
takes an `onJoin` hook: every inferred join is offered to it with its kind, both
way ids, where it falls on each way, the gap between them, and the distance from
the contact point to the nearest vertex of each way. Returning false vetoes it.
A census run offered 1,559,805 joins and matched the shipped provenance exactly,
which is the check that the hook sees everything.

**2. Ask a source that is not the code under test.** Overpass holds the node ids
the checkpoint threw away. For a stratified sample of 3,089 joins between two OSM
ways, `way(id:…); out skel;` gives each way's node list, the intersection gives the
shared nodes, `node(id:…); out skel;` gives their coordinates, and `out tags;` gives
bridge, tunnel and layer. A shared node within 40 m of the inferred point confirms
the join; a bridge or tunnel tag with no shared node is a grade separation.

**3. Split the rate by the two things it depends on** — the classes of the two ways
and the size of the gap — or the answer is a meaningless average. Forest classes
4.6% unconfirmed, everything else 20.4%; an end-to-end join inside a metre 0.4%,
beyond a metre 40–60%.

**4. Price it by re-running the bake with those joins vetoed.** A deterministic
coin — a hash of the join, so a re-run removes the same set — vetoes each join with
the probability its class turned out to be unconfirmed, and the whole modes pass is
recomputed and diffed against the shipped figures. 6.2% of hike figures change,
1.7% of buckets, median 17 minutes. Also worth running as pure upper bounds: every
crossing (22.6% of figures, 1.05% of buckets), every end join over 5 m (30.6%,
9.2%).

**5. Measure the other direction too.** For 600 random forest ways, ask Overpass
for every way sharing a node with them, keep the ones the bake holds, and check
whether the inference joined each pair: 1,398 of 1,461 found, 95.7% recall.

**6. Then look at some.** A local page with Esri imagery, the two ways drawn in red
and blue and the inferred point circled, answers what the tags cannot. Eight
forest-class unconfirmed joins were all passable on foot. "OSM does not assert a
connection" is an upper bound on "there is no connection", and in the woods a loose
one.

Traps this found:

- **Vertex evidence does not work.** 25 m simplification deletes the shared node
  from the line, so only 192 of 12,297 OSM-to-OSM crossings have a vertex within a
  metre of the crossing — while 81% of them are real. A rule built on it would
  delete mostly-true junctions.
- **Water needs polygons, and polygons are relations.** A first pass fetched
  `natural=water` ways and found nothing on the Columbia, because big rivers are
  multipolygon relations whose member ways carry no tags. The river *centreline*
  (`waterway=river`) is the test that works for "does this route cross the river".
- **Compare encoded geometry by value.** The drive's route was compared with the
  hike's using `!==` on two arrays, so all 25,999 were "different" and the routes
  file grew 5 MB for nothing. `scripts/access-modes.test.mjs` now guards it.

## The drive, checked

The drive figure is checked against the other two figures in its own row, which is
cheap and catches what a spot check would not:

- **The hike can never be the longer walk.** The drive's walk starts somewhere a
  car can get to, and the hike is the least foot minutes from anywhere a car can
  get to. 249 rows of 46,634 read otherwise; all are the off-trail climb being
  estimated while the candidate is chosen and measured afterwards, which can make
  the two modes pick different points. Worth re-running after any change to the
  selection: a sharp rise means the two modes have really diverged.
- **The worst case can never beat walking the drive's own road**, since it starts
  at the same pavement and may walk anything. 182 rows, same cause.
- **Check the extremes against the map.** The five deepest drives in the state are
  all within a kilometre of the Idaho line, and the nearest pavement to the
  deepest one is 4 miles away — in Idaho, which the bake does not hold. Without
  that check the 134-minute figure looks like a bug in the router rather than the
  edge of the data.
- **Say the edge of the data where it applies, and count how often that is.** The
  border caveat fires for 892 of 46,923 cells — 1.9%, which is a caveat. Had it
  fired for 20% it would have been noise, and the first version did: including the
  Pacific coast in the land border flagged every coastal cell for a road that does
  not exist. Count before shipping a warning.
- **Profile the speed classes before trusting them.** 61% of the drivable network
  `paved()` does not call pavement is `highway=residential`: the first version put
  all of it in the 15 mph class and 98.1% of every drive was "rough gravel". Moving
  streets to the graded class took it to 1.8 / 17.7 / 80.5 — and the profile was
  still wrong, because the maintenance level was not reaching the network at all
  (see above). With `ml` passed through it is **1.8 / 24.3 / 73.8**. A share that
  sits at exactly 0.0% — as the graded class did before streets were moved — is the
  cheapest bug detector in this file. Read the profile, not just the totals.

## The bike, checked

Two bugs came out of checking the bike against the figures beside it rather than
against itself, and both were silent:

- **A bike figure can never be worse than the hike figure**, because the bike is
  carried to where the car stops and can always walk from there. 9,157 cells said
  otherwise. The cause was not the ride: the bike's sources are network NODES,
  while a car stops anywhere along an edge, so the bike was made to ride the last
  few hundred metres of a road the car could have driven. After adding the carried
  predicate, 222 cells (0.5%) — the off-trail-climb estimate, the same residue the
  drive has. **Run this check after any change to either mode's selection.**
- **Every field a rule stamps has to reach the network.** `computeModes` copies
  each way by hand, and `ml`, `bk` and `closed` were missing from that copy: the
  drive's 25 mph class was unreachable — 98% of every drive read as "rough gravel" —
  and 9,106 `bicycle=no` ways blocked exactly nothing, while the log cheerfully
  reported finding them. The tell was a statistic that was too round: `"bicycle": 0`
  in the blocks summary with 9,106 tagged ways in the upgrade log two screens
  above. `scripts/access-modes.test.mjs` now bakes a four-way fixture end to end
  and asserts both.

And two checks that confirmed what they should:

- **The wilderness polygons against the live service.** Eight points inside the
  eight largest areas and four points walked 2 km out of them, each asked of the
  USFS query endpoint one at a time: 12 of 12 agree with the stored rings. A first
  attempt at this checked whether the *dismount* points were inside, which is the
  wrong question — the dismount is the last junction OUTSIDE the boundary. Measured
  against the rings instead, a wilderness dismount sits a median of 40 m from the
  line (p90 146 m), which is the granularity of the junctions, not an error.
- **The price of a conservative rule, by re-baking with it off.** Letting bikes ride
  the closed-roads layer makes 4,109 cells (8.8%) quicker by a median 12 minutes.
  That is the number the decision should be revisited against; `--out` to a
  scratch path with `--checkpoint` pointed at the real one makes such a variant
  bake free of consequences.

## Assert on the effect, not on the log

The `computeModes` copy bug reported itself as success: the upgrade log said
**"where a bicycle is forbidden: {no: 8914, private: 155, dismount: 37}"** — nine
thousand ways found, correctly — while the blocks summary two screens later said
`"bicycle": 0`. Both lines were true. The fetch had done its work and the network
never saw it, because `computeModes` copies each way by hand and `bk` was not in the
copy.

This is the same shape as the most expensive failures in this file:

- the LANDFIRE bake that reported 39,981 forested cells while every one of them
  scored as though its trees were ideal;
- trailheads counted and logged during the fetch while 8.4% of them rested on a road
  no car could use;
- the anchor join that reported every tap correctly while the overlay drew nothing.

In each case the log described the **work attempted** and nothing checked that the
work **landed**. So:

- **Assert one hop past the thing you just did.** Not "the query returned 9,106
  ways" but "9,106 ways now block something". Not "the bake wrote 46,923 rows" but
  "a row taken at random decodes into the figure the sheet shows".
- **A zero in a summary is a bug report.** `"bicycle": 0` beside a fetch that found
  thousands, and `graded 0.0%` in a profile of a three-class speed model, were each
  the whole bug, printed, for a version. Read the profile, not just the totals, and
  treat a share that is exactly zero as a failed assertion until proved otherwise.
- **Where data crosses a boundary by hand — a copy, a column list, a row format —
  test the far side.** `scripts/access-modes.test.mjs` bakes a four-way fixture end
  to end and asserts that a maintenance level changes a drive time and a
  `bicycle=no` tag changes a bike figure. Both fail when the field is dropped from
  the copy, which no amount of log-reading did.

## An ArcGIS objectid is not a key

The schema-5 upgrade needed two attributes for trail records the checkpoint already held, so the
first version asked for those attributes alone — no geometry — and matched them to the stored ways by
`objectid`. It reported four pages read and stamped **nothing**: EDW had republished the layer, and
the objectids it now serves are about 86,000 higher than the ones in a checkpoint from the week
before. The same trail, a different id.

Two lessons, and the first is the one from the section above:

- **The effect assertion caught it.** The log said "usfs_pages: 4"; the counter that mattered said
  "usfs_designated: 0", and a dirt bike figure built on that would have had no singletrack at all
  while looking perfectly healthy. The bake now **throws** if it reads a hundred trail records and
  finds no motorized designation on any of them — a fixture of two trails does not trip it, a real
  fetch that lost its fields does.
- **Match an external record by something the publisher promises to keep.** For EDW that is not the
  objectid. The fix was to re-fetch the trail records with their geometry and replace the old ones
  outright, the way schema 2 re-paged the roads: the layer is 3,408 features statewide, so the
  "expensive" option costs four requests.

## The rider's worst case, checked

The "if the gravel is gated" figure had been one walk from the pavement, shown under every mode, since
v6. Changing a figure that old wants more than "the new number looks smaller", so v10's was checked
three ways.

**It is a bound.** Two properties have to hold on every cell, and they are opposite in direction:

- **Never quicker than the mode's own figure.** The worst case starts at the pavement; the figure
  starts wherever the car reached, which is a superset of the pavement, so more sources can only be
  quicker. **362 cells of 93,268 read otherwise (0.4%)**, and none of those numbers reaches a
  viewer: the sheet says "no different" whenever the bound is within five minutes of the figure
  beside it.
- **Never slower than walking the same road.** A rider may always push, so the walker's bound is a
  ceiling. **371 cells (0.4%)** — the same share the drive's worst case has had since v7.

The 0.4% was attributed rather than shrugged at, in order of size: the off-trail climb is
*estimated* while an approach is chosen and *measured* afterwards (251 of the 362); "the nearest
paved road" can be pavement the car cannot actually reach, behind a gate, which the walker's bound has
always allowed and the rider's now inherits (93); and the two scans picked different approach points
outright (18). **The bake's own counter says 57, not 362** — it compares the totals the router chose
on, which carry the estimated off-trail climb, while this count reads the finished files. Two
measurements of one property, and the disagreement between them is the estimate, which is worth
knowing rather than reconciling away.

Both are counted in the bake itself — `stats.worst_ride` — rather than only in a test, because the
fixture that proves the logic cannot prove it against 46,634 real cells. A wave of violations in
either direction would mean the sources were wrong; a handful would mean the approach scan chose
different points, which it is allowed to do.

**The figure moves, and by how much.** The bicycle's bound beats the walk for 38,349 of 46,634
cells (82.2%) by a median 58 minutes; the dirt bike's for 37,255 (79.9%) by a median 74, and by
more than two hours for 12,638 of them. At Deming — the cell this whole caveat exists for — 5.5 h becomes **1.5 h** on the
dirt bike and 3 h on the bicycle. The largest correction in the state is 14 h against 2 h, a cell in
the Colville forest 28 miles up a road from the nearest pavement.

Two figures are unchanged on purpose: the hike and the drive still read the same walk out of the base
file, because a closure leaves both of them on foot at the pavement. If those had moved, something
would be wrong.

**The sheet says the new thing.** A regex over `index.html` proves a call is written; it does not
prove the words that come out. So `worstBlock` is now **extracted from index.html and run** against a
record shaped like Deming, with the app's module scope handed in and `MODE` as a parameter — the
assertion is on the rendered text: a rider is told a ride, a walker is told the walk, and a rider with
nothing rideable at the pavement is told the walk *and why*. The regex-only version of that test
passed unchanged when the rider branch was disabled with `const ridden=false&&…`; the runnable one
fails on the first assertion. That is the same gap as a log line reporting 9,106 blocked ways that
blocked nothing — see [Assert on the effect, not on the log](#assert-on-the-effect-not-on-the-log).
