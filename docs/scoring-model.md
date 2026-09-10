# The scoring model, in long form
The hand-tuned constants and what each term means. **Changing any of it needs the
user's explicit sign-off** — see `src/model/CLAUDE.md` for the rules that apply
inside `src/model/`.

## Scoring model (hand-tuned — do not refactor or "clean up" without asking)

`score = habitat × trigger rain × soil moisture × temperature window × humidity`,
with kill switches for frost, snow, and heat.

- **Trigger rain** (`analyze()`): looks for the best 3-day rain total of
  at least 0.4" in a window 3–24 days back; flushes are modeled as peaking
  9–15 days after that event.
- **Soil moisture**: a bucket — rain in, 70% of reference evapotranspiration
  out, capped at 80mm.
- **Temperature window**: ideal highs 50–72°F, lows 37–55°F. A cooling trend
  of 3.5°F+ over the prior week adds a bonus. Heat ≥86°F, hard frost ≤27°F
  (or ~30°C max / -3°C min triggers in `analyze()`), and fresh snow
  are kill switches that zero or heavily discount the score.
- **Humidity**: 3-day mean relative humidity; ≥70% ideal, <40% penalized.
- **Host quality** (`NON_HOST_COVER` / `HOST_SPECIES` / `hostOf` /
  `HOST_NO_INFO`): three separate mechanisms, not one ordered list. Land cover
  caps (bare rock, grass, marsh, developed, above treeline → 0; open woodland
  and parkland → 0.3), host species set the value as the **mean of every
  species the type names**, and a generic "conifer forest" fallback scores 0.5.
  Western red-cedar is 0 — it is arbuscular-mycorrhizal and cannot host boletes.
  **A missing *or* unrecognised type scores `HOST_NO_INFO` = 0.3**, below dry
  pine (0.4) and Douglas-fir (0.45), because absent information must never
  outrank known-mediocre. See "Host quality: absent data is penalised, and land
  cover caps".
- **Stand structure** (`structureFactor`): one joint function of canopy cover
  and stand height, replacing an `fCanopy × fHeight` product whose overlapping
  flat tops put 76.7% of forested cells on a plateau at 1.0. Nothing under 5 m;
  the height reward climbs to 33 m (the EVH p99 — the data cannot express real
  old growth, see `src/model/CLAUDE.md`); moderate cover beats dense or sparse,
  and the preferred cover falls and broadens as stands get taller.
- **Habitat** (`function habitat`): four regions, each with
  its own season window and an elevation band that drifts downslope through
  fall:
  - Coastal Sitka spruce
  - West Cascades / Olympic montane forest
  - East Cascades / Okanogan / Selkirks / Blue Mountains (includes the spring
    king, *B. rex-veris*, following snowmelt upslope in May–June)
  - Puget / Chehalis lowland (weighted low — Douglas-fir is a weak host;
    planted spruce/pine/fir do better)
- **Per-cell weather adjustment** (`adjustWeather`-style
  logic): each cell's weather is derived from its nearest anchor by lapse
  rate (6.5°C/km) and by aspect (north-facing slopes ~1°C cooler, ~18% less
  evapotranspiration than the anchor).

Any change to the scoring constants, thresholds, or habitat region
definitions needs explicit sign-off from the user first — this model was
tuned by hand against field experience, not derived from a spec.
