// Regression suite for the ecological prediction engine.
//
// These are RELATIONAL assertions: they compare fixtures against each other rather than pinning
// numbers. That is deliberate. Exact-value tests fight every legitimate tuning change and get
// "updated" until they assert nothing; relationships like "a Sitka spruce stand beats a Douglas-fir
// plantation in identical weather" stay true across retuning and fail loudly when the model breaks.
//
// **These assertions are not to be adjusted to make a failing model pass.** If one of them fails, the
// model changed in a way that violates an ecological invariant somebody thought was worth protecting.
// Fix the model, or come back and argue that the invariant was wrong — but do not quietly relax it.
// (Numeric drift is covered separately, and deliberately, in snapshot.test.mjs.)
//
// The bug that motivated all this: LANDFIRE host quality went inert statewide, so all 39,981 forested
// cells scored as though their host trees were ideal and a logged plantation ranked identically to a
// Sitka spruce stand. It shipped, survived days of looking at the map, and was caught by a wasted
// field trip. `host quality changes the score` below is the assertion that would have caught it in
// the second it appeared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { M, scoreOf, analysisOf, habitatOf } from './model.mjs';
import { FIXTURES as F, VEG, SITE, fixture, variant, weather, TODAY, DAYS } from './fixtures.mjs';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/* ===================== the fixtures are what they claim to be ===================== */

test('fixtures: each site lands in the habitat region it is named for', () => {
  M.setDOY(260);
  assert.match(M.habitat(SITE.montane.lat, SITE.montane.lon, SITE.montane.elev, 260).zone, /West Cascades/);
  assert.match(M.habitat(SITE.coastal.lat, SITE.coastal.lon, SITE.coastal.elev, 300).zone, /Coastal Sitka spruce/);
  assert.match(M.habitat(SITE.lowland.lat, SITE.lowland.lon, SITE.lowland.elev, 300).zone, /Puget \/ Chehalis/);
  assert.match(M.habitat(SITE.eastside.lat, SITE.eastside.lon, SITE.eastside.elev, 260).zone, /East Cascades/);
  assert.match(M.habitat(SITE.alpine.lat, SITE.alpine.lon, SITE.alpine.elev, 260).zone, /Alpine/);
});

test('model: a score is always a number in 0..100, for every fixture', () => {
  for (const [name, fx] of Object.entries(F)) {
    const s = scoreOf(fx);
    assert.ok(Number.isFinite(s), `${name} produced a non-finite score: ${s}`);
    assert.ok(s >= 0 && s <= 100, `${name} scored ${s}, outside 0..100`);
  }
});

test('model: identical input gives identical output', () => {
  // Guards against anything reaching for the clock, Math.random, or module-level mutable state.
  for (const fx of [F.midFlush, F.coastalFall, F.hardFrost]) {
    assert.equal(scoreOf(fx), scoreOf(fx), `${fx.name} is not deterministic`);
  }
});

/* ===================== rain drives the flush ===================== */

test('rain: a trigger rain scores above the same fixture with no rain', () => {
  assert.ok(scoreOf(F.midFlush) > scoreOf(F.dry),
    `mid-flush ${scoreOf(F.midFlush)} should beat dry ${scoreOf(F.dry)}`);
});

test('rain: the flush peaks in the middle of the kernel, not immediately after the rain', () => {
  // The whole model of a flush: rain lands, then fruiting comes up ~9-15 days later.
  const recent = scoreOf(F.recentHeavyRain), mid = scoreOf(F.midFlush), late = scoreOf(F.postFlushDecay);
  assert.ok(mid > recent, `mid-flush ${mid} should beat 4-days-after-rain ${recent}`);
  assert.ok(mid > late, `mid-flush ${mid} should beat 20-days-after-rain ${late}`);
  assert.ok(late > scoreOf(F.longPastFlush), 'a 20-day-old flush should beat a 25-day-old one');
});

test('rain: the flush decays toward zero as the event ages out of the window', () => {
  const ages = [12, 16, 20, 24, 26];   // 26 is the oldest day the fixture history reaches
  const scores = ages.map(a => scoreOf(fixture('aged' + a, { w: { rain: [{ daysAgo: a, mm: 45 }] } })));
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i] <= scores[i - 1] + 1e-9,
      `score rose from day ${ages[i - 1]} (${scores[i - 1]}) to day ${ages[i]} (${scores[i]}) — the flush should be fading`);
  }
  assert.ok(scores.at(-1) < scores[0], 'a 28-day-old flush should be well below a 12-day-old one');
});

