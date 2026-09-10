# Architecture: what each file is for
Moved out of `CLAUDE.md` so that file can stay short. This is the long form —
every file, what it does, and the reasoning that is not obvious from reading it.

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
- **`src/access.mjs`** — the access vocabulary: what counts as a trail, a
  drivable road or a rough way, the distance thresholds, and the labels. Shared
  by the bake script and the app so the two cannot disagree. Deliberately
  outside `src/model/`: access is not an input to any score. See
  [access.md](access.md).
- **`scripts/build-access.mjs`** — bakes `data/access.json` from OpenStreetMap
  (via Overpass) and USFS roads and trails. Tiled, resumable, and it subdivides
  an area when Overpass cannot answer for it, which is how the metro tiles get
  done. `--region`/`--bbox` merge into the existing file.
- **`scripts/build-access.test.mjs`** — no network. Covers the classification,
  the polyline densification, the tiling, the regional merge, and the assertion
  that matters most: that nothing under `src/model/` can see access at all.
- **`data/access.json`** — per-cell distance to the nearest mapped trail, road
  and rough way, keyed by cell index rather than row position. Optional at
  runtime: without it every cell reads as unknown and the app is otherwise
  unchanged.
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
