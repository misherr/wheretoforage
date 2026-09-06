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
  `data/weather.json` as a **rolling archive**: anchors that already have
  history refetch only `past_days=3`, new ones `past_days=26` *or deeper if the
  archive already reaches further back* (see Densification), both with
  `forecast_days=8`, and the fresh window is merged into the stored series by
  date (fresh values overwrite overlapping days, new days append, each anchor
  trimmed to 30 past days + forecast). Open-Meteo bills
  `max(1, days/14 × variables/10)`, so the short window costs 1.0 per anchor
  instead of 2.43. Requests 10 daily variables because the variable count is
  free at the rolling window; a probe drops any the API rejects *or* returns
  all-null for (currently both 0–7 cm soil aggregates, which only populate
  under `models=ecmwf_ifs025` — do not pin that model, it would change the
  provenance of precipitation and temperature and move every score). Writes
  `LATTICE`, `STRIDE` and `today_index`. Keeps per-request timeout,
  retry-on-thrown-fetch-error, checkpoint/resume, and the >25% failure abort.
- **`scripts/fetch-weather.test.mjs`** — `node --test scripts/fetch-weather.test.mjs`.
  Covers the merge (a rolling fetch merged into an archive must equal a single
  full fetch, including at the window boundary), trimming, ragged-series
  detection, the stride-nesting property, and the anchor join.
- **`.github/workflows/weather.yml`** — runs the fetch script every 6 hours
  (`workflow_dispatch` also enabled for manual runs) and commits
  `data/weather.json` if it changed. At 1,820 anchors a rolling run measures
  **1,821 calls**, so four runs/day is **7,284 of Open-Meteo's 10,000** — don't
  add a fifth, and see Densification before adding anchors. Guarded to the
  production repo (see "Both workflows are repository-guarded").
- **`README.md`** — deployment steps and workflow-failure troubleshooting.

## Cell → anchor join (read this before touching weather lookup)

Cells are one square mile; weather is fetched for a much sparser set of
**anchors**. Every cell has to find its anchor, and that join is the single
most breakage-prone seam in the app: get it wrong and the map renders nothing
while every individual tap still returns correct data, which makes it look
like a rendering bug rather than a lookup bug.

**Rule: all cell → anchor resolution goes through `anchorHit(lat, lon)` in
`index.html`. Never derive anchor coordinates independently.** It returns
`{k, a, w}` — the cache key, the anchor coordinate, and the weather object or
`null`. If you find yourself writing `snapAnchor(...)` or rounding a
coordinate to a grid in order to look up weather, you are creating a sixth
consumer that will drift out of sync.

Anchors sit on a fixed lattice: active points are multiples of
`LATTICE × STRIDE` (currently `0.025 × 4 = 0.1°`, ~1,820 anchors), and a cell
joins to the *nearest* one. `LATTICE` and `STRIDE` are read from `weather.json`
at ingest (falling back to `0.025` / `8`), so halving `STRIDE` to densify needs
no app change.

Densifying is a one-line change to `STRIDE` in the fetch script — but read
**Densification** below before doing it. Twice.

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

`anchorFor()` in `scripts/fetch-weather.mjs` and `anchorHit()` in
`index.html` have to derive the *identical* anchor from the same coordinate,
or the join misses. Both round straight to the nearest multiple of
`LATTICE × STRIDE`. Do not reintroduce rounding via the lattice index and then
to `STRIDE`: that double rounding disagreed for 5,844 of 48,032 cells and put
7 requested anchors outside the file. A unit test sweeps the whole state and
asserts the two expressions match at every point — if you change either side,
that test is what catches you.

### Temporary dual-key fallback — removable

`anchorHit()` tries the lattice key first and falls back to the legacy
`snapAnchor(lat, lon, 0.2)` half-step key, so the app renders against either
file format and deploy order cannot take the site dark.

**This is now provably unused and safe to delete.** Measured on live production
after the lattice archive shipped: all 48,032 cells resolved through the lattice
key, **0 through the fallback**. To remove: delete `legacyAnchor` and the
fallback branch inside `anchorHit()`, keeping the lattice path. Re-verify with
the unresolved-cell count below before and after.

## Densification (changing STRIDE)

Current: `STRIDE 4` → **0.1° spacing, 1,820 anchors**. It was 8 → 0.2° → 498.

### Cost, measured

| | calls |
| --- | --- |
| Rolling run at 1,820 anchors | **1,821** (1,820 × 1.0 + 1 probe) |
| 4 runs/day | **7,284 / 10,000** — 72.8% |
| 4 runs/day × 30 | **218,520 / 300,000** — 72.8% |

The rolling window floors at 1.0 call per anchor (`max(1, 11/14 × 8/10)`), so
**cost is just the anchor count**. Both Open-Meteo caps bind at the same
**~2,500 anchors**, because the monthly limit is exactly 30× the daily — there
is no monthly headroom to borrow against a busy day.