test('rain: more rain in the trigger window never scores lower', () => {
  let prev = -Infinity;
  for (const mm of [0, 10, 15, 25, 40, 60]) {
    const s = scoreOf(fixture('mm' + mm, { w: { rain: [{ daysAgo: 12, mm }] } }));
    assert.ok(s >= prev - 1e-9, `${mm}mm scored ${s}, below the ${prev} from less rain`);
    prev = s;
  }
});

test('rain: a rain event too recent to have triggered anything is not treated as a flush', () => {
  // kernel() is zero below 3 days: rain that fell yesterday cannot already be fruiting.
  assert.equal(M.kernel(0), 0);
  assert.equal(M.kernel(2), 0);
  const yesterday = fixture('yesterday', { w: { rain: [{ daysAgo: 1, mm: 45 }] } });
  assert.equal(analysisOf(yesterday).now.F, 0, 'rain 1 day ago should not produce a flush trigger');
});

/* ===================== kill switches ===================== */

test('kill: a hard frost scores below the same fixture without frost', () => {
  const withFrost = scoreOf(F.hardFrost), without = scoreOf(F.midFlush);
  assert.ok(withFrost < without, `frost ${withFrost} should score below no-frost ${without}`);
  assert.equal(analysisOf(F.hardFrost).now.kill, 'frost');
});

test('kill: fresh snow scores below the same fixture without snow, and below frost', () => {
  const snow = scoreOf(F.freshSnow);
  assert.ok(snow < scoreOf(F.midFlush), 'snow should score below the same fixture without it');
  assert.ok(snow < scoreOf(F.hardFrost), 'snow ends the season harder than frost does');
  assert.equal(analysisOf(F.freshSnow).now.kill, 'snow');
});

test('kill: heat suppresses an otherwise prime flush', () => {
  const hot = scoreOf(F.heatOnFlush);
  assert.ok(hot < scoreOf(F.midFlush), `heat ${hot} should score below the same flush without it`);
  assert.equal(analysisOf(F.heatOnFlush).now.kill, 'heat');
});

test('no trigger rain means no chance, whatever else is favourable', () => {
  // The model's central claim: without a soak 3-24 days back there is nothing fruiting, so the score
  // is zero however ideal the temperature, humidity and habitat are.
  const a = analysisOf(F.dry).now;
  assert.equal(a.F, 0, 'no rain in the window should give no flush trigger');
  assert.equal(scoreOf(F.dry), 0, 'no trigger rain must score zero');
  assert.equal(a.X, 1, '...even with a perfect temperature window');
  assert.equal(a.Hu, 1, '...and perfect humidity');
});

test('kill: hot and dry degrades every factor, even where the score is already floored', () => {
  // Both of these score exactly 0 — F=0 floors them — so the score cannot express "worse". The
  // invariant worth protecting is the one underneath it: every multiplicative factor is worse under
  // heat and drought, so the moment any trigger rain appears the two diverge.
  const dry = analysisOf(F.dry).now, hot = analysisOf(F.hotAndDry).now;
  assert.equal(scoreOf(F.dry), 0);
  assert.ok(scoreOf(F.hotAndDry) <= scoreOf(F.dry), 'hot+dry must never score above merely dry');
  assert.ok(hot.X < dry.X, `temperature window ${hot.X} should be worse than ${dry.X}`);
  assert.ok(hot.Hu < dry.Hu, `humidity factor ${hot.Hu} should be worse than ${dry.Hu}`);
  assert.ok(hot.K < dry.K, `kill factor ${hot.K} should be worse than ${dry.K}`);
  assert.equal(hot.kill, 'heat');
  assert.equal(dry.kill, null);
  // and with a flush under way, the divergence is visible in the score itself
  const wetCool = fixture('wetCool', { w: { rain: [{ daysAgo: 12, mm: 45 }] } });
  const wetHot = fixture('wetHot', { w: { rain: [{ daysAgo: 12, mm: 45 }], tmax: 32, rh: 25 } });
  assert.ok(scoreOf(wetHot) < scoreOf(wetCool), 'with rain in the window, heat must show up in the score');
});

