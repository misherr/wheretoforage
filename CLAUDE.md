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
- **`scripts/fetch-weather.mjs`** — Node script, no dependencies. Derives
  ~475 anchor points from `data/cells.json`, fetches Open-Meteo daily weather
  (26 days history + 8 days forecast) for each, writes `data/weather.json`.
  Has per-request timeout, retry-on-thrown-fetch-error (handles
  `UND_ERR_CONNECT_TIMEOUT`), checkpoint/resume (safe to re-run after a
  partial failure), and aborts without overwriting good data if more than
  25% of anchors fail.
- **`.github/workflows/weather.yml`** — runs the fetch script every 6 hours
  (`workflow_dispatch` also enabled for manual runs) and commits
  `data/weather.json` if it changed. Four scheduled runs/day is roughly
  8,000 of Open-Meteo's 10,000 free daily calls — don't add a fifth without
  reducing per-run weight.
- **`README.md`** — deployment steps and workflow-failure troubleshooting.

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

## Repo

https://github.com/misherr/wheretoforage
