# King Bolete Forecast — Washington State

A single-file static web app that maps king bolete (*Boletus edulis*) foraging
odds across Washington State, so the user can decide each morning whether
it's worth driving somewhere to forage. Used on iPhone via "Add to Home
Screen."

## Files

- **`src/grid.mjs`** — the cell lattice (`DLAT`/`DLON`/`BLK`, `cellCenter`,
  `cellKey`), the Washington outline (`inWA`), and `terrainAt()` for slope and
  aspect. Imported by **both** `index.html` and `scripts/build-cells.mjs`, and
  that is the point: while `cells.json` came out of a button inside the app there
  was exactly one copy of this geometry by construction, and with a separate bake
  script there would be two. See "The script must agree with the app" — that
  mistake has already cost this repo 5,844 mismatched cells once and 74 orphaned
  anchors another time. It also carries `pointKey`, the elevation-cache key, which
  now matches `cellCenter`'s five decimals — it truncated to four, and that
  quietly cost 77 of every 300 cells a two-sided north-south gradient.
- **`src/model/`** — the ecological model, extracted from `index.html` so that
  changing the science does not mean reading the whole application: `util.mjs`
  (numeric curves, unit conversions, score bands), `habitat.mjs` (region,
  season, elevation band), `weather-score.mjs` (`analyze`, `fullAnalysis`,
  `adjustWeather`, `verdict`), `phenology.mjs` (the fruiting-stage mix),
  `vegetation.mjs` (LANDFIRE host quality) and `cell.mjs` (the composition
  root: `makeEntry`/`applyVeg`). Pure functions, no DOM, no fetch, no Leaflet,
  deterministic. **Read `src/model/CLAUDE.md` before changing anything in
  there** — it carries the rules for the directory, and
  `tests/model/purity.test.mjs` enforces them.
- **`index.html`** — the app around the model. Leaflet map, canvas-rendered overlay of
  ~23,000 one-square-mile cells, a layers menu (chance / habitat quality /
  trailing 7-day rain / soil moisture, multi-select), a play-through timeline
  for the 7-day forecast, a tap-a-cell breakdown sheet, a "Top spots" panel,
  and a "How it works" info panel.
  - The inline script is `<script type="module">` and imports from
    `./src/model/`. That makes a local server **mandatory** — see "Local
    development"; `file://` fails CORS on every import and the page renders
    blank with a console error that does not obviously say so.
  - `const PUBLIC_MODE` near the top of the script switches the whole
    app between two modes:
    - `false` — live API mode: fetches Open-Meteo weather and LANDFIRE
      vegetation itself, used for local development only. It no longer bakes
      `data/cells.json` — `scripts/build-cells.mjs` does that.
    - `true` — public mode: reads only `data/cells.json` and
      `data/weather.json`, never calls an API from the phone. This is what
      gets deployed (GitHub Pages).
- **`data/cells.json`** — baked per-cell elevation, slope, aspect, and
  LANDFIRE 2024 vegetation (tree fraction, canopy %, stand height,
  host-quality score, top vegetation types), **plus the four per-sample
  vegetation types and a tree-class bitmask per cell** (format 2), which is what
  lets host quality be recomputed at load time instead of frozen at bake time —
  a host-rule change no longer needs a re-bake. Also a `provenance` block
  recording the generator and version, the LANDFIRE product year, the terrain
  tile source and when it ran. Produced by `scripts/build-cells.mjs`. **Do not regenerate or
  overwrite unless asked** — the checked-in copy is the real data the user
  produced, and a rebuild moves slope and aspect for ~7,000 cells, which moves
  scores. See "Slope and aspect: why the checked-in values changed".
- **`data/evt-names.json`** — LANDFIRE EVT code → class name, 1,069 entries,
  checked in because the service no longer publishes the mapping anywhere. See
  "LANDFIRE EVT: the mapping is checked in, and why" before touching it.
