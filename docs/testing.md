# The model regression suite
What `tests/model/` asserts, the two halves and their opposite rules about when
they may be updated.

## Model regression suite (`tests/model/`)

`npm test` runs everything. `npm run test:model` runs just this.

The ecological model had no independent tests until a bug made LANDFIRE host
quality inert statewide: all 39,981 forested cells scored as though their host
trees were ideal, so a logged Douglas-fir plantation ranked identically to a
Sitka spruce stand. It shipped, survived days of people looking at the map, and
was caught by a wasted field trip. Looking at a map cannot tell you that a
multiplier silently became 1.0 everywhere.

### The two halves, and the difference between them

| | |
| --- | --- |
| `relational.test.mjs` | Compares fixtures against each other. **Never** relaxed to make a failing model pass. |
| `snapshot.test.mjs` | Records exact numbers. **Deliberately** updated when tuning, via `npm run snapshots:update`. |

Relational assertions survive retuning — "Sitka spruce beats Douglas-fir in
identical weather" stays true whatever the constants do — which is what makes
them worth keeping and what makes relaxing one a real loss. If a relational test
fails, the model broke, or the invariant was wrong and needs arguing about.
Don't quietly weaken it.

Snapshots exist because relational tests are blind to a change that scales every
score by 15% while preserving every ordering. A snapshot failure is a question
("did you mean to move these?"), not a verdict. Update the file, then **read the
diff** — every changed number should be one you intended.

### Fixtures

Every fixture is a synthetic environment (weather series, elevation, slope,
aspect, vegetation), built from one baseline by overriding named fields, so a
compared pair differs in exactly the variable under test. That construction is
load-bearing: "north-facing holds moisture longer" only means something if the
weather and terrain are provably identical otherwise.

### How the model is imported

`tests/model/model.mjs` reads `index.html`, pulls out the model declarations
**by name**, and evaluates them in one sandbox. It does not copy them. Copying
would mean the tests keep passing after the model changes underneath them, which
is the exact failure being guarded against.

Two things that will bite whoever touches that loader:

- **Split on `/\r?\n/`, never `'\n'`.** `index.html` is CRLF in the working
  tree, and `\r` is a *line terminator* in JS regex — so `.` will not match it
  and any `(.+)$` anchor fails on every line. That silently reduced the
  extractor to functions-only, dropping every constant.
- **A trailing `// comment` still ends a declaration.** Without that clause,
  `const DLAT=0.0145, DLON=0.0214, BLK=4; // 1 sq mi cells` reads as
  unterminated and swallows every declaration after it.

Extraction failure is loud: a missing name throws with the list, rather than
producing a model with a hole in it. When the model is extracted into real
modules, delete the loader and import them directly.

### It is verified to catch the bug it was built for

Reintroducing the regression — making `vegMult` ignore `v.host` — fails four
tests, including the one named for it. That check is worth repeating after any
significant change to the suite: a test that cannot fail is not protecting
anything. The host-ladder assertion is strict (`<`, not `<=`) for exactly this
reason; with `<=` an inert model where every host collapses to one number slides
straight through.