test('kill: only one kill switch is reported, and the harshest one wins', () => {
  // A fixture with frost AND snow must not report frost — snow is the stronger signal.
  const both = fixture('frostAndSnow', {
    w: { rain: [{ daysAgo: 12, mm: 45 }], overrides: { tmin: [{ daysAgo: 2, value: -5 }], snow: [{ daysAgo: 3, value: 5 }] } },
  });
  assert.equal(analysisOf(both).now.kill, 'snow');
  assert.ok(scoreOf(both) <= scoreOf(F.hardFrost) + 1e-9);
});

/* ===================== temperature and humidity windows ===================== */

test('temperature: the fruiting window is a band, not a slope', () => {
  assert.equal(M.tmaxSuit(2), 0, 'freezing highs are outside the window');
  assert.equal(M.tmaxSuit(16), 1, 'mid-teens highs are ideal');
  assert.equal(M.tmaxSuit(30), 0, 'thirty-degree highs are outside the window');
  assert.ok(M.tmaxSuit(16) > M.tmaxSuit(8) && M.tmaxSuit(16) > M.tmaxSuit(26), 'ideal beats either shoulder');
  assert.equal(M.tminSuit(-2), 0);
  assert.equal(M.tminSuit(8), 1);
  assert.equal(M.tminSuit(19), 0);
});

test('humidity: a humid flush scores above an arid one, all else equal', () => {
  assert.ok(scoreOf(F.humid) > scoreOf(F.arid),
    `humid ${scoreOf(F.humid)} should beat arid ${scoreOf(F.arid)}`);
});

test('temperature: a cooling trend is rewarded over a flat one', () => {
  // analyze() adds a bonus when the last 4 days average 2 C+ cooler than the 6 before them.
  const flat = fixture('flatTemp', { w: { rain: [{ daysAgo: 12, mm: 45 }] } });
  const cooling = fixture('cooling', {
    w: {
      rain: [{ daysAgo: 12, mm: 45 }],
      overrides: {
        tmax: [4, 5, 6, 7, 8, 9].map(d => ({ daysAgo: d, value: 22 })),
        tmin: [4, 5, 6, 7, 8, 9].map(d => ({ daysAgo: d, value: 13 })),
      },
    },
  });
  assert.ok(analysisOf(cooling).now.C > 0, 'a cooling trend should register');
  assert.equal(analysisOf(flat).now.C, 0, 'a flat trend should not');
});

/* ===================== soil moisture and aspect ===================== */

test('aspect: a north-facing slope holds moisture longer than a south-facing one', () => {
  // Identical fixtures but for the aspect. adjustWeather gives north slopes ~18% less evapo-
  // transpiration, so the soil bucket should drain more slowly.
  const n = analysisOf(F.northAspect).now, s = analysisOf(F.southAspect).now;
  assert.ok(n.M > s.M, `north-facing soil moisture ${n.M} should exceed south-facing ${s.M}`);
  assert.ok(n.bucket > s.bucket, `north-facing bucket ${n.bucket} should exceed south-facing ${s.bucket}`);
});

test('aspect: a north-facing slope runs cooler than a south-facing one', () => {
  const n = analysisOf(F.northAspect).now, s = analysisOf(F.southAspect).now;
  assert.ok(n.mx < s.mx, `north-facing max ${n.mx} should be below south-facing ${s.mx}`);
});

test('aspect: with no slope, aspect makes no difference at all', () => {
  const flatN = fixture('flatN', { terr: { slope: 0, aspect: 0 }, w: { rain: [{ daysAgo: 12, mm: 45 }] } });
  const flatS = fixture('flatS', { terr: { slope: 0, aspect: 180 }, w: { rain: [{ daysAgo: 12, mm: 45 }] } });
  assert.ok(near(scoreOf(flatN), scoreOf(flatS)), 'aspect must be inert on flat ground');
});

test('soil: the moisture bucket is bounded and responds to rain', () => {
  const wet = analysisOf(fixture('wet', { w: { rain: [8, 9, 10, 11, 12].map(d => ({ daysAgo: d, mm: 40 })) } })).now;
  const dry = analysisOf(F.dry).now;
  assert.ok(wet.M > dry.M, 'sustained rain should raise soil moisture');
  for (const a of [wet, dry]) {
    assert.ok(a.M >= 0 && a.M <= 1, `soil moisture ${a.M} out of 0..1`);
    assert.ok(a.bucket >= 0 && a.bucket <= 80, `soil bucket ${a.bucket} out of 0..80mm`);
  }
});

