# Terrain: slope, aspect and the elevation cache key
Why the checked-in slope and aspect changed when the bake moved out of the
browser, the `pointKey` truncation found while proving it, and what the corrupt
Terrarium pixels do to slope and aspect.

## Slope and aspect: why the checked-in values changed

`scripts/build-cells.mjs` was built to reproduce the checked-in `data/cells.json`
exactly, as the proof that it is a faithful replacement for the button rather than
a second, subtly different generator. Measured over all 48,032 cells:

| field | matches the checked-in file |
| --- | --- |
| the cell set itself | 48,032 / 48,032, none gained, none lost |
| `elev` | 48,032 / 48,032 |
| `treeFrac`, `canopy`, `height`, `host`, `top` | 48,032 / 48,032 each |
| `slope` | 41,186 / 48,032 — **6,846 differ** |
| `aspect` | 41,793 / 48,032 — **6,239 differ** |

Elevation being identical is what makes the cause provable: the inputs to
`terrainAt()` are the same, so the difference is entirely in **which neighbours
were available when it ran**.

The app fetched elevation per weather-anchor group, in an order driven by habitat
priority and by the map viewport, then computed slope and aspect immediately. A
cell whose neighbour belonged to a group that had not been reached yet fell back
to a one-sided gradient. Two measurements confirm it:

- Cells whose four-neighbourhood crosses a 0.2° anchor-group boundary differ at
  **28.1%**; interior cells at **8.3%**.
- **6,675 of the 7,092** differing cells are reproduced exactly by recomputing
  the gradient with some subset of neighbours withheld. The remaining 417 are the
  same effect where the withheld neighbour is a gated-out cell whose elevation is
  not in the file, so it cannot be reconstructed from the file alone.

The script's values are the correct ones — it samples every cell of every retained
block before computing any terrain, so the answer does not depend on visit order —
and the old values were an artifact of a viewport. **They were adopted with the
user's sign-off**, as a correction rather than a tuning choice. Do not "fix" this
by making the script reproduce the artifact.

### The `pointKey` truncation, fixed at the same time

While reproducing the file, a second and independent defect turned up.
`cellCenter()` returns a 5-decimal coordinate, but the elevation cache is keyed by
`pointKey`, which truncates to 4 — and `lat + DLAT` lands a hair *below* the
neighbour's own 5-decimal value often enough that the two round to different
strings. **77 of every 300 cells in latitude** (0 in longitude) therefore take a
one-sided north-south gradient even though the neighbour's elevation is sitting in
the cache.

At five decimals the neighbour lookup hits 300 of 300 and distinct cells still
never collide. It was fixed in the same re-bake, and its effect measured
separately because it is much the larger of the two terrain changes:

| change | cells whose slope or aspect moved |
| --- | --- |
| order-independent terrain (browser → script) | 7,092 |
| `pointKey` 4 dp → 5 dp | **23,396** |

Elevation is identical across all three bakes (48,032 of 48,032), which is what
makes both attributions clean: the inputs to `terrainAt()` never changed, only
which neighbours it could see.

## The Terrarium tiles contain garbage at water/land boundaries

De-spiking the elevation profile in `scripts/build-access.mjs` raised an obvious
question: those same tiles feed `terrainAt()`, so does the same garbage corrupt
the slope and aspect baked into `data/cells.json`, and with them the north/south
temperature and moisture adjustment in `adjustWeather`?

**Measured before changing anything. It does, and it is not worth fixing on its
own.** All 450 z10 tiles covering the state were re-fetched and decoded, and
every cell's five sample pixels were recomputed twice — once raw, once with
outlier pixels replaced — so the difference is attributable to the filtering and
nothing else.

### Where the garbage is

A pixel was called an outlier when it sits more than 300 m from the median of its
eight neighbours. Over the 21,617,778 pixels inside the state bbox:

| deviation from the neighbourhood median | pixels |
| --- | --- |
| p50 | 2 m |
| p90 | 10 m |
| p99 | 26 m |
| p99.9 | 43 m |
| p99.99 | 130 m |
| over 300 m | 662 (0.003%) |
| worst | 4,396 m |

Those 662 pixels form **127 distinct patches on 61 of 450 tiles**, from 1 to 43
pixels each, and the pattern in their locations is the finding:

| patch centre | px | worst reading | what is there |
| --- | --- | --- | --- |
| 48.1134, -118.2589 | 43 | -2,341 m | Lake Roosevelt |
| 48.2389, -122.7015 | 36 | -1,414 m | Skagit Bay |
| 46.2620, -123.5941 | 25 | -2,869 m | the Columbia at Cathlamet |
| 46.4894, -117.2385 | 25 | 2,962 m | the Snake at Clarkston |
| 45.7527, -120.1595 | 24 | -3,653 m | the Columbia at Roosevelt |
| 48.0372, -120.3353 | 17 | -4,066 m | Lake Chelan |
| 47.8643, -119.1955 | 17 | 1,949 m | Banks Lake |
| 46.2611, -119.2381 | 17 | 2,272 m | the Columbia at Richland |

**Every patch sits at a water/land boundary** — the seam where Terrarium splices
bathymetry into the land DEM. That includes the pixel from the access writeup:
tile `10/164/363`, the row reading `1295 2820 3087 3072 763 762 759`, is at
46.30852,-122.23595 in the St Helens blast zone, and the 763 m on its right is
the surface of Castle Lake. Same mechanism.

