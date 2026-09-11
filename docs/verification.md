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

## The trails layer

Three things break quietly here, and none of them shows up as an error.

**A gap at every tile edge.** Clipping keeps the crossing segment in both tiles;
drop it and the map grows a faint grid of breaks that reads as missing data. The
test asserts every consecutive pair of the original polyline appears as a
consecutive pair in some tile — not that the pieces share endpoints, which passes
on a broken split.

**A stale tile set.** Way indices only mean something against the ways table they
were built with, so a tile set from another bake draws real lines in the wrong
places. Both defences are in `src/tile-source.mjs`: the stamp in every URL, and
the manifest's `generated` checked against the loaded data's. Verify by hand:

```js
// every request the layer makes must carry ?g=<the bake stamp>
performance.getEntriesByType('resource').filter(e => /access-tiles/.test(e.name)).map(e => e.name)
```

**A regional bake overwriting the statewide tiles.** `writeTiles` took the module
default, so `--out=/tmp/a.json` wrote 3 tiles over the 271 in `data/`. Found by
running a regional bake and looking at what changed on disk, which is the only way
it could have been found. After any regional bake, check:

```bash
find data/access-tiles -name "*.json" | wc -l     # 272: 271 tiles + index.json
```

And the count the layer is for: at z12 over the densest ground the map should read
as routes, not as a blur. 460 pieces in the worst z10 tile, 259 of them rough
roads — turn rough off and the same view should be legibly emptier. That is a
judgement a test cannot make, so it is made by looking.