- **`scripts/fetch-weather.mjs`** — Node script, no dependencies. Maintains
  `data/weather.json` as a **rolling two-grid archive** (see "The two grids").
  Anchors that already have history refetch only their grid's short window,
  new ones fetch `PAST_FULL` *or deeper if the archive already reaches further
  back*, and the fresh window is merged into the stored series by date (fresh
  values overwrite overlapping days, new days append, each anchor trimmed to
  30 past days + its grid's forecast). Requests 10 daily variables because the
  variable count is free at the 1.0-call floor; a probe drops any the API
  rejects *or* returns all-null for (currently both 0–7 cm soil aggregates,
  which only populate under `models=ecmwf_ifs025` — do not pin that model, it
  would change the provenance of precipitation and temperature and move every
  score). Keeps per-request timeout, retry-on-thrown-fetch-error,
  checkpoint/resume, and the >25% failure abort, and adds a daily call ledger
  (see "Call budget").
- **`scripts/build-cells.mjs`** — bakes `data/cells.json`. Node, no
  dependencies. Imports `everHabitat` and `vegSummary` from `src/model/` and the
  lattice from `src/grid.mjs`, so it cannot disagree with the app about either
  the science or the geometry. Reads elevation from the Terrarium terrain tiles
  (with its own PNG decoder — Node has no canvas and this repo has no
  dependencies), samples LANDFIRE EVT/EVC/EVH at four points per cell, and writes
  rows in lattice scan order so the file diffs. Checkpoints before the first
  request, every 5 batches, and again on failure, so a connect timeout costs
  minutes rather than the whole run — re-run with `--resume`.
  `--region=<name>` or `--bbox=lat0,lon0,lat1,lon1` re-bakes part of the state
  and merges into the existing file, sampling one block of apron so an edge
  cell's slope does not depend on which region produced it. A full statewide
  bake is 305 terrain tiles + 579 LANDFIRE requests, about 4 minutes.
- **`scripts/build-cells.test.mjs`** — `node --test scripts/build-cells.test.mjs`.
  No network: the two service calls are injected, so checkpoint/resume is tested
  against synthetic terrain rather than against whether LANDFIRE agrees with
  itself twice. Covers the quarter-point geometry against `vegFor`'s own
  expression, the lattice, the PNG decoder on all five filter types, provenance,
  the regional merge, and that a resumed bake equals an uninterrupted one.
- **`scripts/serve.mjs`** — dependency-free static server for local
  development, `node scripts/serve.mjs [port]`. Exists because the app can no
  longer be opened over `file://`, and because it guarantees the `.mjs` MIME
  type: served as anything but `text/javascript` the browser refuses the module
  with an error that looks nothing like its cause.
- **`scripts/evt-names.test.mjs`** — `node --test scripts/evt-names.test.mjs`.
  Guards the checked-in EVT table: not truncated, the three live-verified codes
  still resolve, every type name `cells.json` uses is producible from it, no
  forested cell is missing a type, and unknown never outranks known-mediocre.
  Imports `hostOf`, `HOST_SPECIES` and `NON_HOST_COVER` from the model rather
  than copying them, so it cannot drift from the tuned constants it checks. It
  also records the four host species LF2024 never names — see
  `src/model/CLAUDE.md`, "What the vegetation data cannot say".
- **`tests/model/`** — regression fixtures for the ecological model, run by `npm test`.
  See "Model regression suite" below before changing anything in there; the two halves
  have opposite rules about when they may be updated. `purity.test.mjs` additionally
  enforces the rules in `src/model/CLAUDE.md` — no DOM, no fetch, no map, no clock,
  no imports outside the directory.
- **`package.json`** — no dependencies and no build step; it exists only to wire up
  `npm test`, `npm run test:model`, `npm run test:data` and `npm run snapshots:update`.
- **`scripts/fetch-weather.test.mjs`** — `node --test scripts/fetch-weather.test.mjs`.
  Covers the merge (a rolling fetch merged into an archive must equal a single
  full fetch, including at the window boundary), trimming, ragged-series
  detection, the stride-nesting property, the anchor join at every stride, the
  per-grid resume windows, and the seam (that bias correction removes the step
  at today rather than smearing it).
- **`.github/workflows/weather.yml`** — one workflow, two crons. `30 11 * * *`
  runs both grids; `30 23 * * *` runs the forecast grid only. The mode comes
  from `github.event.schedule`, so there is one guard, one checkout and one
  commit step instead of two files to keep in sync. Guarded to the production
  repo (see "Both workflows are repository-guarded").
- **`README.md`** — deployment steps and workflow-failure troubleshooting.
## The two grids

Rain and temperature that already fell are worth resolving precisely; an 8-day
forecast is a guess and does not deserve the same spend. So the archive is
fetched as two grids on the same lattice, at different densities and different
cadences:

| grid | stride | spacing | anchors | window | runs |
| --- | --- | --- | --- | --- | --- |
| **past** (dense) | `PAST_STRIDE` 2 | 0.05°, ~3.5 mi | **6,666** | `past_days=3&forecast_days=1` | once daily |
| **forecast** (coarse) | `FORECAST_STRIDE` 8 | 0.2° | **493** | `past_days=1&forecast_days=8` | twice daily |

0.05° is near HRRR's 3 km native resolution, so the dense grid is resolving
real model detail rather than interpolating.

**The dense grid carries every variable, not just precipitation.** Billing is
per location-day up to ten variables, so temperature costs nothing extra there
— and it matters as much as rain: the app's lapse-rate adjustment assumes a
well-mixed atmosphere, and PNW autumn inversions routinely invert its sign. A
resolved past temperature beats a lapse-rate guess.

### Cost, measured

Open-Meteo bills `max(1, days/14 × variables/10)`. Both windows are far under
14 days, so **both floor at 1.0 call per anchor and cost is purely anchor
count**.

| | calls |
| --- | --- |
| dense past, 6,666 anchors × 1 run | 6,666 |
| coarse forecast, 493 anchors × 2 runs | 986 |
| probes, 1 per run | 2 |
| **per day** | **7,654 / 10,000 — 76.5%** |
| **per month** | **229,620 / 300,000 — 76.5%** |

Both caps bind at the same point, because the monthly limit is exactly 30× the
daily — there is no monthly headroom to borrow against a busy day.

For comparison, the previous uniform scheme spent 7,284/day for 0.1°
everywhere. This buys **4× the past-grid density for +5% spend**, by refusing
to pay dense rates for the forecast.

### The coarse set is the *parents of the dense anchors*, not cells snapped to 0.2°

This is not a stylistic choice, and getting it wrong reintroduces the
double-rounding trap that cost 5,844 cells during the stride migration.

Snapping cells straight to 0.2° yields **498** anchors, of which **74 are not
positions any dense anchor rounds to** — and **10 dense anchors** would then
have no coarse anchor to take a forecast from. Defining the coarse set as
`{ coarseParent(d) : d ∈ dense }` yields **493** and cannot orphan anything,
because `coarseParent` is idempotent. The app performs the identical two-step
(cell → dense anchor → coarse parent), so the two sides cannot disagree.

A unit test asserts this against the real `data/cells.json`, including that
direct snapping still produces orphans — if that stops being true the trap has
moved, and the test needs rewriting rather than deleting.

### Membership decides which grid an anchor belongs to — never stride arithmetic

A stored anchor is usable in a grid **iff its exact coordinate is one of that
grid's wanted anchors**. It is tempting to decide by stride divisibility
instead (`stored.stride % grid.stride === 0`), and that is wrong: a stride-4
archive contains 464 anchors that sit exactly on stride-8 positions and are
perfectly good coarse anchors. The divisibility test rejects all of them
(`4 % 8 !== 0`), refetches each as new at 1.943 calls instead of rolling at
1.0, and throws away their history for nothing.

This shipped as a bug and was caught by the log line `forecast: stride 4 is not
a multiple of 8 — starting empty` on the first real run. 437 wasted calls.
Filter by `wantAnchors[grid].has(anchorKey(...))` and nothing else.

## Cell → anchor join (read this before touching weather lookup)

Cells are one square mile; weather is fetched for much sparser **anchors**.
Every cell has to find its anchor, and that join is the single most
breakage-prone seam in the app: get it wrong and the map renders nothing while
every individual tap still returns correct data, which makes it look like a
rendering bug rather than a lookup bug.

**Rule: all cell → anchor resolution goes through `anchorHit(lat, lon)` in
`index.html`. Never derive anchor coordinates independently.** It returns
`{k, a, w}` — the cache key, the anchor coordinate, and the weather object or
`null`. If you find yourself rounding a coordinate to a grid in order to look
up weather, you are creating another consumer that will drift out of sync.

**The two grids do not reach this far.** `ingestWeather()` splices them into
one series per dense anchor before anything else runs, so from `anchorHit`
down there is still exactly one weather series per anchor, one `time` axis, one
`today` index — every downstream consumer is unchanged. That is deliberate:
this join has broken twice, and the fix for a cost problem should not also be a
rewrite of the most fragile code in the app.

`anchorHit` snaps to the finest stride in the file and **falls back through the
coarser strides** (2 → 4 → 8). The fallback is load-bearing, not decoration:
the dense grid backfills across more than one scheduled run, so until it
completes a cell's 0.05° anchor may not exist yet while its 0.1° or 0.2°
ancestor does. Because the strides nest, every coarser snap of the same point
is a real anchor position, so an incomplete backfill **degrades resolution
instead of blanking the overlay**. It also subsumes the old legacy-key
fallback, which is now deleted: a single-grid archive sets both strides to its
one value and the loop runs exactly once.

### Every consumer of the join

| Where | What it does |
| --- | --- |
| `loadFromStatic()` — `need` / `totalA` | decides which anchors are missing; feeds the 20% coverage guard |
| `loadFromStatic()` — per-row | attaches weather to each baked cell |
| `pointEntry()` | exact-point forecast (the tap-through path) |
| `showTop()` — rising debug log | reads the anchor series for the top 3 rising spots |
| **`buildCells()`** | **sub-mile refine grid — the one missed during the lattice migration** |

`buildCells()` is the trap. It reads as live-mode-only code because it calls
`getWeather()`, so it was skipped when the other four were converted to the
lattice. But in `PUBLIC_MODE` it does not fetch — it *reads `wcache`*, which
makes it a full consumer of the join. When it still derived half-step keys via
`snapAnchor(lat, lon, 0.2)` against a lattice `weather.json`, every fine entry
came back `failed`, `drawOverlay` suppressed the baked cells inside
`fineBounds` and drew nothing in their place, and zooming past the refine
threshold punched a blank hole in the map. Tapping still worked because the
tap handler rejects failed fine entries and falls through to `pointEntry()`,
which was already on the lattice.

It now resolves weather through `anchorHit()` and only calls `getWeather()`
for points that cannot resolve from the cache — an empty set in `PUBLIC_MODE`
with a complete archive, so no request is attempted at all. A refine that
fails is scoped to itself: it rolls back any `apiBlocked` raised underneath
(a sub-mile nicety must not put the whole app into the "weather unavailable"
state or disable the elevation-API fallback) and refuses to install
`fineBounds` unless at least one fine cell actually resolved, so a coverage
gap can never blank the overlay again.

### The script must agree with the app

`anchorFor()` in `scripts/fetch-weather.mjs` and `snapLattice()` in
`index.html` have to derive the *identical* anchor from the same coordinate at
every stride, or the join misses. Both round straight to the nearest multiple
of `LATTICE × stride`. Do not reintroduce rounding via the lattice index and
then to the stride: that double rounding disagreed for 5,844 of 48,032 cells
and put 7 requested anchors outside the file. A unit test sweeps the whole
state at strides 2, 4 and 8 and asserts the two expressions match at every
point — if you change either side, that test is what catches you.

## The seam: splicing the grids without a step

The dense grid ends at today. The coarse grid carries today+1 through today+7.
Joining them raw **steps every variable at today**, because a dense anchor and
its 0.2° parent are not the same place — different elevation, different
exposure, so they disagree systematically. `analyze()` reads a step in rain as
a real event and a step in temperature as a real cooling trend, both of which
feed the flush model directly. The seam is therefore not cosmetic.

**Bias-correct; do not blend.** Blending would smear away the dense detail the
past grid exists to provide and would still leave a step, just a wider one.
Instead, measure how the two grids disagree over the days they *both* cover,
then carry that offset across the forecast, tapering to zero as the measured
offset stops meaning anything.

- **Temperature is additive** — `dense − coarse`, an elevation/inversion offset
  in °C, measured separately for `tmax` and `tmin`.
- **Precipitation is multiplicative** — `dense ÷ coarse` over the window, an
  orographic factor.
- **Taper**: full strength on the first forecast day, zero after
  `BIAS_TAPER` = 4 days (`w(k) = max(0, 1 − (k−1)/4)`).
- **Window**: the most recent `BIAS_WINDOW` = 7 days both grids cover.

The overlap exists because **the coarse grid accumulates history too**. It
fetches `past_days=1` but runs twice daily and merges, so after a couple of
weeks it holds the same 30-day depth as the dense grid. On a cold archive the
overlap is short, which is exactly when the guards matter:

- fewer than 3 overlap days → no correction at all (0 and ×1);
- coarse rain under 2 mm across the window → no rain ratio (a tenth of a
  millimetre in a dry fortnight otherwise produces a wild multiplier);
- offsets clamped to ±6 °C and ×0.4–×2.5.

The spliced series belongs to the **dense** anchor, elevation included, so
`adjustWeather()`'s lapse-rate correction downstream is unchanged and now works
from a much nearer anchor for past days. That is the whole point of the dense
grid.

`measureBias()` and `biasWeight()` are exported from the fetch script so the
tests exercise one implementation; `index.html` carries the matching constants
and reads `bias.taper_days` / `bias.window_days` from the archive.

## Call budget

Steady state is 7,654/day against a 10,000 cap, but the one-off stride-2
backfill is **~7,700 calls on top of that** — more than a day's headroom. It
must spread across runs rather than fail.

- `DAILY_CALL_CEILING` (default 9,500) is a ledger, not a limit on one run.
  It lives in `data/weather.json` and resets when the archive's timezone day
  rolls over.
- **The ledger is keyed by execution environment**, as
  `budgets: {"<key>": {day, spent}}`. Open-Meteo's free tier is rate-limited by
  IP, so a GitHub runner and a laptop draw on entirely separate quotas, and one
  shared counter meant they corrupted each other: a local rebuild that spent
  1,601 calls left the next scheduled run believing it had 7,899 of its ceiling
  left, on an IP that had spent nothing. `envKey()` returns
  `ci:<owner/repo>` under `GITHUB_ACTIONS`, otherwise `local`;
  `WEATHER_BUDGET_KEY` overrides it if two machines ever need telling apart.
  A run rewrites only its own slot and carries every other slot through
  untouched.
- **It stays inside the committed artifact on purpose.** GitHub runners are
  ephemeral, so the archive is the only state two scheduled runs share. A
  gitignored sidecar would be tidier locally and useless in CI, which is where
  the ledger actually does its job.
- **A legacy single-object `budget` is discarded, not adopted.** It records no
  environment, so attributing it to whichever run reads it next would
  reintroduce the same contamination. Discarding can only make a run spend less
  than its cap allows, never more, and the discard is logged rather than silent.
- **Known conservatism, deliberately left alone:** GitHub-hosted runners get a
  fresh IP per job, so two CI runs are not really sharing a quota either.
  Carrying the count between them errs toward underspending, and the whole
  budget model above is written around one shared daily figure. Do not "fix"
  that without re-costing the schedule.
- A run that would cross the ceiling **stops cleanly**, writes its checkpoint
  and exits 0. The next run resumes from where it stopped — that is what the
  per-grid `u` stamps are for.
- **Priority within a run**: coarse forecast, then dense rolling, then dense
  backfill. The forecast is what the user actually looks at and costs 493
  calls; it is never starved.
- `FORECAST_RESERVE` (default: the coarse anchor count + 1) is withheld from
  the **backfill phase only**, so a long backfill cannot eat the budget the next
  forecast run needs.
- `HOURLY_CALL_CEILING` (default 5,000) paces batches against a sliding
  one-hour window. Without it a 6,666-anchor dense run fires every batch inside
  ~20 minutes. If Open-Meteo's hourly limit turns out to be higher, the only
  cost of this guard is a slower run.

Measured: from the stride-4 archive, the backfill converges in **two days**,
not weeks — 1,683 dense anchors and 464 coarse ones come from the existing
file with their history intact, and a new dense anchor costs 1.543 (27 days),
not 1.943, because the dense grid only asks for one forecast day.

### The per-grid resume guard

Each anchor stores `u`, the time **its grid** last refreshed it. A run skips
anchors refreshed inside that grid's freshness window, so a run that dies
partway can be re-run immediately without paying again for what it got.

The window is `FRESH_FRACTION` (0.8) of **that grid's own cadence** — 19.2h for
the dense grid on 24h, 9.6h for the coarse grid on 12h. It used to be one
global 5h constant tuned for four uniform 6-hourly runs, and with two cadences
a single constant cannot serve both: 12h after a run that touched both grids,
the forecast grid is due again and the dense grid is not. One number would
either skip a whole scheduled forecast run or fail to protect a resumed dense
one. Tests assert, per grid, that an immediate re-run always skips and a
scheduled run never does.

**An off-cycle manual build still shifts a grid's phase**, and the dense grid's
19.2h window makes that a longer trap than the old 5h one: a local rebuild at
19:00 will make the next morning's scheduled run skip everything and report "no
change". Not a failure, and self-correcting on the following run — but set
`FORCE_REFRESH=1` when you actually mean to rebuild now.

#### Freshness alone is not enough to skip — it fed the ragged check

The guard used to ask only "was this refreshed recently?". That quietly assumes
recently-refreshed means up to date, which holds inside a timezone day and
**breaks across one**: an anchor fetched at 22:00 Pacific is 11h old at 09:00
next morning — well inside 19.2h — and is a whole day behind.

An off-cycle dispatch put the schedule into exactly that state and the two
mechanisms fed each other:

1. 4,983 anchors were fresh-but-a-day-behind, so the guard skipped them and they
   never got the new day.
2. 1,683 genuinely stale anchors *were* rolled, and pulled the shared axis
   forward to the new day.
3. The ragged check then found those 4,983 short of the axis and refetched every
   one **in full**, at 1.6 calls instead of the 1.0 a rolling fetch costs.

~7,973 calls of full refetch on top of the roll; ceiling hit; the run stopped at
4,250/4,983. Reproduced at that scale: **9,656 calls versus 6,666**. Measured
live on a 115-anchor subset: 150.2 calls before, 116.0 after, with the
`57 anchors diverge from the shared time axis` line gone entirely.

**The fix is in the guard, not the ragged check.** The ragged check was right —
those anchors had a real hole. Relaxing it to tolerate a short lag would
serialise a null tail, and `analyze()` reads a null `tmax` through `at()`'s
`?? 0` as **0 °C and fires the frost kill switch**, turning a billing bug into
thousands of cells falsely reporting the season over. Truncating the axis to the
earliest last-date instead would throw today away for every anchor that has it.

`canSkip(entry, endDate, freshCut, force)` now requires **both** conditions: the
anchor is fresh **and** it already carries `endDate`, the last day that grid is
fetching toward (`today` for the dense grid at `forecast_days=1`, `today+7` for
the coarse grid at `forecast_days=8`).

**The target must be that fixed date, never the store's current axis.** The axis
end is *created* by this run's fetches, so testing against it is circular:
before fetching, nothing has today, everything looks covered, every fresh anchor
is skipped, the stale ones then pull the axis forward, and the bug reproduces
exactly. This was the first implementation and it did not work.

The invariant this buys is stronger than what came before: **a run either brings
every anchor up to today, or changes nothing.** There is no longer a state where
some anchors advance and the rest are left behind to go ragged. It also means an
off-cycle run on a *new* day now rolls the whole grid rather than doing nothing —
that is the archive advancing a day, which is the job, not waste.

Note the asymmetry this leaves in `axisFor()`, and leave it alone: the axis
**start** is the latest first-date (so one deep anchor cannot drag it back past
what the rest can fill), while the **end** is still a union. Making the end
shrink to the laggard would discard today for everyone; keeping nothing behind
the end is the guard's job now.

Six `guard:` tests cover this, including a replay of the incident at its real
scale. Reverting `canSkip` to freshness-only fails three of them.

### Halving a stride again

`PAST_STRIDE 2` is the floor under the free tier. **A further halving to 1
(~26,000 anchors) does not fit** — that is 26,000 calls/day against a 10,000
cap. Densifying further has to be selective (a denser lattice only over the
regions that actually score, rather than statewide) or it needs a paid tier.
Do not assume the next halving works because this one did.

Halving *is* safe from a data standpoint: strides nest, so every existing
anchor keeps its position and its history, and only genuinely new lattice
points backfill. That property holds only while the lattice origin stays 0 and
each new stride divides the previous one — halve, never rescale.

### Two bugs the last densification hit, both of which will recur if the reasoning is lost

Both come from the same root: **a newly added anchor cannot reach as far back as
the archive already goes.** New anchors fetch `past_days`; the archive had been
rolling forward for days and was 27 days deep. That mismatch broke two things.

**1. Every new anchor was judged "ragged" and refetched for nothing.** The
shared time axis was the *union* of all dates any anchor had. The old anchors
contributed a day the new ones could not reach, so all 1,356 new anchors were
missing it, were flagged as diverging from the axis, and were refetched in full
— **5,270 calls instead of 2,636** — after which they still could not reach that
day and were null-padded anyway.

Fixes, both needed:
- New anchors now fetch deep enough to match their grid's earliest day
  (`pastForNew`, capped at Open-Meteo's 92), so no depth is lost.
- The shared axis now starts at the **latest first-date across that grid's
  anchors**, not the earliest. Taking the union means one deep anchor drags the
  axis back past what the rest can fill; taking the latest-first-date costs at
  most a day or two of depth and keeps every series dense. The ragged check
  then only fires for genuine holes *inside* an anchor's own coverage, which is
  what it was for.

**2. Null padding is sticky.** Once a padded file is written, reloading it makes
every anchor look like it *has* that date — the key exists, the values are
null — so the axis stayed anchored to a day nobody could fill and the padding
survived every subsequent run. The loader now drops any date whose every field
is null when reading an archive: padding is not coverage.

If you change a stride again and see `N anchors diverge from the shared time
axis` followed by `still short after refetch — padded with nulls`, this is what
came back.
## Staging site

`dev` is mirrored to **https://dev.wheretoforage.com** (repo `misherr/wheretoforage-dev`,
remote `preview`). Deploying is one plain push, no force and no follow-up:

```bash
git push preview dev:dev
```

### Why it deploys through Actions

Production and staging need *different* values in the same `CNAME` path
(`wheretoforage.com` vs `dev.wheretoforage.com`). With branch-based publishing
GitHub writes that file into the publishing branch itself, which put a commit on
`preview/dev` that `dev` did not have. Every later deploy then needed
`--force` plus re-asserting the domain, and the branch could never be merged
back toward `main` without pointing production's domain at the staging host.

So staging publishes via `.github/workflows/staging-pages.yml`, which writes
`CNAME` into the *artifact* at build time. The branch stays byte-identical to
`dev`, no CNAME with the wrong value exists in any branch, and `preview` is an
ordinary fast-forward remote.

That workflow lives in the shared tree and will travel to `main` on a merge, so
its job is guarded by `if: github.repository == 'misherr/wheretoforage-dev'`.
**Do not remove that guard** — it is the only thing stopping the production repo
from deploying itself with the staging domain. Production stays on branch-based
Pages (`build_type: legacy`, `main:/`) with its own committed `CNAME`.

### Both workflows are repository-guarded, in opposite directions

The staging repo is a *full copy* of this tree, so every workflow in
`.github/workflows/` exists on both sides and each one needs to know where it
belongs:

| workflow | runs only on | why |
| --- | --- | --- |
| `weather.yml` | `misherr/wheretoforage` | staging running it too doubles the Open-Meteo spend |
| `staging-pages.yml` | `misherr/wheretoforage-dev` | production deploying it would take its own domain over |

`weather.yml` was unguarded at first and the staging mirror duly ran the
schedule — 465 calls, and it committed the result to its own `dev`, which put a
commit on `preview/dev` that `dev` did not have and broke the fast-forward push.
Any workflow added here needs a guard on one side or the other.

### Where staging gets weather

Staging has no weather job — a second schedule would double the Open-Meteo
spend — so it borrows production's archive over CORS (GitHub Pages serves
`data/weather.json` with `Access-Control-Allow-Origin: *`). Precedence in
`loadWeatherFile()`:

