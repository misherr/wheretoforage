# Terrain: slope, aspect and the elevation cache key
Why the checked-in slope and aspect changed when the bake moved out of the
browser, and the `pointKey` truncation found while proving it.

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
