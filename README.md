# King bolete Washington — deployment

The app is one file (`index.html`). For public use it reads three static files and never calls an API from the phone: `data/cells.json` (terrain + vegetation per cell), `data/weather.json` (the weather archive) and `data/evt-names.json` (LANDFIRE vegetation code → name, checked in because the USGS service stopped publishing it).

## One-time setup
0. Serve the repo root — **the app cannot be opened as a file any more.** `index.html` imports the model from `src/model/*.mjs`, and ES module imports are fetched, so `file://` fails CORS and the page comes up blank. Use `node scripts/serve.mjs 8080` (no dependencies) or `npx serve -l 8080`, then open http://localhost:8080.
1. Bake the cell file: `node scripts/build-cells.mjs`. About 4 minutes — 305 terrain tiles and 579 LANDFIRE requests — and it writes `data/cells.json` itself. It checkpoints as it goes, so if the network drops, re-run with `--resume` and it picks up where it stopped. Part of the state only: `--region=coast` or `--bbox=lat0,lon0,lat1,lon1`, which merges into the existing file. This used to be a button in the app; it is a script now so it can run in CI and produce a reviewable diff.
2. Check it: `npm test`. `data/cells.json` needs refreshing only when the habitat gate or the vegetation rules change — and note that rebuilding moves slope and aspect for ~7,000 cells, because the old in-browser bake computed some of them from an incomplete neighbourhood. That changes scores, so re-bake deliberately rather than as housekeeping.
3. Copy `scripts/`, `.github/`, `data/` and `index.html` into the repo. Commit and push.
4. GitHub → Actions → **Update weather** → Run workflow, with **grids = `past,forecast`**. It writes `data/weather.json` and commits it. After that it runs itself on two schedules (below). The first few runs will report anchors still to backfill — see "The first few days" .
5. Set `PUBLIC_MODE=true` in `index.html` and push. Enable GitHub Pages on the main branch.

## Two grids, two schedules
Weather is fetched as two grids, because rain and temperature that already fell are worth resolving precisely while an 8-day forecast is a guess:

| grid | spacing | anchors | window | when |
| --- | --- | --- | --- | --- |
| dense past | 0.05° (~3.5 mi) | 6,666 | 3 days back, 1 forward | 4:30 AM Pacific |
| coarse forecast | 0.2° | 493 | 1 day back, 8 forward | 4:30 AM and 4:30 PM Pacific |

Both windows are short enough that Open-Meteo bills them at its 1.0-call floor, so the cost is just the anchor count: **7,654 of the 10,000 free calls a day**, and 229,620 of 300,000 a month. The previous single-grid scheme spent 7,284/day for 0.2°-then-0.1° coverage everywhere, so this is four times the past-grid resolution for about 5% more.

Don't add a third run of the dense grid — 6,666 more calls does not fit.

## The first few days
Going from a single 0.1° grid to a 0.05° one adds about 5,000 new anchors, and backfilling them costs ~7,700 calls on top of normal operation. That does not fit in one day, so the script keeps a ledger in `data/weather.json`, stops cleanly at `DAILY_CALL_CEILING` (9,500), and resumes on the next run. Expect roughly two days to reach full density.

While it fills, the map still covers the whole state: a cell whose 0.05° anchor does not exist yet falls back to its 0.1° or 0.2° ancestor. Coverage never drops — only resolution, and only where the backfill has not reached.

## What each load costs
- Phones: map tiles only (plus terrain tiles if someone zooms past level 12 for the sub-mile grid). Zero Open-Meteo, zero LANDFIRE.
- `data/weather.json` is larger than it was (the dense grid is 6,666 anchors × 31 days), but it is served gzipped and fetched once per load.

If the weather file is more than 36 hours old the status line says so; the app still works from it.

## Tests

```bash
npm test
```

No dependencies. `npm run test:model` covers the ecological model (fixtures in `tests/model/`), `npm run test:data` covers the weather archive and the LANDFIRE lookup. After deliberately tuning the model, run `npm run snapshots:update` and read the diff. See CLAUDE.md for why the relational tests and the snapshots have opposite rules.

## If vegetation types go missing
The status line will say so — "vegetation type missing for N% of forested cells in data/cells.json". Those cells are being scored at a flat 40/100 host quality, which is a deliberate penalty for absent data, not a measurement. The tap sheet says the same thing per cell. Causes, in order of likelihood:

- **`data/evt-names.json` missing or truncated** — the app says which. Run `node --test scripts/evt-names.test.mjs`.
- **`cells.json` was baked while EVT was broken** — re-bake vegetation only; see CLAUDE.md.
- **The LANDFIRE service changed shape again** — it has once before, silently. The checked-in table means this no longer takes vegetation down with it.

## If the weather job fails
- **`data/cells.json` missing** — export it from the app (step 2) and upload it.
- **Connect timeouts / `UND_ERR_CONNECT_TIMEOUT`** — a flaky runner network. The script retries each batch 8 times, checkpoints its progress to `data/weather.json`, and a rerun resumes where it stopped. Just run the workflow again.
- **"budget ceiling reached"** — not a failure. The run stopped at the daily allowance and wrote its checkpoint; the next scheduled run continues. The allowance is tracked per environment (`ci:<owner/repo>` vs `local`), so building an archive on your own machine no longer throttles the runner.
- **"N skipped as refreshed within Xh"** — also not a failure. Each grid skips anchors it refreshed inside its own freshness window (19.2h for the dense grid, 9.6h for the coarse one) so a rerun does not pay twice. If you deliberately want a rebuild now, run the workflow with **force** ticked.
- **Red X on the commit step** — Settings → Actions → General → Workflow permissions → Read and write.
- The job aborts and keeps the previous weather file if more than 25% of a grid's anchors fail, so a bad run never replaces good data with a half-empty file.