1. **Local, when its grid layout differs from production's.** A dev archive on
   a different layout *is* the thing being staged, so it wins. The comparison
   is a signature over the whole layout, not one stride:
   `2:<LATTICE>/<past.stride>/<forecast.stride>` for a two-grid file,
   `1:<LATTICE>/<STRIDE>` for a single-grid one. A format change counts as a
   difference for exactly the same reason a stride change does. Once production
   catches up the signatures match and this reverts on its own.
2. **Production** otherwise — it is refreshed on schedule, dev's committed copy
   is whatever was last merged and is usually stale.
3. **Local** as the fallback if production is unreachable.

The host guard checks `PROD_HOSTS` first, so adding a subdomain to
`STAGING_HOSTS` can never switch production onto a borrowed file. `localhost`
matches neither and keeps using its own local file.

**The app reads both archive formats**, and has to: while this is staged,
production is still writing single-grid files and staging borrows them. A
single-grid file goes through `ingestOneGrid()` unchanged, with `WBASE` and
`WCOARSE` both set to its one stride so `anchorHit`'s fallback loop runs once.
Deleting that path is only safe once production is on the two-grid format
*and* no borrowed single-grid file can reach a viewer.
## LANDFIRE EVT: the mapping is checked in, and why

`getSamples` returns a **numeric EVT code** and nothing else. Every vegetation
name in the model — and therefore every host-quality score — comes from mapping
that code to a class name.

