# LANDFIRE vegetation
Where host quality comes from, the one-line failure that cost a whole bake, and
what the rules changes did to the numbers. See also `src/model/CLAUDE.md`, which
carries the rules for changing the model itself.

## LANDFIRE EVT: the mapping is checked in, and why

`getSamples` returns a **numeric EVT code** and nothing else. Every vegetation
name in the model — and therefore every host-quality score — comes from mapping
that code to a class name.

That mapping used to arrive at runtime from the service's legend, where each
item carried `values:["7039"]`. **It doesn't any more.** The legend now repeats
the class name in that field instead:

```
values: ["North Pacific Maritime Mesic-Wet Douglas-fir-Western Hemlock Forest"]
```

`parseInt` is `NaN` on all 831 entries, so the map came out empty, the
`if(m.size>50)` gate failed, and `evtNames` stayed `null`. The service also
reports `hasRasterAttributeTable:false` and its `rasterAttributeTable` endpoint
returns `{}`, so there is **no live source for the mapping at all**.

So `data/evt-names.json` (1,069 codes, 57 KB) is checked in, built from
LANDFIRE's published EVT CSV. **Do not reconstruct codes from legend order
instead** — the ordering is undocumented, and this service has already changed
the shape of that response once.

### How that one-line failure cost a whole bake

`vegFor()` gates sampling on `evtNames`:

```js
evtNames ? sampleLayer('evt',pts) : Promise.resolve(pts.map(()=>null))
```

With `evtNames` null, EVT was never *requested*. `sampleLayer('evt')` was
healthy the whole time — this is the opposite of the accepted-but-null trap.
48,032 cells were baked with `host:-1` and no types, `names[]` in `cells.json`
came out empty, and nothing failed loudly. Three things had to line up to hide
it, and all three are now fixed:

1. **The gate turned a name lookup into a data outage.** A missing legend should
   cost you type *names*, not the type sampling itself.
2. **A missing host scored as perfect** — see below.
3. **Nothing said so.** Both `vegNote` branches wrote the same string, the tap
   sheet silently dropped the host clause and the Types row, and in
   `PUBLIC_MODE` `loadFromStatic()` returns before `loadEvtNames()` is ever
   reached, so `vegNote` was permanently `''` in the deployed app.

### The legend is still consulted — as an override only

`loadEvtNames()` loads the static table first, then tries the legend and
**merges on top** if it ever returns numeric codes again. That second fetch is
wrapped so that neither a throw nor an empty parse can clear `evtNames`. A test
proves it: with the legend fetch rejecting outright, the table still holds 1,069
entries and sampling still runs.

### Validating a replacement table

If the table is ever rebuilt, verify before trusting it — the codes are not
guaranteed stable across LANDFIRE releases:

- **Three known codes**, sampled live from `LF2024_EVT_CONUS` at Washington
  points: `7036` → North Pacific Seasonal Sitka Spruce Forest (outer coast),
  `7039` → North Pacific Maritime Mesic-Wet Douglas-fir-Western Hemlock Forest
  (west Cascades), `9826` → Southern Vancouverian Lowland Ruderal Grassland.
  Geographic plausibility is the point: a shifted table puts Gulf Coast types in
  the Cascades.
- **Legend coverage**: 829 of the service's 831 legend labels appear in the
  checked-in table. The two that don't are a Texas and a Great Plains type,
  neither of which occurs in Washington.
- **A statewide sample**: 501 cells spread across the state, every code mapped,
  and every resulting name also present in the service's own legend.

`node --test scripts/evt-names.test.mjs` pins the three codes, checks the table
is not truncated, checks every name `cells.json` references is producible from
it, and asserts no forested cell is missing a type.

## Re-baking cells.json for vegetation only

`data/cells.json` is normally not to be regenerated. Filling in EVT is the
exception, and it is **surgical**: elevation, slope and aspect are carried over
from the existing file untouched (they never depended on EVT), and only the `vg`
block is recomputed.

