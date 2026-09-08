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
| `vegetation.mjs` | How good the host trees are, from LANDFIRE cover, height and vegetation type. |
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

## Two things that look like bugs and are not

- **`HOST_UNKNOWN = 0.4`** sits *below* Douglas-fir at 0.45. That is
  deliberate: unknown must never outrank known-mediocre. It is a penalty for
  absent data, not an estimate of anything.
- **`hostOf()` returns `{sc: 0.3}` for an unrecognised name**, but
  `vegMult()` uses `HOST_UNKNOWN` when there is no name at all. Those are
  different situations — "LANDFIRE says something we have no rule for" versus
  "LANDFIRE said nothing" — and they are scored differently on purpose.