test('evapotranspiration: higher ET dries the soil out, all else equal', () => {
  const lowET = analysisOf(fixture('lowET', { w: { rain: [{ daysAgo: 12, mm: 45 }], et0: 1 } })).now;
  const highET = analysisOf(fixture('highET', { w: { rain: [{ daysAgo: 12, mm: 45 }], et0: 7 } })).now;
  assert.ok(lowET.M > highET.M, 'low ET should leave more soil moisture than high ET');
});

/* ===================== vegetation and host quality ===================== */

test('host: host quality changes the score — the regression that shipped', () => {
  // This is the assertion that would have caught the LANDFIRE EVT failure the day it appeared. When
  // host quality went inert, all of these collapsed to the same number.
  const sitka = scoreOf(F.strongHost), dfHem = scoreOf(F.mediumHost), hardwood = scoreOf(F.weakHost);
  assert.ok(sitka > dfHem, `Sitka spruce ${sitka} must outscore Douglas-fir/hemlock ${dfHem}`);
  assert.ok(dfHem > hardwood, `Douglas-fir/hemlock ${dfHem} must outscore hardwood ${hardwood}`);
  assert.ok(sitka > hardwood * 2, 'the spread between best and worst host should be substantial, not cosmetic');
});

test('host: the full host ladder is monotonic under identical weather', () => {
  // Strictly decreasing wherever the host scores differ. Non-strict `<=` would let an inert model —
  // every host collapsing to one number — pass this test, which is exactly the failure it exists to
  // catch, so a tie between two different host grades is a failure here.
  const ladder = ['sitka', 'mixedConif', 'dfHemlock', 'douglasFir', 'dryPine', 'harvested', 'hardwood', 'notForest'];
  let prev = null, prevName = null;
  for (const key of ladder) {
    const s = scoreOf(fixture(key, { veg: VEG[key], w: { rain: [{ daysAgo: 12, mm: 45 }] } }));
    if (prev !== null) {
      assert.ok(s < prev, `${key} (host ${VEG[key].host}) scored ${s}; ` +
        `${prevName} (host ${VEG[prevName].host}) scored ${prev}. A better host must score strictly higher — ` +
        `equal scores here mean host quality has gone inert.`);
    }
    prev = s; prevName = key;
  }
});

test('host: missing host data scores below known-mediocre host data', () => {
  // HOST_NO_INFO is a penalty for absent data, not an estimate. Unknown must never outrank a stand
  // whose type we actually know and which we know to be only fair.
  const missing = scoreOf(F.missingVegData);
  assert.ok(missing < scoreOf(F.douglasFirHost),
    `missing veg ${missing} must score below known Douglas-fir ${scoreOf(F.douglasFirHost)}`);
  assert.ok(missing < scoreOf(F.mediumHost), 'missing veg must score below known Douglas-fir/hemlock');
  assert.ok(missing < scoreOf(F.strongHost), 'missing veg must score below known Sitka spruce');
  assert.ok(M.HOST_NO_INFO < M.hostOf('North Pacific Douglas-fir Forest').sc,
    'HOST_NO_INFO must sit below the Douglas-fir host score');
});

test('host: a cell with zero tree cover scores zero regardless of weather', () => {
  for (const w of [{}, { rain: [{ daysAgo: 12, mm: 45 }] }, { rain: [{ daysAgo: 12, mm: 200 }], rh: 95 }]) {
    const fx = fixture('bare', { veg: VEG.noTrees, w });
    assert.equal(scoreOf(fx), 0, 'no tree cover must score zero whatever the weather does');
  }
  assert.equal(M.vegMult(VEG.noTrees), 0);
});

test('vegetation: stand structure matters independently of host species', () => {
  const mature = scoreOf(F.strongHost);
  assert.ok(scoreOf(F.youngPlantation) < mature, 'a young regenerating stand should score below a mature one');
  assert.ok(scoreOf(F.sparseCanopy) < mature, 'a sparse canopy should score below a well-stocked one');
  assert.ok(M.structureFactor(50, 10) < M.structureFactor(50, 33), 'height response must be increasing');
  assert.ok(M.structureFactor(12, 25) < M.structureFactor(50, 25), 'cover response must rise off the open end');
});