The bake resamples all three LANDFIRE layers, not just EVT, because
`vegSummary()` averages canopy and height over the samples it judges to be tree,
and takes the host average over samples where `isTree` — an EVC property. The
baked aggregates alone cannot reproduce that.

Resampling EVC/EVH also buys the only real check on the sample geometry: the
recomputed `treeFrac`/`canopy`/`height` must reproduce the baked values exactly.
They did, for **all 48,032 cells, zero differences** — which is what proves the
script's quarter-point geometry (`±DLAT/4`, `±DLON/4`, in the app's order)
matches `vegFor()`. If that check ever shows differences, the geometry is wrong
and the host scores built on it are wrong too; do not ship the result.

The full run is ~193 batches of 250 cells (1,000 sample points per request per
layer) and takes about **70 seconds**.

## Host quality: absent data is penalised, and land cover caps

`vegMult()` once multiplied by **1.0** when `v.host` was null. Combined with a
broken EVT lookup that meant every one of 39,981 forested cells was scored as
though its host trees were ideal — a logged Douglas-fir plantation ranked
identically to a Sitka spruce stand, and the entire species discrimination was
inert while still producing confident numbers. It shipped, survived days of
people looking at the map, and was caught by a wasted field trip.

`HOST_NO_INFO = 0.3` is the penalty now, and it is **one constant for two
situations**: LANDFIRE said nothing, and LANDFIRE said something we have no rule
for. Those used to be 0.4 and 0.3 respectively, which had drifted into the wrong
order — knowing nothing outranked knowing something uninterpretable. One
constant cannot drift. It sits below dry pine (0.4) and Douglas-fir (0.45):
absent information must never outrank known-mediocre.

Two field negatives in September 2026 — both in stands typed
`North Pacific Mesic Western Hemlock-Silver Fir Forest`, both actually western
hemlock and western redcedar on the ground — exposed a second and larger family
of errors, fixed together in the same commit. See `src/model/CLAUDE.md`,
"How a vegetation type becomes a host score", for the mechanism. In summary:

- **land cover now caps rather than competing.** `Alpine and Subalpine Bedrock
  and Scree` scored **1.0** — the model's maximum — because `/subalpine/` sat in
  the true-fir rule and won before `/scree/` was reached. So did alpine
  grassland, two subalpine meadows and a deciduous shrubland;
- **a compound type scores the mean of the hosts it names**, not the strongest.
  A hemlock-silver fir mix was indistinguishable from pure silver fir;
- **western red-cedar scores 0**, because *Thuja plicata* is
  arbuscular-mycorrhizal and cannot host boletes at all;
- **every pattern is word-bounded**, because "Northern Rocky Mountain" was
  matching `/rock/` and "Subalpine" was matching `/alpine/` across 63 names.

### What that did to host quality

Over all 39,981 forested cells, recomputed from the same per-sample LANDFIRE
types so nothing but the rules changed:

| host factor | before | after |     | host factor | before | after |
| --- | --- | --- | --- | --- | --- | --- |
| 0.0 | 1,333 | 1,620 | | 0.6 | 3,910 | 5,210 |
| 0.1 | 2,799 | 3,652 | | 0.7 | 3,432 | 3,980 |
| 0.2 | 3,616 | 4,437 | | 0.8 | 7,275 | 6,264 |
| 0.3 | 3,372 | 4,244 | | 0.9 | 2,077 | 1,340 |
| 0.4 | 3,062 | 4,590 | | 1.0 | 5,166 | 561 |
| 0.5 | 3,939 | 4,083 | | | | |

Mean 0.562 → 0.470, median 0.600 → 0.475, p90 1.000 → 0.800. **28,443 cells
fell, none rose**, 11,538 unchanged. Cells sitting at exactly 1.0 went from
4,910 to 324 — that collapse is the fix: the old rule list handed the maximum
host score to anything whose name happened to contain "subalpine".
