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
  - `const PUBLIC_MODE` near the top (`index.html:170`) switches the whole
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
  history refetch only `past_days=3`, new ones `past_days=26`, both with
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
  `data/weather.json` if it changed. Four scheduled runs/day is roughly
  8,000 of Open-Meteo's 10,000 free daily calls — don't add a fifth without
  reducing per-run weight.
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

Densifying is a one-line change to `STRIDE` in the fetch script. Because
activity is `i % STRIDE === 0`, halving it keeps every existing anchor active,
so the archive is retained and only the *new* lattice points pay a full 26+8
fetch — the load guard accepts any stored stride that is a multiple of the
current one. Cost scales linearly with anchor count, and at 4 runs/day the
ceiling is ~2,500 anchors: the 10,000/day and 300,000/month limits bind at
exactly the same point, since the monthly cap is 30× the daily. **A further
halving to `STRIDE 2` (~7,300 anchors) would not fit** — it would need roughly
29,000 calls/day.

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
file format and deploy order cannot take the site dark. **Remove it once a
lattice-format `weather.json` has been live for a cycle**: delete
`legacyAnchor` and the fallback branch inside `anchorHit()`, keeping the
lattice path.

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

- **Trigger rain** (`index.html:252`): looks for the best 3-day rain total of
  at least 0.4" in a window 3–24 days back; flushes are modeled as peaking
  9–15 days after that event.
- **Soil moisture**: a bucket — rain in, 70% of reference evapotranspiration
  out, capped at 80mm.
- **Temperature window**: ideal highs 50–72°F, lows 37–55°F. A cooling trend
  of 3.5°F+ over the prior week adds a bonus. Heat ≥86°F, hard frost ≤27°F
  (or ~30°F max / -3°F min triggers, see `index.html:265`), and fresh snow
  are kill switches that zero or heavily discount the score.
- **Humidity**: 3-day mean relative humidity; ≥70% ideal, <40% penalized.
- **Habitat** (`index.html:201`, `function habitat`): four regions, each with
  its own season window and an elevation band that drifts downslope through
  fall:
  - Coastal Sitka spruce
  - West Cascades / Olympic montane forest
  - East Cascades / Okanogan / Selkirks / Blue Mountains (includes the spring
    king, *B. rex-veris*, following snowmelt upslope in May–June)
  - Puget / Chehalis lowland (weighted low — Douglas-fir is a weak host;
    planted spruce/pine/fir do better)
- **Per-cell weather adjustment** (`index.html:464`, `adjustWeather`-style
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

No build step — serve the repo root as static files with whatever you have
installed:

```bash
python -m http.server 8080
```

or, with Node:

```bash
npx serve -l 8080
```

Then open http://localhost:8080. **Before testing, check `PUBLIC_MODE`**
(`index.html:170`) — `false` hits live Open-Meteo/LANDFIRE APIs from the
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

## Repo

https://github.com/misherr/wheretoforage
