# Local development
Running the app, running the fetch script against a scratch archive, and the
environment variables that control it.

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