test('vegetation: the multiplier is bounded and zero only when there are no trees', () => {
  for (const [name, v] of Object.entries(VEG)) {
    const m = M.vegMult(v);
    assert.ok(m >= 0 && m <= 1, `${name} multiplier ${m} out of 0..1`);
    if (v.treeFrac > 0 && v.host !== 0) assert.ok(m > 0, `${name} should not zero out a forested cell`);
  }
});

/* ===================== compound host types ===================== */

test('host: a mixed hemlock-silver fir type scores below pure silver fir', () => {
  // The bug this is named for: the rule list tested /silver fir/ before /western hemlock/, so any
  // type merely containing "Silver Fir" scored 1.0 and a hemlock-silver fir MIX was indistinguishable
  // from pure silver fir. Two field negatives were walked in stands of exactly this type.
  const mix = scoreOf(F.hemlockSilverFirHost), pure = scoreOf(F.pureSilverFirHost);
  assert.ok(mix < pure, `hemlock-silver fir mix ${mix} must score below pure silver fir ${pure}`);
  assert.ok(mix > scoreOf(F.pureHemlockHost),
    'and above pure hemlock — a mix scores toward its weaker member, not down to it');
});

test('host: redcedar drags a mixed type below pure hemlock', () => {
  // Thuja plicata is arbuscular-mycorrhizal: it forms no ectomycorrhiza and cannot host B. edulis at
  // all, so those stems are dead space and the type is worth the ECM fraction of the stand. This is
  // the one host figure that comes from mycorrhizal biology rather than from field tuning.
  const rc = scoreOf(F.redcedarHemlockHost), hem = scoreOf(F.pureHemlockHost);
  assert.ok(rc < hem, `redcedar-hemlock ${rc} must score below pure hemlock ${hem}`);
  assert.equal(M.hostOf('North Pacific Hypermaritime Western Red-cedar-Western Hemlock Forest').sc,
    M.hostOf('North Pacific Western Hemlock Forest').sc / 2,
    'a two-species type, half of which cannot host at all, should be worth half the host value');
});

test('host: land cover caps rather than competing with host identity', () => {
  // "North Pacific Alpine and Subalpine Bedrock and Scree" scored 1.0 — the model's maximum host
  // quality — because /subalpine/ sits in the true-fir rule and won before /scree/ was reached. Bare
  // rock must not inherit a host score from a word sitting next to it, whatever the tree fraction says.
  assert.equal(M.hostOf('North Pacific Alpine and Subalpine Bedrock and Scree').sc, 0);
  assert.equal(M.hostOf('North Pacific Alpine and Subalpine Dry Grassland').sc, 0);
  assert.equal(M.hostOf('Rocky Mountain Subalpine-Montane Mesic Meadow').sc, 0);
  assert.ok(M.hostOf('North Pacific Maritime Mesic Subalpine Parkland').sc <= M.OPEN_CANOPY_CAP,
    'open parkland must be capped, not scored as closed forest');
  assert.ok(scoreOf(F.subalpineRockHost) < scoreOf(F.weakHost),
    'a bare-rock type must score below even the weakest real forest type');
});

test('host: word boundaries — "Rocky Mountain" is not the word "rock"', () => {
  // Substring matching made 63 LANDFIRE names collide with the not-forest rule, including most of
  // the state's genuine montane conifer forest. Those false matches were harmless only for as long
  // as an earlier rule happened to win first, which is not a property worth relying on.
  assert.equal(M.hostOf('Northern Rocky Mountain Dry-Mesic Montane Mixed Conifer Forest').sc, 0.8,
    'a Rocky Mountain mixed-conifer forest must keep its host score');
  assert.equal(M.hostOf('Northern Rocky Mountain Mesic Montane Mixed Conifer Forest').sc, 0.8);
  assert.equal(M.hostOf('North Pacific Active Volcanic Rock and Cinder Land').sc, 0,
    'but genuine rock must still be caught');
  assert.ok(M.hostOf('North Pacific Broadleaf Landslide Forest').sc > 0,
    '"Broadleaf" must not match the word "road"');
  assert.equal(M.hostOf('Quarries-Strip Mines-Gravel Pits-Well and Wind Pads').sc, 0,
    'plurals matter: neither "quarry" nor "mine" appears as a whole word in that name');
});

