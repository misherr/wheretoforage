# The ecological model

This directory is the science: everything that turns a place, a date, a weather
series and a patch of forest into a number. It is deliberately separable from
the rest of the app — **you should be able to change the model without reading
`index.html` at all.** That is the whole reason it lives here.

The application around it (map rendering, the tap sheet, data loading, state)
stays in `index.html` and imports from here. Nothing here imports from there.

## The score is a suitability index, not a probability

A cell scoring 70 is not "70% likely to hold king boletes". The number is an
ordering device: it says this square mile looks better today than one scoring
40, on the factors the model knows about. It knows nothing about who walked it
yesterday, whether the road is gated, or whether that particular stand actually
fruits. Do not add calibration language, confidence intervals or percentage
framing to it, and do not "fix" the fact that scores cluster low — most of
Washington genuinely is not king bolete habitat on most days.

## Rules for this directory

1. **No DOM.** No `document`, no `window`, no element access. Prose is fine —
   several functions return strings — but they are returned, never rendered.
2. **No network.** No `fetch`, no service URLs. Data arrives as arguments.
3. **No map dependencies.** No Leaflet, no tile logic, no canvas, no
   projections beyond the plain trigonometry already here.
4. **No storage**, no `process`, no `require`.
5. **Deterministic.** No `Math.random`, and no reading the clock. Day of year
   is a parameter (`habitat(lat, lon, elev, doy)`) precisely so that a fixture
   scores the same in June as in October. A model that reads `new Date()`
   cannot be regression-tested; it can only be watched.
6. **Imports stay inside `src/model/`.** No package dependencies, no reaching
   back into the app.
7. **No species-specific logic outside a species adapter.** Everything here is
   currently tuned for *Boletus edulis* (and *B. rex-veris* in the spring
   east-side branch of `habitat()`). If a second species is ever added, its
   host rules, season windows and flush timing belong in its own adapter — not
   in `if (species === …)` branches threaded through these functions.

`tests/model/purity.test.mjs` enforces 1–6 mechanically. It is not decoration:
one `document.getElementById` in here and the modules stop loading in Node, the
fixture suite stops running, and the next regression ships unmeasured.

## Changes require model regression tests

`npm test` must pass, and that is the floor, not the bar.

- **Relational assertions** (`tests/model/relational.test.mjs`) compare fixtures
  against each other — "Sitka spruce beats Douglas-fir in identical weather".
  They survive retuning. **Never relax one to make a failing model pass.** If a
  relational test fails, either the model broke or the invariant was wrong, and
  the second case is worth an argument, not a quiet edit.
- **Snapshots** (`tests/model/snapshot.test.mjs`) record exact numbers and
  **are** meant to move when you tune: `npm run snapshots:update`, then *read
  the diff* — every changed number should be one you intended.

Tuning the constants also needs the user's explicit sign-off. They were set by
hand against field experience, not derived from a spec; see the root
`CLAUDE.md` under "Scoring model".

Add a fixture for anything you change. A model bug here is invisible from the
map: when LANDFIRE host quality silently became `1.0` everywhere, 39,981 cells
kept producing confident numbers and the map looked fine for days. It was
caught by a wasted field trip, which is what this suite exists to replace.

## The modules

| file | one sentence |
| --- | --- |
| `util.mjs` | Numeric curves (`trap`, `bell`, `interp`), unit conversions, and the score-band vocabulary. |
| `habitat.mjs` | Where and when boletes can grow, from position, elevation and day of year — terrain and calendar only. |
| `weather-score.mjs` | How favourable a cell's weather is: flush trigger, soil bucket, temperature window, humidity, kill switches — plus `adjustWeather`, which moves an anchor's series to the cell's own elevation and aspect. |
| `phenology.mjs` | What is standing right now: which past rain events produced cohorts and how far through emerging → buttons → prime → past → rotten each one is. |
| `vegetation.mjs` | How good the host trees are: land-cover caps, host species identity, and one joint stand-structure factor. |
| `cell.mjs` | The composition root: `makeEntry` and `applyVeg` multiply the four together into one scored cell. |

`util.mjs` is shared on purpose. `trap`, `bell` and `interp` are the shapes the
whole model is tuned in, so changing one of them moves habitat, weather and
phenology together — that is a feature, and a reason to be careful.

Dependency direction is strictly one way:

```
util  <-  habitat  <-\
util  <-  weather-score  <-  cell
                    <-  phenology
util  <-  vegetation
```

## How a vegetation type becomes a host score

Three mechanisms, deliberately kept apart, because they answer different
questions and no ordering of one list can serve all three:

1. **`NON_HOST_COVER`** — what the ground *is*. A cap, never a host. Bare rock,
   grassland, marsh, developed land and everything above treeline cap at 0.
   Open woodland and parkland cap at `OPEN_CANOPY_CAP` (0.3), but only when the
   name does not also say "forest" — `Ponderosa Pine Forest and Woodland` is a
   mosaic whose forest half is real habitat, `Subalpine Woodland and Parkland`
   is not.
2. **`HOST_SPECIES`** — which trees are named. A type naming several hosts
   scores the **mean** of them, which is a co-dominance assumption: the name
   says which species are present, not in what proportion, so absent better
   information each gets an equal share.
3. **`HOST_FALLBACK`** — "some kind of conifer forest", 0.5, used only when no
   species is recognised.