This is also why the deep negatives are the giveaway: -4,066 m is not a DEM error
in the ordinary sense, it is ocean-floor data leaking into a lake edge.

### What it does to the baked cells

`terrainAt()` reads five pixels per cell — the centre and four neighbours a full
`DLAT`/`DLON` away, which is about **16 pixels** at z10 (103 m/px at 47.5°N).
With 662 bad pixels in 21.6 million, the expected number of cells that sample one
is about 7. Measured: **8 cells** — 2 at their own centre, 6 at a neighbour.
Six of them end up with slope or aspect that moves:

| cell | shipped slope/aspect | de-spiked | error |
| --- | --- | --- | --- |
| 46.26225, -123.6171 | 33.3° / 332° | 4.5° / 163° | 28.8°, 169° |
| 46.26225, -123.5957 | 30.6° / 36° | 3.5° / 185° | 27.1°, 149° |
| 46.27675, -123.6171 | 18.2° / 7° | 2.9° / 130° | 15.3°, 123° |
| 46.26225, -123.5743 | 16.6° / 95° | 2.5° / 235° | 14.1°, 140° |
| 46.27675, -123.5957 | 15.6° / 10° | 4.7° / 143° | 10.9°, 133° |
| 47.68325, -122.2689 | 10.5° / 88° | 1.6° / 75° | 8.8°, 13° |

So where it lands it is severe — up to 28.8° of slope and 169° of aspect, which
is 1.23 °C (2.2 °F) on the aspect temperature term and 22% on the ET multiplier,
and two cells flip from north-facing to south-facing. But it lands on **6 of
48,032 cells, 0.012%**.

Two of those also carry a **wrong elevation**, which matters more per cell than
the aspect does: 965 m and 1,175 m where USGS 3DEP says 29 m and 34 m. That is
6.1 °C and 7.4 °C of lapse-rate error on every temperature in the series, and it
puts a Columbia River floodplain cell in the "West Cascades montane forest" zone
at 3,166 ft. A third cell, 47.68325,-122.2475 on the Lake Washington shore, reads
-503 m, fails `everHabitat` and is **missing from `cells.json` entirely**;
corrected it would be a real, if unremarkable, cell.

### Why none of it reaches the user

The vegetation axis already catches these cells, independently of the DEM. Six of
the eight have **Open Water as 50% of their four LANDFIRE samples**, and the
other two are `Developed-Roads`. Checked in the running app, the worst offenders
score **2, 1, 0, 0 and 0** against a statewide top of 77, because the vegetation
multiplier is 0.15 and 0.05. A phantom mountain cell on a river is still a cell
with no host trees.

### Why the climb fix's filter does not belong here

The instinct to port the median-and-gradient-gate from `build-access.mjs` is
wrong, for three measured reasons.

1. **The failure geometry is different.** The climb profile samples every vertex
   along a route and accumulates, so it is exposed to isolated single pixels and
   never cancels an error. Slope and aspect sample 5 pixels over a 1.6 km
   baseline and are exposed only when one of those 5 is bad. The bake's sparse
   sampling is what protects it.
2. **A median does not repair these patches.** Against 3DEP over the 60 sample
   points of the affected cells: raw Terrarium is off by a median of 24 m and a
   maximum of **1,141 m**; a 3×3 ring median brings the maximum only to **139 m**,
   and a 5×5 to **158 m**. The corruption is 13–43 pixels wide, so the median's
   own neighbourhood is contaminated. For the climb the artefacts were isolated
   single pixels and a 3-point median removed them completely. Same data, same
   defect, different tool needed.
3. **A filter loose enough to catch more would perturb real terrain.** Lowering
   the threshold to 60 m moves 50 cells, and inspecting them shows the extra 44
   are genuine Cascade ridge and valley pixels being smoothed, not garbage —
   0.1–0.9° of slope on real ground. Re-baking 48,032 cells to fix 6 while
   perturbing terrain everywhere else is the wrong trade, and hard rule 3 says
   not to re-bake `cells.json` without being asked.

The proposal instead is in [ROADMAP.md](../ROADMAP.md): on the next re-bake that
is happening for another reason, reject an implausible own elevation and store
`slope 0 / aspect null`, which the model already reads as "no aspect
information", rather than a repaired guess. Roughly 8 cells.

### Two things worth knowing that came out of the same measurement

**The live path is far more exposed than the bake.** `pointEntry` in
`index.html` — the "Check this exact spot" tap — samples at `d = 0.0015°`, which
is about **1.5 pixels** at z10, not 16. A single bad pixel there produces a slope
near 85°. It is still confined to those water-edge patches, so a tap has to land
almost on one, but the exposure per bad pixel is much higher and the same
plausibility check would fix it.

**The pixel size in the comments was wrong.** Both `scripts/build-cells.mjs` and
`index.html` said "~76 m per pixel at 47°N", and the about text said "~75 m
resolution". A 256-pixel z10 tile is 152.87 m/px at the equator, so
**103 m/px at 47.5°N** — 100 to 107 m across the state's latitudes. Corrected in
place; it is the number that decides whether a gradient threshold is reasonable,
so it is worth having right.

**And a precision floor to remember.** On the *good* pixels of these same cells,
Terrarium and 3DEP disagree by a median of 24 m. Over `terrainAt`'s 1.6 km
baseline that is about 1° of slope noise on every cell in the state, which is a
larger effect than the spikes and is inherent to the DEM, not a defect in it.