That mapping used to arrive at runtime from the service's legend, where each
item carried `values:["7039"]`. **It doesn't any more.** The legend now repeats
the class name in that field instead:

```
values: ["North Pacific Maritime Mesic-Wet Douglas-fir-Western Hemlock Forest"]
```

`parseInt` is `NaN` on all 831 entries, so the map came out empty, the
`if(m.size>50)` gate failed, and `evtNames` stayed `null`. The service also
reports `hasRasterAttributeTable:false` and its `rasterAttributeTable` endpoint
returns `{}`, so there is **no live source for the mapping at all**.

So `data/evt-names.json` (1,069 codes, 57 KB) is checked in, built from
LANDFIRE's published EVT CSV. **Do not reconstruct codes from legend order
instead** — the ordering is undocumented, and this service has already changed
the shape of that response once.

### How that one-line failure cost a whole bake

`vegFor()` gates sampling on `evtNames`:

```js
evtNames ? sampleLayer('evt',pts) : Promise.resolve(pts.map(()=>null))
```

With `evtNames` null, EVT was never *requested*. `sampleLayer('evt')` was
healthy the whole time — this is the opposite of the accepted-but-null trap.
48,032 cells were baked with `host:-1` and no types, `names[]` in `cells.json`
came out empty, and nothing failed loudly. Three things had to line up to hide
it, and all three are now fixed:

