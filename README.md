# King bolete Washington — deployment

The app is one file (`index.html`). For public use it reads three static files and never calls an API from the phone: `data/cells.json` (terrain + vegetation per cell), `data/weather.json` (the weather archive) and `data/evt-names.json` (LANDFIRE vegetation code → name, checked in because the USGS service stopped publishing it).

## One-time setup
1. Run the app locally with `PUBLIC_MODE=false` (top of the script) and wait for a complete load — status line shows no "pending" or "missing" counts.
2. Open the info panel (ⓘ) → **Export cells.json**. Save it as `data/cells.json`. This is the baked elevation, slope/aspect and LANDFIRE vegetation for every square-mile cell; it never needs refreshing unless you change the habitat model.
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

## If vegetation types go missing
The status line will say so — "vegetation type missing for N% of forested cells in data/cells.json". Those cells are being scored at a flat 40/100 host quality, which is a deliberate penalty for absent data, not a measurement. The tap sheet says the same thing per cell. Causes, in order of likelihood:

- **`data/evt-names.json` missing or truncated** — the app says which. Run `node --test scripts/evt-names.test.mjs`.
- **`cells.json` was baked while EVT was broken** — re-bake vegetation only; see CLAUDE.md.
- **The LANDFIRE service changed shape again** — it has once before, silently. The checked-in table means this no longer takes vegetation down with it.

## If the weather job fails
- **`data/cells.json` missing** — export it from the app (step 2) and upload it.
- **Connect timeouts / `UND_ERR_CONNECT_TIMEOUT`** — a flaky runner network. The script retries each batch 8 times, checkpoints its progress to `data/weather.json`, and a rerun resumes where it stopped. Just run the workflow again.
- **"budget ceiling reached"** — not a failure. The run stopped at the daily allowance and wrote its checkpoint; the next scheduled run continues.
- **"N skipped as refreshed within Xh"** — also not a failure. Each grid skips anchors it refreshed inside its own freshness window (19.2h for the dense grid, 9.6h for the coarse one) so a rerun does not pay twice. If you deliberately want a rebuild now, run the workflow with **force** ticked.
- **Red X on the commit step** — Settings → Actions → General → Workflow permissions → Read and write.
- The job aborts and keeps the previous weather file if more than 25% of a grid's anchors fail, so a bad run never replaces good data with a half-empty file.