**A further halving to `STRIDE 2` (~7,300 anchors) does not fit**: ~29,000
calls/day against a 10,000 cap. Densifying further has to be selective — a
denser lattice only over the regions that actually score, rather than statewide
— or it needs a paid tier. Do not assume the next halving works because this
one did.

The one-off densification itself costs more than steady state (new points pay a
full `26+8` fetch at 1.943 each), but it is paid once: **promoting a densified
archive that was built locally costs the runner nothing extra**, because every
anchor arrives with history and takes the rolling window.

### Two bugs this hit, both of which will recur if the reasoning is lost

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
- New anchors now fetch deep enough to match the archive's earliest day
  (`pastForNew`, capped at Open-Meteo's 92), so no depth is lost.
- The shared axis now starts at the **latest first-date across anchors**, not
  the earliest. Taking the union means one deep anchor drags the axis back past
  what the rest can fill; taking the latest-first-date costs at most a day or
  two of depth and keeps every series dense. The ragged check then only fires
  for genuine holes *inside* an anchor's own coverage, which is what it was for.

**2. Null padding is sticky.** Once a padded file is written, reloading it makes
every anchor look like it *has* that date — the key exists, the values are
null — so the axis stayed anchored to a day nobody could fill and the padding
survived every subsequent run. The loader now drops any date whose every field
is null when reading an archive: padding is not coverage.

If you change `STRIDE` again and see `N anchors diverge from the shared time
axis` followed by `still short after refetch — padded with nulls`, this is what
came back.

### The 5-hour resume guard

Each anchor stores `u`, the time it was last refreshed. A run skips any anchor
refreshed within 5 hours. That exists so a run that dies partway can be re-run
immediately without refetching what it already got.

**It is tuned for four uniform runs a day** — 6h apart, comfortably outside the
window. An off-cycle manual build breaks that spacing: after a local rebuild at
19:11, the 23:30 scheduled run fell 4.3h later and skipped every anchor,
reporting "no change". Not a failure, and self-correcting on the next run — but
don't read it as one, and don't shorten the schedule below 5h without raising
the guard.

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

1. **Local, when it is on a different lattice than production.** A dev archive
   with a different `LATTICE`/`STRIDE` *is* the thing being staged, so it wins.
   Once production catches up the strides match and this reverts on its own.
2. **Production** otherwise — it is refreshed every 6h, dev's committed copy is
   whatever was last merged and is usually stale.
3. **Local** as the fallback if production is unreachable.

The host guard checks `PROD_HOSTS` first, so adding a subdomain to
`STAGING_HOSTS` can never switch production onto a borrowed file. `localhost`
matches neither and keeps using its own local file.

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
3. Run the "Update weather" GitHub Action once manually to produce the first
   `data/weather.json`; after that it runs itself every 6 hours.
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
overridable — this is how a densification is built and validated before it goes
anywhere near `data/`:

```bash
CELLS_FILE=data/cells.json WEATHER_FILE=/tmp/scratch-weather.json node scripts/fetch-weather.mjs
```

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
  let n=0; for(const r of STATIC.cells.rows){const a=latticeAnchor(r[0],r[1]);
    const e=wcache.get(key(a[0],a[1])); if(!e||!e.w) n++;} n
  ```
- **Prove a request did *not* happen.** Wrap `window.fetch` and count. That is
  how the refine fix was confirmed to make zero Open-Meteo calls in
  `PUBLIC_MODE`, rather than assuming the guard held.
- **Corrupt the archive and watch the merge repair it.** Setting a known-bad
  value inside the rolling window and another outside it proves the window
  boundary exactly: the first is repaired to match a full fetch, the second
  persists. Equality against a fresh full fetch alone would not show that.
- **Cross-check retained history after a densification** against the archive you
  started from — 12,064 values, 0 mismatches — otherwise "it kept the history"
  is an assumption.
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

- **`today_index` beats the viewer's clock.** `ingestWeather()` prefers
  `j.today_index` (written in the archive's own timezone) and only falls back to
  a local-date lookup, then the `past_days` clamp. Don't "simplify" it back to
  `time.indexOf(localISO(new Date()))`.
- **Both 0–7 cm soil variables are accepted by Open-Meteo and return all-null**
  under the default model. Only `models=ecmwf_ifs025` populates them, and
  pinning that would change the provenance of precipitation and temperature and
  move every score. The probe drops them automatically; they will switch on by
  themselves if Open-Meteo starts serving them. This is why we ship 8 usable
  variables, not 10 — and why the rolling saving is 1.94×, not 2.43×.
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
- **A bare `git push --force` to `preview` can destroy someone else's commit** —
  it did nearly hide the staging repo's rogue weather job. Use
  `--force-with-lease`, and `git fetch preview` first or the lease goes stale.

## Repo

- Production: https://github.com/misherr/wheretoforage → https://wheretoforage.com
- Staging: https://github.com/misherr/wheretoforage-dev → https://dev.wheretoforage.com