Every pattern is word-bounded. That is load-bearing, not tidiness: substring
matching made "Northern Rocky Mountain …" match `/rock/` and "Subalpine …"
match `/alpine/` across 63 LANDFIRE names, including most of the state's
genuine montane conifer forest. Those false matches were harmless only for as
long as an earlier rule happened to win first. Watch the inflections when
editing: `Quarries-Strip Mines-Gravel Pits` contains neither the word "quarry"
nor the word "mine".

**Western red-cedar scores 0.** *Thuja plicata* is arbuscular-mycorrhizal — it
forms no ectomycorrhiza and cannot host *Boletus edulis* at all, so those stems
are dead space. A redcedar-hemlock type therefore comes out at (0 + 0.6)/2 =
0.3, i.e. hemlock scaled by the ectomycorrhizal fraction of the stand. This is
the one host figure that comes from mycorrhizal biology rather than from field
tuning, and it is why that type must sit below pure hemlock rather than equal
to it.

**`HOST_NO_INFO` is one constant for two situations** — LANDFIRE said nothing,
and LANDFIRE said something we have no rule for. They used to be two numbers,
0.4 and 0.3, which had drifted into the wrong order so that knowing nothing
outranked knowing something uninterpretable. One constant cannot drift.

## What the vegetation data cannot say

Two hard limits, both discovered by trying to calibrate past them. Neither is
fixable in the model, and both bound how fine the discrimination can get.

**LANDFIRE EVH tops out at 40 m.** Across all 39,981 forested cells in
Washington the maximum stand height is 40 m, the 99th percentile is 33 m, and
only 0.47% exceed 35 m. Real old-growth Douglas-fir and western hemlock in this
state reach well beyond that, so *the stands the structure factor most wants to
reward cannot be expressed in the input at all.* `HEIGHT_QUALITY` therefore
reaches 1.0 at 33 m — the data's own p99 — rather than at a true old-growth
height. Anchoring it higher would put the top of the scale somewhere no cell
can reach. If a future EVH release resolves tall stands properly, this is the
constant to revisit, and the discrimination gets better for free.

**LANDFIRE does not name four of the strongest hosts.** `subalpine fir`,
`grand fir`, `noble fir` and `Engelmann spruce` appear in no LF2024 class name.
Those stands are called "Spruce-Fir" (6 names) or "Mixed Conifer" (10 names)
instead, so the 1.0 tier is reached through those plus silver fir, mountain
hemlock and Sitka spruce. The four patterns are kept because they are correct
about the species and would apply the moment a release names one;
`scripts/evt-names.test.mjs` lists them explicitly and fails if that changes in
either direction.

## Stand structure is one joint factor, not two independent ones

`structureFactor(canopy, height)` replaced an `fCanopy(c) * fHeight(h)`
product whose two flat tops overlapped into a plateau at 1.0 covering
everything from 49 ft and 25% cover upward. **76.7% of forested cells sat on
that plateau**, which is why stand structure was doing almost no work: 57 ft
second growth at 61% cover scored exactly what 200 ft old growth at 55% did.

The parts that matter if you retune it:

- young stands are **penalised, not excluded**. The first version put anything
  under 5 m near zero at any cover, reasoning that boletes fruit from
  established ectomycorrhizal root systems. That was stronger than the evidence
  supports: *B. edulis* does fruit in young plantations and along brushy edges
  near saplings, and an impression that it favours old growth partly reflects
  where people search rather than where the fungus fruits. A 3 m clearcut is
  still genuinely poor odds — 4.5x below a 33 m stand — but it is on the scale.
  Only 66 of 39,981 forested cells are under 5 m, so this is a correctness
  point about the term, not something visible on the map;
- the three tallest anchors (18, 25, 33 m) are the calibrated ones and must not
  drift when the young end is retuned; a test pins them;
- the height reward keeps climbing to 33 m instead of saturating at 15 m
  (see the EVH limit above for why 33 and not higher);
- moderate cover beats both extremes, and the preferred cover **falls and
  broadens as stands get taller** — 44% at 33 m against 60% at 8 m — because
  wide spacing in old growth means large crowns, while the same cover in a
  short stand is a failed plantation;
- `COVER_FLOOR` (0.55) lets cover modulate rather than gate, because EVC is a
  30 m average over a square mile and one number cannot tell an even 60% from a
  mosaic of gaps and closed patches;
- `LOW_COVER` is a separate ramp for the genuinely open end. Without it the
  floor made a 25 m stand at 12% cover score *higher* than the old function
  gave it, which is the wrong direction. Its shape is the old `fCanopy`'s,
  preserved rather than re-tuned.

## Host quality is recomputed at load time

`data/cells.json` format 2 carries the four per-sample vegetation types and a
tree-class bitmask per cell, and `hostFromSamples()` rebuilds host quality from
them when the app loads. **A host-rule change no longer needs a re-bake.** It
also removed a truncation: the old baked `top` kept three names, and 18.5% of
forested cells hold a fourth type it recorded nowhere — in the worst case the
dropped type was Sitka spruce, contributing a quarter of that cell's host
average and unreconstructible from the file.

Keep `hostFromSamples()` and the loop in `vegSummary()` doing the same
arithmetic; `scripts/build-cells.test.mjs` asserts they agree.