1. **The gate turned a name lookup into a data outage.** A missing legend should
   cost you type *names*, not the type sampling itself.
2. **A missing host scored as perfect** — see below.
3. **Nothing said so.** Both `vegNote` branches wrote the same string, the tap
   sheet silently dropped the host clause and the Types row, and in
   `PUBLIC_MODE` `loadFromStatic()` returns before `loadEvtNames()` is ever
   reached, so `vegNote` was permanently `''` in the deployed app.

### The legend is still consulted — as an override only

`loadEvtNames()` loads the static table first, then tries the legend and
**merges on top** if it ever returns numeric codes again. That second fetch is
wrapped so that neither a throw nor an empty parse can clear `evtNames`. A test
proves it: with the legend fetch rejecting outright, the table still holds 1,069
entries and sampling still runs.

### Validating a replacement table

If the table is ever rebuilt, verify before trusting it — the codes are not
guaranteed stable across LANDFIRE releases:

- **Three known codes**, sampled live from `LF2024_EVT_CONUS` at Washington
  points: `7036` → North Pacific Seasonal Sitka Spruce Forest (outer coast),
  `7039` → North Pacific Maritime Mesic-Wet Douglas-fir-Western Hemlock Forest
  (west Cascades), `9826` → Southern Vancouverian Lowland Ruderal Grassland.
  Geographic plausibility is the point: a shifted table puts Gulf Coast types in
  the Cascades.