test('host: unrecognised and missing are both penalties, and neither beats known-mediocre', () => {
  // These used to be two constants that had drifted out of order: an unrecognised name scored 0.3
  // while a missing one scored 0.4, so "LANDFIRE said nothing" outranked "LANDFIRE said something we
  // cannot interpret" — backwards. One constant now serves both, so they cannot drift apart again.
  const missing = scoreOf(F.missingVegData), unrec = scoreOf(F.unrecognisedVegType);
  assert.equal(missing, unrec, 'missing and unrecognised must score identically');
  for (const known of ['douglasFirHost', 'mediumHost', 'strongHost']) {
    assert.ok(missing <= scoreOf(F[known]),
      `absent host information (${missing}) must not outrank known ${known} (${scoreOf(F[known])})`);
  }
  assert.ok(M.HOST_NO_INFO < M.hostOf('North Pacific Douglas-fir Forest').sc,
    'the no-information penalty must sit below the Douglas-fir host score');
});

/* ===================== stand structure ===================== */

test('structure: a tall moderate-cover stand beats a short one', () => {
  // fHeight saturated at 15 m, so 57 ft second growth and 200 ft old growth scored identically.
  // 76.7% of forested cells sat on the resulting 1.0 plateau, which is why structure did no work.
  const tall = scoreOf(F.tallModerateStand), short = scoreOf(F.shortModerateStand);
  assert.ok(tall > short, `tall+moderate ${tall} must beat short+moderate ${short}`);
});

test('structure: a tall moderate-cover stand beats a tall dense one', () => {
  // Kings favour light reaching the floor. fCanopy treated 25-75% as uniformly ideal, so an even
  // 84% canopy and an open 45% produced the same number.
  const mod = scoreOf(F.tallModerateStand), dense = scoreOf(F.tallDenseStand);
  assert.ok(mod > dense, `tall+moderate ${mod} must beat tall+dense ${dense}`);
});

test('structure: a young stand is penalised, not excluded', () => {
  /* This assertion was reversed deliberately. It used to require a stand under 5 m to score "near
     zero at any cover", on the reasoning that B. edulis fruits only from established
     ectomycorrhizal root systems. That is stronger than the evidence supports — it does fruit in
     young plantations and along brushy edges near saplings, and an impression that it favours old
     growth partly reflects where people search. The invariant is now that a young stand is on the
     scale and clearly below a mature one, rather than off the scale entirely. */
  const young = M.structureFactor(70, 5);        // 16 ft plantation at good cover
  const mature = M.structureFactor(50, 25);      // 82 ft stand at moderate cover
  assert.ok(young > 0.15 * mature,
    `a 5 m stand at 70% cover (${young.toFixed(3)}) must be a real number next to a mature stand ` +
    `(${mature.toFixed(3)}), not an exclusion`);
  assert.ok(young < 0.45 * mature,
    `but it must still be plainly worse (${young.toFixed(3)} vs ${mature.toFixed(3)})`);

  // Tied to the constant rather than a number picked here, so moving the knee has to be deliberate.
  const kneeAt5 = M.HEIGHT_QUALITY.find(([h]) => h === 5)[1];
  assert.ok(kneeAt5 > 0.15 && kneeAt5 < 0.5,
    `the 5 m knee (${kneeAt5}) should be a penalty, not an exclusion and not a free pass`);
});

test('structure: a 3 m clearcut is still poor odds', () => {
  // Relaxing the floor must not flatten it. A regenerating clearcut should remain one of the worst
  // things the structure term can say about a cell, just not a disqualification.
  const clearcut = M.structureFactor(40, 3), mature = M.structureFactor(50, 25);
  assert.ok(clearcut < 0.3 * mature,
    `a 3 m clearcut (${clearcut.toFixed(3)}) must stay well below a mature stand (${mature.toFixed(3)})`);
  assert.ok(clearcut > 0.05 * mature,
    `but not be excluded outright (${clearcut.toFixed(3)})`);
  // and the ordering through the young end must be strict, not flat
  let prev = -1;
  for (const h of [1, 3, 5, 8, 12]) {
    const v = M.structureFactor(50, h);
    assert.ok(v > prev, `structure must rise strictly through the young end, stalled at ${h} m`);
    prev = v;
  }
});

