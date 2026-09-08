// Synthetic environments for the model regression suite. No network, no browser, no real data.
//
// Every fixture is built from one baseline by overriding named fields, so a pair of fixtures used in
// a comparison differs in exactly the variable under test and nothing else. That is the whole point:
// "a Sitka spruce stand outscores a Douglas-fir plantation" only means something if the weather,
// terrain, elevation and date are provably identical between the two.

/* ===================== weather ===================== */
// 34 days: 26 of history, today, and 7 of forecast — the same shape the real archive uses, because
// analyze() indexes backwards from `today` by up to 30 days and fullAnalysis() walks 7 forward.
export const PAST = 26, FUTURE = 7, TODAY = PAST, DAYS = PAST + 1 + FUTURE;

const isoSeries = (endToday = '2026-09-17') => {
  const out = [];
  const t = Date.parse(endToday + 'T12:00:00Z');
  for (let i = -PAST; i <= FUTURE; i++) out.push(new Date(t + i * 86400e3).toISOString().slice(0, 10));
  return out;
};

/* A flat, unremarkable series: cool, damp, no rain. Every fixture starts here and perturbs it, so any
   score difference between two fixtures is attributable to the thing that was changed. */
export function weather(opts = {}) {
  const { tmax = 16, tmin = 8, et0 = 2.5, rh = 75, snow = 0, elev = 1000, rain = [], overrides = {} } = opts;
  const w = {
    time: isoSeries(opts.today),
    today: TODAY,
    elev,
    p: Array(DAYS).fill(0),
    tmax: Array(DAYS).fill(tmax),
    tmin: Array(DAYS).fill(tmin),
    et0: Array(DAYS).fill(et0),
    snow: Array(DAYS).fill(snow),
    rh: Array(DAYS).fill(rh),
  };
  // rain: [{daysAgo, mm}] — a single-day soak, which is what the 3-day trigger window is built to see
  for (const r of rain) {
    const idx = TODAY - r.daysAgo;
    if (idx < 0 || idx >= DAYS) throw new Error(`rain event ${r.daysAgo} days ago falls outside the series`);
    w.p[idx] += r.mm;
  }
  // overrides: {field: [{daysAgo, value}]} for spot changes like a frost night or a snowfall
  for (const [field, spots] of Object.entries(overrides)) {
    for (const s of spots) {
      const idx = TODAY - s.daysAgo;
      if (idx < 0 || idx >= DAYS) throw new Error(`${field} override ${s.daysAgo} days ago falls outside the series`);
      w[field][idx] = s.value;
    }
  }
  return w;
}

/* ===================== vegetation ===================== */
const topOf = (name, share = 1) => [{ name, share, host: null }];   // host label filled by the app; unused by vegMult

export const VEG = {
  // a mature, well-stocked stand — cover and height held constant so only `host` varies between these
  sitka:      { treeFrac: 1, canopy: 70, height: 25, host: 1.0,  top: topOf('North Pacific Seasonal Sitka Spruce Forest') },
  silverFir:  { treeFrac: 1, canopy: 70, height: 25, host: 1.0,  top: topOf('North Pacific Mesic Western Hemlock-Silver Fir Forest') },
  mixedConif: { treeFrac: 1, canopy: 70, height: 25, host: 0.8,  top: topOf('Northern Rocky Mountain Dry-Mesic Montane Mixed Conifer Forest') },
  dfHemlock:  { treeFrac: 1, canopy: 70, height: 25, host: 0.6,  top: topOf('North Pacific Maritime Dry-Mesic Douglas-fir-Western Hemlock Forest') },
  douglasFir: { treeFrac: 1, canopy: 70, height: 25, host: 0.45, top: topOf('North Pacific Douglas-fir Forest') },
  dryPine:    { treeFrac: 1, canopy: 70, height: 25, host: 0.4,  top: topOf('Northern Rocky Mountain Ponderosa Pine Woodland and Savanna') },
  harvested:  { treeFrac: 1, canopy: 70, height: 25, host: 0.25, top: topOf('Recently Harvested Forest') },
  hardwood:   { treeFrac: 1, canopy: 70, height: 25, host: 0.1,  top: topOf('North Pacific Broadleaf Landslide Forest') },
  notForest:  { treeFrac: 1, canopy: 70, height: 25, host: 0,    top: topOf('North Pacific Montane Shrubland') },

  // the shapes that are not about host quality
  noTrees:    { treeFrac: 0, canopy: 0,  height: 0,  host: 1.0,  top: topOf('North Pacific Montane Shrubland') },
  youngStand: { treeFrac: 1, canopy: 70, height: 5,  host: 1.0,  top: topOf('Recently Harvested Forest') },
  sparse:     { treeFrac: 1, canopy: 12, height: 25, host: 1.0,  top: topOf('North Pacific Mesic Western Hemlock-Silver Fir Forest') },

  // the regression itself: EVT did not resolve, so there is no host figure and no types at all
  missing:    { treeFrac: 1, canopy: 70, height: 25, host: null, top: [] },
};

/* ===================== sites ===================== */
// Chosen so each lands unambiguously in one habitat region, checked against habitat() in the tests.
export const SITE = {
  montane:  { lat: 47.5, lon: -121.5, elev: 1000, doy: 260 },   // West Cascades, fall peak
  coastal:  { lat: 47.0, lon: -124.0, elev: 50,   doy: 300 },   // Sitka spruce belt, Oct-Nov peak
  lowland:  { lat: 47.3, lon: -122.5, elev: 100,  doy: 300 },   // Puget / Chehalis, weak host country
  eastside: { lat: 47.5, lon: -120.3, elev: 1200, doy: 260 },   // East Cascades, fall peak
  alpine:   { lat: 47.5, lon: -121.5, elev: 2400, doy: 260 },   // above productive forest
};

