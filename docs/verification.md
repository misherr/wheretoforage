# Verification that has actually caught bugs
Checks that look like overkill and are not: each one here caught something real.
Followed by the traps worth not rediscovering.

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