- **Legend coverage**: 829 of the service's 831 legend labels appear in the
  checked-in table. The two that don't are a Texas and a Great Plains type,
  neither of which occurs in Washington.
- **A statewide sample**: 501 cells spread across the state, every code mapped,
  and every resulting name also present in the service's own legend.

`node --test scripts/evt-names.test.mjs` pins the three codes, checks the table
is not truncated, checks every name `cells.json` references is producible from
it, and asserts no forested cell is missing a type.

## Slope and aspect: why the checked-in values changed

`scripts/build-cells.mjs` was built to reproduce the checked-in `data/cells.json`
exactly, as the proof that it is a faithful replacement for the button rather than
a second, subtly different generator. Measured over all 48,032 cells:

| field | matches the checked-in file |
| --- | --- |
| the cell set itself | 48,032 / 48,032, none gained, none lost |
| `elev` | 48,032 / 48,032 |
| `treeFrac`, `canopy`, `height`, `host`, `top` | 48,032 / 48,032 each |
| `slope` | 41,186 / 48,032 — **6,846 differ** |
| `aspect` | 41,793 / 48,032 — **6,239 differ** |

Elevation being identical is what makes the cause provable: the inputs to
`terrainAt()` are the same, so the difference is entirely in **which neighbours
were available when it ran**.

The app fetched elevation per weather-anchor group, in an order driven by habitat
priority and by the map viewport, then computed slope and aspect immediately. A
cell whose neighbour belonged to a group that had not been reached yet fell back
to a one-sided gradient. Two measurements confirm it:

- Cells whose four-neighbourhood crosses a 0.2° anchor-group boundary differ at
  **28.1%**; interior cells at **8.3%**.
- **6,675 of the 7,092** differing cells are reproduced exactly by recomputing
  the gradient with some subset of neighbours withheld. The remaining 417 are the
  same effect where the withheld neighbour is a gated-out cell whose elevation is
  not in the file, so it cannot be reconstructed from the file alone.

The script's values are the correct ones — it samples every cell of every retained
block before computing any terrain, so the answer does not depend on visit order —
and the old values were an artifact of a viewport. **They were adopted with the
user's sign-off**, as a correction rather than a tuning choice. Do not "fix" this
by making the script reproduce the artifact.

### The `pointKey` truncation, fixed at the same time

While reproducing the file, a second and independent defect turned up.
`cellCenter()` returns a 5-decimal coordinate, but the elevation cache is keyed by
`pointKey`, which truncates to 4 — and `lat + DLAT` lands a hair *below* the
neighbour's own 5-decimal value often enough that the two round to different
strings. **77 of every 300 cells in latitude** (0 in longitude) therefore take a
one-sided north-south gradient even though the neighbour's elevation is sitting in
the cache.

At five decimals the neighbour lookup hits 300 of 300 and distinct cells still
never collide. It was fixed in the same re-bake, and its effect measured
separately because it is much the larger of the two terrain changes:

| change | cells whose slope or aspect moved |
| --- | --- |
| order-independent terrain (browser → script) | 7,092 |
| `pointKey` 4 dp → 5 dp | **23,396** |

Elevation is identical across all three bakes (48,032 of 48,032), which is what
makes both attributions clean: the inputs to `terrainAt()` never changed, only
which neighbours it could see.

## Re-baking cells.json for vegetation only

`data/cells.json` is normally not to be regenerated. Filling in EVT is the
exception, and it is **surgical**: elevation, slope and aspect are carried over
from the existing file untouched (they never depended on EVT), and only the `vg`
block is recomputed.

The bake resamples all three LANDFIRE layers, not just EVT, because
`vegSummary()` averages canopy and height over the samples it judges to be tree,
and takes the host average over samples where `isTree` — an EVC property. The
baked aggregates alone cannot reproduce that.

Resampling EVC/EVH also buys the only real check on the sample geometry: the
recomputed `treeFrac`/`canopy`/`height` must reproduce the baked values exactly.
They did, for **all 48,032 cells, zero differences** — which is what proves the
script's quarter-point geometry (`±DLAT/4`, `±DLON/4`, in the app's order)
matches `vegFor()`. If that check ever shows differences, the geometry is wrong
and the host scores built on it are wrong too; do not ship the result.

The full run is ~193 batches of 250 cells (1,000 sample points per request per
layer) and takes about **70 seconds**.

## Host quality: absent data is penalised, and land cover caps

`vegMult()` once multiplied by **1.0** when `v.host` was null. Combined with a
broken EVT lookup that meant every one of 39,981 forested cells was scored as
though its host trees were ideal — a logged Douglas-fir plantation ranked
identically to a Sitka spruce stand, and the entire species discrimination was
inert while still producing confident numbers. It shipped, survived days of
people looking at the map, and was caught by a wasted field trip.

`HOST_NO_INFO = 0.3` is the penalty now, and it is **one constant for two
situations**: LANDFIRE said nothing, and LANDFIRE said something we have no rule
for. Those used to be 0.4 and 0.3 respectively, which had drifted into the wrong
order — knowing nothing outranked knowing something uninterpretable. One
constant cannot drift. It sits below dry pine (0.4) and Douglas-fir (0.45):
absent information must never outrank known-mediocre.

Two field negatives in September 2026 — both in stands typed
`North Pacific Mesic Western Hemlock-Silver Fir Forest`, both actually western
hemlock and western redcedar on the ground — exposed a second and larger family
of errors, fixed together in the same commit. See `src/model/CLAUDE.md`,
"How a vegetation type becomes a host score", for the mechanism. In summary:

- **land cover now caps rather than competing.** `Alpine and Subalpine Bedrock
  and Scree` scored **1.0** — the model's maximum — because `/subalpine/` sat in
  the true-fir rule and won before `/scree/` was reached. So did alpine
  grassland, two subalpine meadows and a deciduous shrubland;