/* ===================== fixture assembly ===================== */
const FLAT = { slope: 0, aspect: null };

export function fixture(name, opts = {}) {
  const site = opts.site || SITE.montane;
  return {
    name,
    lat: opts.lat ?? site.lat,
    lon: opts.lon ?? site.lon,
    elev: opts.elev ?? site.elev,
    doy: opts.doy ?? site.doy,
    terr: opts.terr || FLAT,
    veg: opts.veg === null ? null : (opts.veg || VEG.silverFir),
    weather: opts.weather || weather({ elev: opts.elev ?? site.elev, ...(opts.w || {}) }),
  };
}

/* Derive a variant that differs in exactly the named fields. Weather is rebuilt from the same options
   so the anchor elevation follows the fixture's elevation, which keeps adjustWeather's lapse
   correction at zero unless a test is deliberately exercising it. */
export function variant(base, name, overrides) {
  const elev = overrides.elev ?? base.elev;
  return {
    ...base,
    ...overrides,
    name,
    weather: overrides.weather || (overrides.w ? weather({ elev, ...overrides.w }) : { ...base.weather, elev }),
  };
}

const SOAK = [{ daysAgo: 12, mm: 45 }];        // 45 mm, 12 days back: dead centre of the flush kernel

/* ===================== the fixture set ===================== */
export const FIXTURES = {
  /* --- rain history --- */
  dry: fixture('dry', { w: {} }),
  recentHeavyRain: fixture('recentHeavyRain', { w: { rain: [{ daysAgo: 4, mm: 45 }] } }),
  midFlush: fixture('midFlush', { w: { rain: SOAK } }),
  postFlushDecay: fixture('postFlushDecay', { w: { rain: [{ daysAgo: 20, mm: 45 }] } }),
  longPastFlush: fixture('longPastFlush', { w: { rain: [{ daysAgo: 25, mm: 45 }] } }),

  /* --- temperature and snow kill switches, all on top of an otherwise prime mid-flush --- */
  hotAndDry: fixture('hotAndDry', { w: { tmax: 32, tmin: 16, et0: 6, rh: 25 } }),
  heatOnFlush: fixture('heatOnFlush', { w: { rain: SOAK, tmax: 32 } }),
  hardFrost: fixture('hardFrost', { w: { rain: SOAK, overrides: { tmin: [{ daysAgo: 2, value: -5 }] } } }),
  freshSnow: fixture('freshSnow', { w: { rain: SOAK, overrides: { snow: [{ daysAgo: 2, value: 5 }] } } }),

  /* --- humidity --- */
  humid: fixture('humid', { w: { rain: SOAK, rh: 85 } }),
  arid: fixture('arid', { w: { rain: SOAK, rh: 25 } }),

  /* --- region and elevation --- */
  coastalFall: fixture('coastalFall', { site: SITE.coastal, veg: VEG.sitka, w: { rain: SOAK, elev: 50 } }),
  lowlandFall: fixture('lowlandFall', { site: SITE.lowland, veg: VEG.douglasFir, w: { rain: SOAK, elev: 100 } }),
  eastsideFall: fixture('eastsideFall', { site: SITE.eastside, veg: VEG.mixedConif, w: { rain: SOAK, elev: 1200 } }),
  highElevation: fixture('highElevation', { elev: 1900, w: { rain: SOAK, elev: 1900 } }),
  lowElevation: fixture('lowElevation', { elev: 500, w: { rain: SOAK, elev: 500 } }),
  sweetSpot: fixture('sweetSpot', { elev: 1150, w: { rain: SOAK, elev: 1150 } }),
  alpine: fixture('alpine', { site: SITE.alpine, elev: 2400, w: { rain: SOAK, elev: 2400 } }),
  outOfSeason: fixture('outOfSeason', { doy: 30, w: { rain: SOAK } }),

  /* --- aspect: identical in every respect but the direction the slope faces --- */
  northAspect: fixture('northAspect', { terr: { slope: 15, aspect: 0 }, w: { rain: SOAK } }),
  southAspect: fixture('southAspect', { terr: { slope: 15, aspect: 180 }, w: { rain: SOAK } }),

  /* --- vegetation: identical weather and terrain, only the stand differs --- */
  strongHost: fixture('strongHost', { veg: VEG.sitka, w: { rain: SOAK } }),
  mediumHost: fixture('mediumHost', { veg: VEG.dfHemlock, w: { rain: SOAK } }),
  weakHost: fixture('weakHost', { veg: VEG.hardwood, w: { rain: SOAK } }),
  douglasFirHost: fixture('douglasFirHost', { veg: VEG.douglasFir, w: { rain: SOAK } }),
  noTreeCover: fixture('noTreeCover', { veg: VEG.noTrees, w: { rain: SOAK } }),
  missingVegData: fixture('missingVegData', { veg: VEG.missing, w: { rain: SOAK } }),
  youngPlantation: fixture('youngPlantation', { veg: VEG.youngStand, w: { rain: SOAK } }),
  sparseCanopy: fixture('sparseCanopy', { veg: VEG.sparse, w: { rain: SOAK } }),
};

export { SOAK };
