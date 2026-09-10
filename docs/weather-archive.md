# The weather archive
How `data/weather.json` is built and paid for: the two grids, the cost model, the
seam between them, the call budget and the resume guard. Nearly all of this is
here because getting it wrong has cost real money or real data.

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
  It lives in `data/weather.json` and resets when the archive's timezone day
  rolls over.
- **The ledger is keyed by execution environment**, as
  `budgets: {"<key>": {day, spent}}`. Open-Meteo's free tier is rate-limited by
  IP, so a GitHub runner and a laptop draw on entirely separate quotas, and one
  shared counter meant they corrupted each other: a local rebuild that spent
  1,601 calls left the next scheduled run believing it had 7,899 of its ceiling
  left, on an IP that had spent nothing. `envKey()` returns
  `ci:<owner/repo>` under `GITHUB_ACTIONS`, otherwise `local`;
  `WEATHER_BUDGET_KEY` overrides it if two machines ever need telling apart.
  A run rewrites only its own slot and carries every other slot through
  untouched.
- **It stays inside the committed artifact on purpose.** GitHub runners are
  ephemeral, so the archive is the only state two scheduled runs share. A
  gitignored sidecar would be tidier locally and useless in CI, which is where
  the ledger actually does its job.
- **A legacy single-object `budget` is discarded, not adopted.** It records no
  environment, so attributing it to whichever run reads it next would
  reintroduce the same contamination. Discarding can only make a run spend less
  than its cap allows, never more, and the discard is logged rather than silent.
- **Known conservatism, deliberately left alone:** GitHub-hosted runners get a
  fresh IP per job, so two CI runs are not really sharing a quota either.
  Carrying the count between them errs toward underspending, and the whole
  budget model above is written around one shared daily figure. Do not "fix"
  that without re-costing the schedule.
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

#### Freshness alone is not enough to skip — it fed the ragged check

The guard used to ask only "was this refreshed recently?". That quietly assumes
recently-refreshed means up to date, which holds inside a timezone day and
**breaks across one**: an anchor fetched at 22:00 Pacific is 11h old at 09:00
next morning — well inside 19.2h — and is a whole day behind.

An off-cycle dispatch put the schedule into exactly that state and the two
mechanisms fed each other:

1. 4,983 anchors were fresh-but-a-day-behind, so the guard skipped them and they
   never got the new day.
2. 1,683 genuinely stale anchors *were* rolled, and pulled the shared axis
   forward to the new day.
3. The ragged check then found those 4,983 short of the axis and refetched every
   one **in full**, at 1.6 calls instead of the 1.0 a rolling fetch costs.

~7,973 calls of full refetch on top of the roll; ceiling hit; the run stopped at
4,250/4,983. Reproduced at that scale: **9,656 calls versus 6,666**. Measured
live on a 115-anchor subset: 150.2 calls before, 116.0 after, with the
`57 anchors diverge from the shared time axis` line gone entirely.

**The fix is in the guard, not the ragged check.** The ragged check was right —
those anchors had a real hole. Relaxing it to tolerate a short lag would
serialise a null tail, and `analyze()` reads a null `tmax` through `at()`'s
`?? 0` as **0 °C and fires the frost kill switch**, turning a billing bug into
thousands of cells falsely reporting the season over. Truncating the axis to the
earliest last-date instead would throw today away for every anchor that has it.

`canSkip(entry, endDate, freshCut, force)` now requires **both** conditions: the
anchor is fresh **and** it already carries `endDate`, the last day that grid is
fetching toward (`today` for the dense grid at `forecast_days=1`, `today+7` for
the coarse grid at `forecast_days=8`).

**The target must be that fixed date, never the store's current axis.** The axis
end is *created* by this run's fetches, so testing against it is circular:
before fetching, nothing has today, everything looks covered, every fresh anchor
is skipped, the stale ones then pull the axis forward, and the bug reproduces
exactly. This was the first implementation and it did not work.

The invariant this buys is stronger than what came before: **a run either brings
every anchor up to today, or changes nothing.** There is no longer a state where
some anchors advance and the rest are left behind to go ragged. It also means an
off-cycle run on a *new* day now rolls the whole grid rather than doing nothing —
that is the archive advancing a day, which is the job, not waste.

Note the asymmetry this leaves in `axisFor()`, and leave it alone: the axis
**start** is the latest first-date (so one deep anchor cannot drag it back past
what the rest can fill), while the **end** is still a union. Making the end
shrink to the laggard would discard today for everyone; keeping nothing behind
the end is the guard's job now.

Six `guard:` tests cover this, including a replay of the incident at its real
scale. Reverting `canSkip` to freshness-only fails three of them.

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