- **a compound type scores the mean of the hosts it names**, not the strongest.
  A hemlock-silver fir mix was indistinguishable from pure silver fir;
- **western red-cedar scores 0**, because *Thuja plicata* is
  arbuscular-mycorrhizal and cannot host boletes at all;
- **every pattern is word-bounded**, because "Northern Rocky Mountain" was
  matching `/rock/` and "Subalpine" was matching `/alpine/` across 63 names.

### What that did to host quality

Over all 39,981 forested cells, recomputed from the same per-sample LANDFIRE
types so nothing but the rules changed:

| host factor | before | after |     | host factor | before | after |
| --- | --- | --- | --- | --- | --- | --- |
| 0.0 | 1,333 | 1,620 | | 0.6 | 3,910 | 5,210 |
| 0.1 | 2,799 | 3,652 | | 0.7 | 3,432 | 3,980 |
| 0.2 | 3,616 | 4,437 | | 0.8 | 7,275 | 6,264 |
| 0.3 | 3,372 | 4,244 | | 0.9 | 2,077 | 1,340 |
| 0.4 | 3,062 | 4,590 | | 1.0 | 5,166 | 561 |
| 0.5 | 3,939 | 4,083 | | | | |

Mean 0.562 → 0.470, median 0.600 → 0.475, p90 1.000 → 0.800. **28,443 cells
fell, none rose**, 11,538 unchanged. Cells sitting at exactly 1.0 went from
4,910 to 324 — that collapse is the fix: the old rule list handed the maximum
host score to anything whose name happened to contain "subalpine".
## Scoring model (hand-tuned — do not refactor or "clean up" without asking)

`score = habitat × trigger rain × soil moisture × temperature window × humidity`,
with kill switches for frost, snow, and heat.

- **Trigger rain** (`analyze()`): looks for the best 3-day rain total of
  at least 0.4" in a window 3–24 days back; flushes are modeled as peaking
  9–15 days after that event.
- **Soil moisture**: a bucket — rain in, 70% of reference evapotranspiration
  out, capped at 80mm.
- **Temperature window**: ideal highs 50–72°F, lows 37–55°F. A cooling trend
  of 3.5°F+ over the prior week adds a bonus. Heat ≥86°F, hard frost ≤27°F
  (or ~30°C max / -3°C min triggers in `analyze()`), and fresh snow
  are kill switches that zero or heavily discount the score.
- **Humidity**: 3-day mean relative humidity; ≥70% ideal, <40% penalized.
- **Host quality** (`NON_HOST_COVER` / `HOST_SPECIES` / `hostOf` /
  `HOST_NO_INFO`): three separate mechanisms, not one ordered list. Land cover
  caps (bare rock, grass, marsh, developed, above treeline → 0; open woodland
  and parkland → 0.3), host species set the value as the **mean of every
  species the type names**, and a generic "conifer forest" fallback scores 0.5.
  Western red-cedar is 0 — it is arbuscular-mycorrhizal and cannot host boletes.
  **A missing *or* unrecognised type scores `HOST_NO_INFO` = 0.3**, below dry
  pine (0.4) and Douglas-fir (0.45), because absent information must never
  outrank known-mediocre. See "Host quality: absent data is penalised, and land
  cover caps".
- **Stand structure** (`structureFactor`): one joint function of canopy cover
  and stand height, replacing an `fCanopy × fHeight` product whose overlapping
  flat tops put 76.7% of forested cells on a plateau at 1.0. Nothing under 5 m;
  the height reward climbs to 33 m (the EVH p99 — the data cannot express real
  old growth, see `src/model/CLAUDE.md`); moderate cover beats dense or sparse,
  and the preferred cover falls and broadens as stands get taller.
- **Habitat** (`function habitat`): four regions, each with
  its own season window and an elevation band that drifts downslope through
  fall:
  - Coastal Sitka spruce
  - West Cascades / Olympic montane forest
  - East Cascades / Okanogan / Selkirks / Blue Mountains (includes the spring
    king, *B. rex-veris*, following snowmelt upslope in May–June)
  - Puget / Chehalis lowland (weighted low — Douglas-fir is a weak host;
    planted spruce/pine/fir do better)
- **Per-cell weather adjustment** (`adjustWeather`-style
  logic): each cell's weather is derived from its nearest anchor by lapse
  rate (6.5°C/km) and by aspect (north-facing slopes ~1°C cooler, ~18% less
  evapotranspiration than the anchor).

Any change to the scoring constants, thresholds, or habitat region
definitions needs explicit sign-off from the user first — this model was
tuned by hand against field experience, not derived from a spec.

## Deployment flow

1. Bake `data/cells.json` with `node scripts/build-cells.mjs` when the habitat
   gate or the vegetation rules change. There is no longer an export button in
   the app, and `PUBLIC_MODE=false` is for local development only.
2. Commit `data/cells.json`, `index.html`, `scripts/`, `.github/` — push.
3. Run the "Update weather" GitHub Action once manually with
   **grids = `past,forecast`** to seed `data/weather.json`; after that the two
   crons run it themselves. Expect the first few days to report anchors still
   to backfill — that is the call ceiling doing its job, not a failure.
4. Set `PUBLIC_MODE=true`, push, serve via GitHub Pages.

See [README.md](README.md) for full troubleshooting notes (missing
cells.json, connect timeouts, workflow permissions).

## Local development

No build step, but **a server is now mandatory** — it is not just convenient.
`index.html` is a module script that imports `./src/model/*.mjs`, and ES module
imports are fetched, so over `file://` every one of them fails CORS. The symptom
is a blank page with `Access to script ... has been blocked by CORS policy` in
the console, which reads like a network problem rather than like "you opened the
file directly". Node 24 is installed (`C:\Program Files\nodejs`); the `python`
on PATH is the Windows Store stub and does not run.

```bash
node scripts/serve.mjs 8080
```

`npx serve -l 8080` works too. The bundled server is there so a machine with Node
and no network still has one, and because it pins the `.mjs` MIME type — served
as anything else, the browser refuses the module.

Then open http://localhost:8080. `localhost` is neither a production nor a
staging host, so it always reads its own `data/weather.json`.

To run the fetch script without touching the real archive, both paths are
overridable — this is how a grid change is built and validated before it goes
anywhere near `data/`:

```bash
CELLS_FILE=data/cells.json WEATHER_FILE=/tmp/scratch-weather.json node scripts/fetch-weather.mjs
```

