# King bolete Washington — deployment

The app is one file (`index.html`). For public use it reads two static files and never calls an API from the phone.

## One-time setup
1. Run the app locally with `PUBLIC_MODE=false` (top of the script) and wait for a complete load — status line shows no "pending" or "missing" counts.
2. Open the info panel (ⓘ) → **Export cells.json**. Save it as `data/cells.json`. This is the baked elevation, slope/aspect and LANDFIRE vegetation for every square-mile cell; it never needs refreshing unless you change the habitat model.
3. Copy `scripts/`, `.github/`, `data/` and `index.html` into the repo. Commit and push.
4. GitHub → Actions → **Update weather** → Run workflow. It writes `data/weather.json` and commits it. After that it runs itself four times a day (4:30 AM, 10:30 AM, 4:30 PM, 10:30 PM Pacific).
5. Set `PUBLIC_MODE=true` in `index.html` and push. Enable GitHub Pages on the main branch.

## What each load costs
- Phones: map tiles only (plus terrain tiles if someone zooms past level 12 for the sub-mile grid). Zero Open-Meteo, zero LANDFIRE.
- GitHub job: ~450 weather locations four times a day — about 80% of Open-Meteo's free daily allowance, which is as often as the free tier allows. Don't add a fifth run; if you want fresher forecasts, the cheaper route is a second light job that pulls only `past_days=2` (about a quarter of the weight) and merges the forecast portion.

If the weather file is more than 36 hours old the status line says so; the app still works from it.

## If the weather job fails
- **`data/cells.json` missing** — export it from the app (step 2) and upload it.
- **Connect timeouts / `UND_ERR_CONNECT_TIMEOUT`** — a flaky runner network. The script retries each batch 8 times, checkpoints its progress to `data/weather.json`, and a rerun resumes where it stopped. Just run the workflow again.
- **Red X on the commit step** — Settings -> Actions -> General -> Workflow permissions -> Read and write.
- The job aborts and keeps the previous weather file if more than 25% of anchors fail, so a bad run never replaces good data with a half-empty file.