test('structure: the calibrated tall anchors have not moved', () => {
  /* 18, 25 and 33 m are the anchors set against the real EVH range — 33 m is its 99th percentile and
     1.0 is defined there. Relaxing the young end must leave them exactly where they were, so this
     pins them: a future change to the low end that drags the tall end with it fails here. */
  const anchor = h => M.HEIGHT_QUALITY.find(([x]) => x === h);
  assert.deepEqual(anchor(18), [18, 0.78], "the 18 m anchor moved");
  assert.deepEqual(anchor(25), [25, 0.92], "the 25 m anchor moved");
  assert.deepEqual(anchor(33), [33, 1.0], "the 33 m anchor moved — that is the EVH p99, not a free knob");
  assert.equal(M.structureFactor(44, 33), 1, "the top of the scale must still be reachable");
});

test('structure: taller stands tolerate lower cover than short ones', () => {
  // Wide spacing in old growth means large crowns and an extensive root network; the same cover in a
  // short stand is a failed plantation. So the preferred cover falls as height rises.
  const tallAdv = M.structureFactor(35, 33) / M.structureFactor(60, 33);
  const shortAdv = M.structureFactor(35, 10) / M.structureFactor(60, 10);
  assert.ok(tallAdv > shortAdv,
    `low cover must cost a tall stand less than a short one (${tallAdv.toFixed(2)} vs ${shortAdv.toFixed(2)})`);
});

test('structure: the height reward keeps climbing past 15 m, to the data\'s own limit', () => {
  // Not to an imagined 200 ft: LANDFIRE EVH tops out at 40 m statewide with p99 at 33 m, so the real
  // old growth this ought to reward cannot be expressed in the input at all. Calibrating past the
  // data would put the top of the scale somewhere no cell can reach.
  let prev = -1;
  for (const h of [8, 12, 15, 18, 22, 25, 29, 33]) {
    const v = M.structureFactor(50, h);
    assert.ok(v > prev, `structure must still be rising at ${h} m (${v.toFixed(3)} vs ${prev.toFixed(3)})`);
    prev = v;
  }
  assert.equal(M.structureFactor(44, 33), M.structureFactor(44, 40),
    'and flat above the range the data can express, rather than extrapolating past it');
});

/* ===================== region, elevation, season ===================== */

test('elevation: the sweet spot outscores both well above and well below it', () => {
  const sweet = scoreOf(F.sweetSpot);
  assert.ok(sweet > scoreOf(F.highElevation), 'the sweet spot should beat 1,900 m');
  assert.ok(sweet > scoreOf(F.lowElevation), 'the sweet spot should beat 500 m');
});

test('elevation: above the alpine threshold, habitat all but disappears', () => {
  assert.ok(scoreOf(F.alpine) < scoreOf(F.midFlush) * 0.25,
    'alpine should score far below productive montane forest in the same weather');
});

test('season: out of season scores below in season with identical weather', () => {
  assert.ok(scoreOf(F.outOfSeason) < scoreOf(F.midFlush),
    'a January date should score below a September one on the same weather');
});

test('region: the coastal belt outscores the Puget lowland in the same weather', () => {
  // Douglas-fir lowland is explicitly weighted low; the Sitka spruce belt is the best country there is.
  assert.ok(scoreOf(F.coastalFall) > scoreOf(F.lowlandFall),
    `coastal ${scoreOf(F.coastalFall)} should beat lowland ${scoreOf(F.lowlandFall)}`);
});

test('region: an east-side high site produces a real fall score', () => {
  assert.ok(scoreOf(F.eastsideFall) > 0, 'the east side should score above zero at its fall peak');
  assert.ok(scoreOf(F.eastsideFall) > scoreOf(F.lowlandFall), 'east-side high country should beat the Puget lowland');
});

/* ===================== fruiting stages ===================== */

test('stages: the breakdown percentages sum to 100', () => {
  for (const fx of [F.midFlush, F.recentHeavyRain, F.postFlushDecay, F.coastalFall]) {
    const b = M.stageBreakdown(fx.weather.p, fx.weather.today);
    assert.ok(b, `${fx.name} should produce a stage breakdown`);
    const sum = M.STAGE_KEYS.reduce((a, k) => a + b.pct[k], 0);
    assert.ok(near(sum, 1, 1e-9), `${fx.name} stage percentages sum to ${sum}, not 1`);
    for (const k of M.STAGE_KEYS) assert.ok(b.pct[k] >= 0 && b.pct[k] <= 1, `${k} share ${b.pct[k]} out of range`);
  }
});

