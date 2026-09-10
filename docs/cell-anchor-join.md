# Cell → anchor join
The single most breakage-prone seam in the app. It has broken twice, and both
times the symptom was an empty map while every individual tap still worked.

## Cell → anchor join (read this before touching weather lookup)

Cells are one square mile; weather is fetched for much sparser **anchors**.
Every cell has to find its anchor, and that join is the single most
breakage-prone seam in the app: get it wrong and the map renders nothing while
every individual tap still returns correct data, which makes it look like a
rendering bug rather than a lookup bug.

**Rule: all cell → anchor resolution goes through `anchorHit(lat, lon)` in
`index.html`. Never derive anchor coordinates independently.** It returns
`{k, a, w}` — the cache key, the anchor coordinate, and the weather object or
`null`. If you find yourself rounding a coordinate to a grid in order to look
up weather, you are creating another consumer that will drift out of sync.

**The two grids do not reach this far.** `ingestWeather()` splices them into
one series per dense anchor before anything else runs, so from `anchorHit`
down there is still exactly one weather series per anchor, one `time` axis, one
`today` index — every downstream consumer is unchanged. That is deliberate:
this join has broken twice, and the fix for a cost problem should not also be a
rewrite of the most fragile code in the app.

`anchorHit` snaps to the finest stride in the file and **falls back through the
coarser strides** (2 → 4 → 8). The fallback is load-bearing, not decoration:
the dense grid backfills across more than one scheduled run, so until it
completes a cell's 0.05° anchor may not exist yet while its 0.1° or 0.2°
ancestor does. Because the strides nest, every coarser snap of the same point
is a real anchor position, so an incomplete backfill **degrades resolution
instead of blanking the overlay**. It also subsumes the old legacy-key
fallback, which is now deleted: a single-grid archive sets both strides to its
one value and the loop runs exactly once.

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

`anchorFor()` in `scripts/fetch-weather.mjs` and `snapLattice()` in
`index.html` have to derive the *identical* anchor from the same coordinate at
every stride, or the join misses. Both round straight to the nearest multiple
of `LATTICE × stride`. Do not reintroduce rounding via the lattice index and
then to the stride: that double rounding disagreed for 5,844 of 48,032 cells
and put 7 requested anchors outside the file. A unit test sweeps the whole
state at strides 2, 4 and 8 and asserts the two expressions match at every
point — if you change either side, that test is what catches you.