Useful environment variables, all optional:

| var | default | what it does |
| --- | --- | --- |
| `GRIDS` | `past,forecast` | which grids this run fetches |
| `DAILY_CALL_CEILING` | `9500` | stop cleanly at this many calls for the day |
| `FORECAST_RESERVE` | coarse anchors + 1 | held back from the backfill phase |
| `HOURLY_CALL_CEILING` | `5000` | sliding-window pace limit |
| `CHECKPOINT_EVERY` | `5` | batches between checkpoint writes |
| `WEATHER_BUDGET_KEY` | `ci:<repo>` or `local` | which ledger slot this run spends from |
| `FRESH_FRACTION` | `0.8` | fraction of each grid's cadence that counts as fresh |
| `FORCE_REFRESH` | unset | `1` ignores the freshness window entirely |

For a cheap end-to-end test against the live API, cut `cells.json` down to a
small region first — 712 cells gives 115 dense and 12 coarse anchors, and a
full two-grid build of that costs about 200 calls.

**Before testing, check `PUBLIC_MODE`**
(near the top of the script) — `false` hits live Open-Meteo/LANDFIRE APIs from the
browser; `true` reads only the baked `data/cells.json` + `data/weather.json`
(same as production).
## Branch workflow

- `main` is production — GitHub Pages deploys from it, and the weather
  workflow (`weather.yml`) commits `data/weather.json` to it on its own every
  6 hours.
- `dev` is where all day-to-day work happens. Commit there; never push to
  `main` directly unless explicitly told to.
- **Landing a change** (once it's confirmed good): rebase `dev` onto `main`
  first, since `main` accumulates automated `weather.json` commits `dev`
  won't have, then fast-forward `main` and push.
  ```bash
  git checkout dev
  git fetch origin
  git rebase origin/main
  git checkout main
  git merge --ff-only origin/main
  git merge dev
  git push origin main
  git checkout dev
  ```
- **After a rebase, the mirrors need a force.** The rebase step above rewrites
  `dev`'s commits, so `origin/dev` and `preview/dev` still point at the old
  hashes and reject the next push. That is inherent to rebasing, *not* a
  regression of the staging deploy fix — ordinary pushes are fast-forwards.
  Realign both with a lease, never a bare `--force`:
  ```bash
  git fetch preview                       # or the lease check fails on stale info
  git push origin  dev --force-with-lease=refs/heads/dev:<old-sha>
  git push preview dev:dev --force-with-lease=refs/heads/dev:<old-sha>
  ```
  The lease is what caught a real surprise: `preview/dev` had moved under us
  because the staging repo was running its own weather job. Had that been a bare
  `--force`, the commit would have vanished silently and the duplicated spend
  would still be running.
- **Merging `dev` into `main` will conflict on `data/weather.json`** whenever a
  scheduled run has landed, which is often. It is a generated artifact — resolve
  by taking whichever side you mean to ship (`git checkout <sha> -- data/weather.json`),
  never by hand-merging. If in doubt, take the one with the density you intend;
  the next scheduled run rolls it forward regardless.
- **Rolling back a bad deploy**: revert the last commit on `main` and push —
  Pages redeploys automatically. Bring the same revert into `dev` too so it
  doesn't get reintroduced next merge.
  ```bash
  git checkout main
  git pull
  git revert HEAD
  git push origin main
  git checkout dev
  git rebase main
  ```

## Model regression suite (`tests/model/`)

`npm test` runs everything. `npm run test:model` runs just this.

The ecological model had no independent tests until a bug made LANDFIRE host
quality inert statewide: all 39,981 forested cells scored as though their host
trees were ideal, so a logged Douglas-fir plantation ranked identically to a
Sitka spruce stand. It shipped, survived days of people looking at the map, and
was caught by a wasted field trip. Looking at a map cannot tell you that a
multiplier silently became 1.0 everywhere.

### The two halves, and the difference between them

| | |
| --- | --- |
| `relational.test.mjs` | Compares fixtures against each other. **Never** relaxed to make a failing model pass. |
| `snapshot.test.mjs` | Records exact numbers. **Deliberately** updated when tuning, via `npm run snapshots:update`. |

Relational assertions survive retuning — "Sitka spruce beats Douglas-fir in
identical weather" stays true whatever the constants do — which is what makes
them worth keeping and what makes relaxing one a real loss. If a relational test
fails, the model broke, or the invariant was wrong and needs arguing about.
Don't quietly weaken it.

Snapshots exist because relational tests are blind to a change that scales every
score by 15% while preserving every ordering. A snapshot failure is a question
("did you mean to move these?"), not a verdict. Update the file, then **read the
diff** — every changed number should be one you intended.

### Fixtures

Every fixture is a synthetic environment (weather series, elevation, slope,
aspect, vegetation), built from one baseline by overriding named fields, so a
compared pair differs in exactly the variable under test. That construction is
load-bearing: "north-facing holds moisture longer" only means something if the
weather and terrain are provably identical otherwise.

### How the model is imported

`tests/model/model.mjs` reads `index.html`, pulls out the model declarations
**by name**, and evaluates them in one sandbox. It does not copy them. Copying
would mean the tests keep passing after the model changes underneath them, which
is the exact failure being guarded against.

Two things that will bite whoever touches that loader:

- **Split on `/\r?\n/`, never `'\n'`.** `index.html` is CRLF in the working
  tree, and `\r` is a *line terminator* in JS regex — so `.` will not match it
  and any `(.+)$` anchor fails on every line. That silently reduced the
  extractor to functions-only, dropping every constant.
- **A trailing `// comment` still ends a declaration.** Without that clause,
  `const DLAT=0.0145, DLON=0.0214, BLK=4; // 1 sq mi cells` reads as
  unterminated and swallows every declaration after it.

Extraction failure is loud: a missing name throws with the list, rather than
producing a model with a hole in it. When the model is extracted into real
modules, delete the loader and import them directly.

### It is verified to catch the bug it was built for

Reintroducing the regression — making `vegMult` ignore `v.host` — fails four
tests, including the one named for it. That check is worth repeating after any
significant change to the suite: a test that cannot fail is not protecting
anything. The host-ladder assertion is strict (`<`, not `<=`) for exactly this
reason; with `<=` an inert model where every host collapses to one number slides
straight through.

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
## Repo

- Production: https://github.com/misherr/wheretoforage → https://wheretoforage.com
- Staging: https://github.com/misherr/wheretoforage-dev → https://dev.wheretoforage.com
