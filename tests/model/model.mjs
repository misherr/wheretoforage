// The model surface the fixture suite runs against.
//
// This used to read index.html and pull the model declarations out of it by name, because the model
// lived inside the app's single inline <script> alongside Leaflet setup, DOM handlers and fetch
// calls. It now lives in src/model/, so this just imports it.
//
// `M` is kept as one namespace object because the tests were written against it, and because a
// single import list here is the one place that has to change when the model's shape changes. It is
// not a re-export barrel for the app — index.html imports the modules directly.
import * as util from '../../src/model/util.mjs';
import * as habitat from '../../src/model/habitat.mjs';
import * as weather from '../../src/model/weather-score.mjs';
import * as phenology from '../../src/model/phenology.mjs';
import * as vegetation from '../../src/model/vegetation.mjs';
import * as cell from '../../src/model/cell.mjs';

export const M = { ...util, ...habitat, ...weather, ...phenology, ...vegetation, ...cell };

/* DOY used to be a module-global in index.html holding today's date, which meant every seasonal
   assertion was implicitly about the day the suite happened to run. The model now takes `doy` as an
   argument, so the fixtures carry their own — but the tests still call M.setDOY(), so keep it as the
   place a fixture's day of year is remembered between evaluate() and a direct M.habitat() call. */
let DOY = 260;
M.setDOY = d => { DOY = d; };
Object.defineProperty(M, 'DOY', { get: () => DOY });

/* ===================== fixture -> score, through the real pipeline ===================== */
// This is exactly what loadFromStatic() does per baked cell: makeEntry() builds terrain + habitat +
// weather, then applyVeg() folds in the vegetation multiplier. Running the same two functions the app
// runs is what makes these tests about the shipped path rather than about a reimplementation of it.
export function evaluate(fx) {
  M.setDOY(fx.doy);
  const veg = fx.veg ? { ...fx.veg, mult: M.vegMult(fx.veg) } : null;
  const e = M.makeEntry(fx.lat, fx.lon, 0.0145, fx.elev, fx.terr, fx.weather, fx.doy);
  if (veg) { e.veg = veg; M.applyVeg(e, fx.doy); }
  return e;
}

export const scoreOf = fx => evaluate(fx).A.now.score;
export const analysisOf = fx => evaluate(fx).A;
export const habitatOf = fx => evaluate(fx).hab;
