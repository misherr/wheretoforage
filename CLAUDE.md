# King Bolete Forecast — Washington State

A static web app that maps king bolete (*Boletus edulis*) foraging odds across
Washington, so the user can decide each morning whether it is worth driving
somewhere. Used on iPhone via "Add to Home Screen". No build step, no
dependencies, no server: GitHub Pages serves `index.html` plus three baked JSON
files.

**This file is the operating manual — kept short on purpose.** The reasoning,
the incident history and the long-form detail live in [`docs/`](docs/), indexed
at the bottom. Those writeups are why several bugs have not recurred; when
something here says "see X", read X before changing that area.

## Architecture

```
index.html      the app: Leaflet map, canvas overlay, tap sheet, Top spots
src/model/      the ecological model — the science, and nothing else
src/grid.mjs    the cell lattice, the state outline, terrainAt, pointKey
src/access.mjs  how you would reach a cell — a separate axis, never a score input
src/coords.mjs  the coordinate readout and the paste parser
src/tile-source.mjs  viewport tile loading: manifest, stamped z/x/y, LRU — reusable
scripts/        build-cells.mjs, build-access.mjs, fetch-weather.mjs, serve.mjs
tests/model/    the model regression suite
data/           cells.json, weather.json, evt-names.json, access.json (+ -geom), network-tiles/ — checked in
```

Washington is divided into ~48,000 one-square-mile cells. Each carries baked
terrain and vegetation; weather is fetched for a much sparser set of **anchors**
and joined to cells at load time. A score is
`habitat × trigger rain × soil moisture × temperature × humidity`, multiplied by
a vegetation term, with kill switches for frost, snow and heat.

`index.html` is a `<script type="module">`, so **a local server is mandatory** —
`file://` fails CORS on every import and the page comes up blank with an error
that does not say so. File-by-file detail:
[docs/architecture.md](docs/architecture.md).

## Hard rules

1. **Never push to `main` unless explicitly told.** `dev` is where work happens.
2. **Scoring changes need the user's explicit sign-off.** Constants, thresholds,
   habitat regions, host rules, the structure curve — all tuned by hand against
   field experience, not derived from a spec. This includes changes that *look*
   like obvious corrections.
3. **Do not regenerate `data/cells.json` unless asked.** It is the real baked
   dataset. A rebuild is reproducible, but it moves scores.
4. **Every workflow is repository-guarded, and they point in opposite
   directions** — `weather.yml` and `test.yml` to `misherr/wheretoforage`,
   `staging-pages.yml` to `misherr/wheretoforage-dev`. The staging repo is a full
   mirror, so an unguarded workflow runs twice; `weather.yml` was unguarded once
   and spent a second day's Open-Meteo quota. Any new workflow needs a guard.
5. **`--force-with-lease`, never a bare `--force`**, and `git fetch preview`
   first. A bare force nearly destroyed a commit here already.
6. **Kill node by PID.** `taskkill //IM node.exe` kills every node process on the
   machine, including Adobe's.
7. **Read [`src/model/CLAUDE.md`](src/model/CLAUDE.md) before touching
   `src/model/`.** It carries that directory's rules, and
   `tests/model/purity.test.mjs` enforces them mechanically.
8. **Access never touches a score.** It is a separate axis: its own module
   outside `src/model/`, its own data file, its own section of the tap sheet, and
   a *sort* option in Top spots rather than a filter. Tests assert the model
   cannot even see it. [docs/access.md](docs/access.md)

## Critical invariants

The things that break *quietly* — the map goes blank or the numbers go wrong
while nothing throws.

- **All cell → anchor resolution goes through `anchorHit(lat, lon)`.** Never
  derive anchor coordinates independently. This seam has broken twice, and both
  times every individual tap still returned correct data while the overlay drew
  nothing. [docs/cell-anchor-join.md](docs/cell-anchor-join.md)
- **Grid membership is per anchor, never stride arithmetic.** Deciding by
  `stored.stride % grid.stride === 0` throws away 464 usable anchors and their
  history. [docs/weather-archive.md](docs/weather-archive.md)
- **`scripts/build-cells.mjs` and `index.html` must agree about the lattice.**
  They share `src/grid.mjs` for exactly that reason. A second copy drifts, and
  that has cost 5,844 mismatched cells once and 74 orphaned anchors another time.
- **`today_index` beats the viewer's clock.** Do not simplify `todayIndex()` back
  to a local-date lookup; a viewer one day ahead resolved tomorrow's forecast as
  now.
- **A missing or unrecognised vegetation type is a penalty, not an estimate**
  (`HOST_NO_INFO`). It multiplied by 1.0 once and all 39,981 forested cells
  scored as though their trees were ideal, for days, invisibly.
- **The model is deterministic and takes `doy` as an argument.** Nothing under
  `src/model/` may read the clock, the DOM or the network.
