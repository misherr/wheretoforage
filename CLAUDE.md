# King Bolete Forecast — Washington State

A single-file static web app that maps king bolete (*Boletus edulis*) foraging
odds across Washington State, so the user can decide each morning whether
it's worth driving somewhere to forage. Used on iPhone via "Add to Home
Screen."

## Files

- **`index.html`** — the entire app. Leaflet map, canvas-rendered overlay of
  ~23,000 one-square-mile cells, a layers menu (chance / habitat quality /
  trailing 7-day rain / soil moisture, multi-select), a play-through timeline
  for the 7-day forecast, a tap-a-cell breakdown sheet, a "Top spots" panel,
  and a "How it works" info panel.
  - `const PUBLIC_MODE` near the top of the script switches the whole
    app between two modes:
    - `false` — live API mode: fetches Open-Meteo weather and LANDFIRE
      vegetation itself, used for local development and for baking
      `data/cells.json` via the info panel's **Export cells.json** button.
    - `true` — public mode: reads only `data/cells.json` and
      `data/weather.json`, never calls an API from the phone. This is what
      gets deployed (GitHub Pages).
- **`data/cells.json`** — baked per-cell elevation, slope, aspect, and
  LANDFIRE 2024 vegetation (tree fraction, canopy %, stand height,
  host-quality score, top vegetation types). Generated once via the app's own
  export button in live mode. **Do not regenerate or overwrite** — the
  checked-in copy is the real data the user produced.
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
  It lives in `data/weather.json` as `budget: {day, spent, ceiling}` because
  runs are separate processes, and resets when the archive's timezone day rolls
  over.
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

1. Local dev: `PUBLIC_MODE=false`, let a full load complete, export
   `data/cells.json` from the info panel when the model or vegetation data
   changes.
2. Commit `data/cells.json`, `index.html`, `scripts/`, `.github/` — push.
3. Run the "Update weather" GitHub Action once manually with
   **grids = `past,forecast`** to seed `data/weather.json`; after that the two
   crons run it themselves. Expect the first few days to report anchors still
   to backfill — that is the call ceiling doing its job, not a failure.
4. Set `PUBLIC_MODE=true`, push, serve via GitHub Pages.

See [README.md](README.md) for full troubleshooting notes (missing
cells.json, connect timeouts, workflow permissions).

## Local development

No build step — serve the repo root as static files. Node 24 is installed
(`C:\Program Files\nodejs`); the `python` on PATH is the Windows Store stub and
does not run:

```bash
npx serve -l 8080
```

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