test('stages: a cohort ages through every stage in order and never skips one', () => {
  const order = ['emerging', 'buttons', 'prime', 'past', 'rotten'];
  const seen = [];
  for (let age = 0; age <= 40; age++) {
    const mix = M.stageMix(age);
    let top = null, best = -1;
    for (const k of order) if (mix[k] > best) { best = mix[k]; top = k; }
    if (best <= 0) continue;                       // past the end of the cohort's life
    if (seen.at(-1) !== top) seen.push(top);
  }
  assert.deepEqual(seen, order,
    `a cohort should pass through ${order.join(' -> ')} in order; it went ${seen.join(' -> ')}`);
});

test('stages: a single rain event ages through the stages as the day index advances', () => {
  // Same thing again, but through the real stageBreakdown path rather than stageMix alone.
  const order = ['emerging', 'buttons', 'prime', 'past', 'rotten'];
  const seen = [];
  for (let age = 0; age <= 34; age++) {
    const p = Array(80).fill(0);
    const i = 40;
    p[i - age] = 45;
    const b = M.stageBreakdown(p, i);
    if (!b) continue;
    if (seen.at(-1) !== b.top) seen.push(b.top);
  }
  const idx = seen.map(s => order.indexOf(s));
  assert.ok(idx.every((v, k) => k === 0 || v > idx[k - 1]),
    `stages went backwards or repeated: ${seen.join(' -> ')}`);
  assert.equal(seen[0], 'emerging', 'a fresh cohort should start as emerging');
  assert.equal(seen.at(-1), 'rotten', 'an old cohort should end as rotten');
});

test('stages: rain too light to trigger a flush produces no cohort at all', () => {
  const p = Array(40).fill(0); p[28] = 4;           // well under the 10 mm 3-day threshold
  assert.equal(M.stageBreakdown(p, 34), null, 'a 4 mm sprinkle should not create a cohort');
});

test('stages: no cohort is reported where the season is over', () => {
  assert.equal(M.stageOf(F.freshSnow.weather, TODAY, habitatOf(F.freshSnow)), null,
    'snow should suppress the stage readout');
  assert.equal(M.stageOf(F.hardFrost.weather, TODAY, habitatOf(F.hardFrost)), null,
    'frost should suppress the stage readout');
});

/* ===================== forecast shape ===================== */

test('forecast: eight days are produced, dated in order, starting today', () => {
  const A = analysisOf(F.midFlush);
  assert.equal(A.fut.length, 8, 'today plus seven forecast days');
  assert.equal(A.fut[0].date, F.midFlush.weather.time[TODAY], 'the first entry is today');
  for (let i = 1; i < A.fut.length; i++) {
    assert.ok(A.fut[i].date > A.fut[i - 1].date, 'forecast days must be in ascending date order');
  }
  assert.ok(A.fut.every(d => Number.isFinite(d.score) && d.score >= 0 && d.score <= 100));
});

test('forecast: the best day is never worse than today', () => {
  for (const fx of [F.midFlush, F.dry, F.recentHeavyRain, F.coastalFall]) {
    const A = analysisOf(fx);
    assert.ok(A.best.score >= A.now.score - 1e-9,
      `${fx.name}: best ${A.best.score} is below today ${A.now.score}`);
  }
});

test('forecast: rain in the forecast window raises the outlook without moving today', () => {
  const base = fixture('noFcRain', { w: { rain: [{ daysAgo: 12, mm: 45 }] } });
  const withRain = fixture('fcRain', { w: { rain: [{ daysAgo: 12, mm: 45 }, { daysAgo: -3, mm: 40 }] } });
  assert.ok(near(analysisOf(base).now.score, analysisOf(withRain).now.score),
    'rain three days from now must not change today’s score');
  assert.ok(analysisOf(withRain).fRain > analysisOf(base).fRain, 'forecast rain total should rise');
});

/* ===================== verdict text ===================== */

test('verdict: the prose matches the state the model is in', () => {
  assert.match(M.verdict(analysisOf(F.freshSnow)), /[Ss]now/);
  assert.match(M.verdict(analysisOf(F.hardFrost)), /frost/i);
  assert.match(M.verdict(analysisOf(F.noTreeCover)), /not king bolete habitat/i);
  for (const fx of Object.values(F)) {
    const v = M.verdict(analysisOf(fx));
    assert.ok(typeof v === 'string' && v.length > 0, `${fx.name} produced no verdict`);
    assert.ok(!/undefined|NaN|\[object/.test(v), `${fx.name} verdict leaked a placeholder: ${v}`);
  }
});