- **The trails layer is a map layer, not a projection of cell references.** It draws
  `data/network-tiles/12/<x>/<y>.json` — every way the bake fetched, minus the urban street grid,
  with its own category per piece and its own stamp. It needs nothing from `access.json`. Building it
  from the ways *cells referenced* (11.6% of the network, 1.4% in Seattle) produced a scatter of
  disconnected stubs on the cell lattice; that conflation is the bug, so the independence is the fix.
  [docs/access.md](docs/access.md#the-trails-layer-draws-a-network-not-the-cells-references)
- **Geometry is loaded by viewport, never whole.** 8 z12 tiles and ~35 KB gzipped for a forest view,
  against 16 MB for the whole network. `access-geom.json` stays whole and lazy for the *tapped*
  approach: clipped geometry is right for drawing and wrong for measuring, and a clip is what
  truncated trails before v4. `src/tile-source.mjs` is the loader and is meant to be reused by the
  30 m rebuild.
- **Every entry gets its access from the cell that contains it, in one place.**
  `withAccess()` in `index.html` wraps every `makeEntry` call — baked cells, the
  sub-mile refine, a live block score, an exact point. It cannot live in
  `makeEntry` itself, which is in `src/model/` and may not know how reachable a
  cell is. Three of those four paths once lacked the lookup, so tapping the map
  and opening the same cell from Top spots disagreed, and the tap read as
  "nothing is mapped" — a false negative wearing the honest answer's clothes.
  [docs/access.md](docs/access.md#a-tap-and-a-top-spots-row-must-be-the-same-cell)
- **"Examined and found nothing" and "never examined" are different answers.**
  The access bake covers the cells in `cells.json`; a point outside that set —
  31.5% of in-state taps — was never looked at, and says so. Only a cell the bake
  actually walked may read as *unknown*.
- **Access data says what is *mapped*, never what exists.** A cell with nothing
  mapped nearby reads as *unknown*, not as trailless — coverage on private
  timberland is patchy, and absence of a mapped way is not absence of a way.
  The same applies to the walk and the climb: with no trailhead to measure from
  they are reported as unavailable, never computed from an arbitrary point, and
  past `WALK_DOUBT` (10 mi) the **total** approach is labelled, never capped or
  hidden — the figure is real and the caveat says what it probably means.
- **An approach has two legs and both are reported.** On-trail from the trailhead
  to the nearest point on the route, then **off-trail in a straight line** from
  there to the cell centre, then the total. v4 reported only the first and stopped
  at the trail, so 924 cells read "0 ft" while the route was up to 1.9 km away.
  The off-trail leg always carries `OFF_TRAIL_NOTE`: it ignores terrain, brush and
  water. A total climb is reported only when both halves are measured.
  [docs/access.md](docs/access.md#the-walk-was-the-wrong-quantity)
- **A trailhead is a coordinate, not a flag.** `thArc` comes from projecting that
  point onto the finished route, so it cannot depend on which end met the road or
  on `joinRoutes` reversing a member. A trailhead that cannot be placed yields no
  walk at all, never a walk from an assumed end.

## Current phase

Phase 0 groundwork, on top of the model work that has just landed: the model
extracted into `src/model/`, the bake moved out of the browser into
`scripts/build-cells.mjs`, host rules restructured into land-cover caps plus
species identity, and a joint stand-structure factor replacing
`fCanopy × fHeight`.

Next, all of which need cells re-baked and none of which belongs in a UI: PRISM
precipitation multipliers, SSURGO soil water capacity, NIFC fire perimeters.
`data/cells.json` is format 2 and carries per-sample vegetation types, so
host-rule changes no longer need a re-bake.

**Deliberately left open:** the score bands (25/45/65/80) were calibrated against
the old, more optimistic distribution, and nothing currently reaches "very high".
That may simply be correct for a dry September. The test is mid-October, when
conditions should be genuinely peak — **do not retune the bands against one dry
week.**

## How to test

```bash
npm test                  # everything: model suite, then data and script suites
npm run test:model        # tests/model/ — relational, snapshot, purity
npm run test:data         # scripts/*.test.mjs
npm run snapshots:update  # deliberate — then READ THE DIFF
```

CI runs the full suite on every push and pull request to `dev` and `main`.

The suite has two halves with **opposite** rules. Relational assertions compare
fixtures against each other and survive retuning — **never relax one to make a
failing model pass**. Snapshots record exact numbers and *are* meant to move when
you tune; a snapshot failure is a question, not a verdict.

After any significant change, check the suite still bites: reintroduce the bug it
was built for and confirm the expected tests fail. A test that cannot fail is not
protecting anything. [docs/testing.md](docs/testing.md)

`npm test` is the floor, not the bar. This app fails quietly enough that a
handful of specific checks have each caught something real — counting unresolved
cells rather than trusting the coverage guard, proving a request did *not*
happen, measuring the grid seam instead of eyeballing the map.
[docs/verification.md](docs/verification.md)

## How to run it locally

```bash
node scripts/serve.mjs 8080
```

Then <http://localhost:8080>. `localhost` is neither a production nor a staging
host, so it always reads its own `data/weather.json`. Check `PUBLIC_MODE` at the
top of the script first: `true` reads only the baked files (what ships), `false`
calls Open-Meteo and LANDFIRE live from the browser.

Node 24 is at `C:\Program Files\nodejs`; the `python` on PATH is the Windows
Store stub and does not run. [docs/development.md](docs/development.md)

## How to deploy

```bash
git push preview dev:dev     # staging → dev.wheretoforage.com
```

That is the entire staging deploy: one plain push, no force, no follow-up.

Landing to production means rebasing `dev` onto `main` first, since `main`
accumulates automated `weather.json` commits that `dev` will not have, then
fast-forwarding `main`. A merge conflicts on `data/weather.json` — it is a
generated artifact, so resolve by taking whichever side you mean to ship, never
by hand-merging. After a rebase the mirrors need realigning with a lease. Full
procedure, including rollback: [docs/deploys.md](docs/deploys.md)

Baking data:

```bash
node scripts/build-cells.mjs            # ~4 min: 305 terrain tiles, 579 LANDFIRE requests
node scripts/build-cells.mjs --resume   # after a connect timeout
node scripts/build-cells.mjs --region=coast
node scripts/build-access.mjs           # 40-80 min: ~316 Overpass tiles + USFS + terrain
node scripts/build-access.mjs --resume  # re-assembles in ~3 min, zero requests
node scripts/build-network-tiles.mjs    # the map layer's tiles, from the checkpoint: ~1 min
```

**Log a long bake to a file you can read while it runs.** `node
scripts/build-access.mjs > bake.log 2>&1` and tail the file. Piping it through
`tail -60` buffers everything until the process exits, which left a 90-minute run
with checkpoint file size as its only progress signal — no tile count, no ETA, and
no way to tell a slow mirror from a wedged one. Same class of mistake as leaving a
waiter process parked on a job that has already finished.

**If the bake gives trouble again, do not add a fifth Overpass mirror.** Four runs
have now been degraded by Overpass one way or another. The fix is a local
Geofabrik extract; see [ROADMAP.md](ROADMAP.md).

**The access checkpoint is kept on success and re-assembling from it is free.**
Everything after the fetch — route joining, elevation, what gets stored, the row
format — is assembly. Deleting the checkpoint once turned an assembly change
into a ten-hour re-fetch. Do not "tidy up" by removing it.

`data/weather.json` maintains itself — `weather.yml` runs two crons, one for both
grids and one forecast-only. [docs/weather-archive.md](docs/weather-archive.md)

## What not to touch

- **`data/cells.json`** — see hard rule 3.
- **`data/evt-names.json`** — 1,069 LANDFIRE codes, checked in because the
  service stopped publishing the mapping and there is no live source for it any
  more. Do not reconstruct codes from legend order.
  [docs/landfire-vegetation.md](docs/landfire-vegetation.md)
- **The repository guards** in `.github/workflows/`.
- **`pointKey`'s five decimals** and the `axisFor()` start/end asymmetry. Both
  look like inconsistencies and are load-bearing.
- **Open-Meteo's `models=` parameter.** Pinning `ecmwf_ifs025` would populate the
  soil variables and silently change the provenance of precipitation and
  temperature, moving every score.

## Where the detail lives

| doc | what is in it |
| --- | --- |
| [architecture.md](docs/architecture.md) | every file, what it does, and why |
| [cell-anchor-join.md](docs/cell-anchor-join.md) | the join, its consumers, and how it has broken |
| [weather-archive.md](docs/weather-archive.md) | two grids, cost model, the seam, call budget, resume guard |
| [landfire-vegetation.md](docs/landfire-vegetation.md) | EVT mapping, the bake that failed silently, host quality |
| [terrain.md](docs/terrain.md) | slope and aspect, the browser-order artifact, `pointKey` |
| [scoring-model.md](docs/scoring-model.md) | the hand-tuned constants, in long form |
| [testing.md](docs/testing.md) | the regression suite and its two halves |
| [verification.md](docs/verification.md) | checks that caught real bugs; traps not to rediscover |
| [development.md](docs/development.md) | local setup, fetch-script environment variables |
| [deploys.md](docs/deploys.md) | branches, staging, rollback |
| [access.md](docs/access.md) | how a cell is reached, and why it never touches a score |
| [ROADMAP.md](ROADMAP.md) | work deliberately not done, and the reasoning for leaving it |
| [`src/model/CLAUDE.md`](src/model/CLAUDE.md) | **rules for changing the model itself** |

## Repo

- Production: <https://github.com/misherr/wheretoforage> → <https://wheretoforage.com>
- Staging: <https://github.com/misherr/wheretoforage-dev> → <https://dev.wheretoforage.com>
- [README.md](README.md) carries deployment troubleshooting.
