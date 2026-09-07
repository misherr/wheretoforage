// Tests for the two-grid rolling weather archive.
// Run: node --test scripts/fetch-weather.test.mjs   (node --test scripts/ fails on Node 24)
//
// The merge is the dangerous part: if it silently drops or misaligns a day, the rain history rots and
// the flush model keeps emitting confident numbers from bad data. So the central assertion here is
// that a short rolling fetch merged into an existing archive is byte-identical to what one full fetch
// of the same period would have produced — especially across the boundary where the windows overlap.
//
// The second dangerous part is new: two grids meeting at today. A naive join steps every variable at
// the seam, and the flush model reads a step in rain as an event. So the splice is tested for the
// property that actually matters — that it does not manufacture a discontinuity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  LATTICE, PAST_STRIDE, FORECAST_STRIDE, GRIDS, GRID_ORDER,
  PAST_KEEP, FC, PAST_FULL, PAST_ROLL, FIELDS, DAILY_CEILING,
  isActive, anchorFor, anchorKey, coarseParent, assertStrideNesting,
  addDays, dateRange, toDateMap, fromDateMap, mergeSeries, trimSeries, callCost,
  FRESH_FRACTION, freshWindowMs, BIAS_TAPER, BIAS_WINDOW, BIAS_LIMITS, biasWeight, measureBias,
  envKey, readLedger,
  tempLimitFor, BIAS_TEMP_BASE, BIAS_TEMP_MAX,
} from './fetch-weather.mjs';

const TODAY = '2026-09-05';
const AXIS = dateRange(addDays(TODAY, -PAST_KEEP), addDays(TODAY, FC - 1));

// Deterministic stand-in for what the API would return for a date. Distinct per field and per day.
function truth(date, key) {
  const n = [...date].reduce((a, c) => a + c.charCodeAt(0), 0);
  const s = [...key].reduce((a, c) => a + c.charCodeAt(0), 0);
  return Math.round(((n * 7 + s * 13) % 500) / 10 * 10) / 10;
}
const truthRow = date => Object.fromEntries(FIELDS.map(f => [f.key, truth(date, f.key)]));
const staleRow = date => Object.fromEntries(FIELDS.map(f => [f.key, truth(date, f.key) + 100]));

// A fetch of `past` days back plus FC forecast days, returned as a date -> row map of true values.
function apiFetch(past) {
  const m = new Map();
  for (const d of dateRange(addDays(TODAY, -past), addDays(TODAY, FC - 1))) m.set(d, truthRow(d));
  return m;
}

// Archive where everything older than the rolling window is already correct, but the last few days
// hold stale forecast values that a rolling fetch has to overwrite.
function syntheticArchive() {
  const m = new Map();
  for (const d of AXIS) m.set(d, d <= addDays(TODAY, -PAST_ROLL - 1) ? truthRow(d) : staleRow(d));
  return m;
}

/* ===================== lattice and the two grids ===================== */

test('lattice: stride 8 anchors survive halving to 4 and 2', () => {
  assert.equal(assertStrideNesting(8), true);
  for (let i = -400; i <= 400; i++) {
    if (!isActive(i, i, 8)) continue;
    assert.ok(isActive(i, i, 4), `index ${i} lost at stride 4`);
    assert.ok(isActive(i, i, 2), `index ${i} lost at stride 2`);
  }
});

test('grids: the coarse stride is a multiple of the dense one, so every coarse anchor is a dense anchor', () => {
  assert.equal(FORECAST_STRIDE % PAST_STRIDE, 0, 'coarse stride must divide by the dense stride');
  assert.ok(GRIDS.past.stride < GRIDS.forecast.stride, 'the past grid must be the denser of the two');
  // an anchor position active at the coarse stride is active at the dense one
  for (let i = -400; i <= 400; i++) {
    if (i % FORECAST_STRIDE !== 0) continue;
    assert.ok(i % PAST_STRIDE === 0, `coarse index ${i} is not a dense anchor position`);
  }
  // ...and its coordinate is literally unchanged, which is the property the history reuse depends on
  for (let i = -40; i <= 40; i++) {
    if (i % FORECAST_STRIDE !== 0) continue;
    const deg = Math.round(i * LATTICE * 1e4) / 1e4;
    assert.deepEqual(anchorFor(deg, deg, PAST_STRIDE), [deg, deg], `coarse anchor ${deg} moved on the dense grid`);
  }
});

test('grids: coarseParent is idempotent, so parents-of-dense cannot orphan a dense anchor', () => {
  // The coarse set is built as {coarseParent(d) : d in dense}. For that to guarantee every dense
  // anchor finds its parent, coarseParent applied to a coarse anchor must return that anchor.
  for (let lat = 45.5; lat <= 49.0; lat += 0.0137) {
    for (let lon = -124.7; lon <= -117.0; lon += 0.211) {
      const d = anchorFor(lat, lon, PAST_STRIDE);
      const p = coarseParent(d[0], d[1]);
      assert.deepEqual(coarseParent(p[0], p[1]), p, `coarseParent not idempotent at ${p}`);
      // the parent is within half a coarse step of the dense anchor it serves
      const sp = LATTICE * FORECAST_STRIDE;
      assert.ok(Math.abs(d[0] - p[0]) <= sp / 2 + 1e-9, `parent too far in lat at ${d}`);
      assert.ok(Math.abs(d[1] - p[1]) <= sp / 2 + 1e-9, `parent too far in lon at ${d}`);
    }
  }
});

test('grids: on the real cells, every dense anchor has a parent — and direct snapping would not give it one', () => {
  // The double-rounding trap that cost 5,844 cells during the stride migration, in a new guise. It is
  // a property of the real cell footprint (an irregular state outline), not of any regular sweep, so
  // this asserts against data/cells.json rather than a synthetic grid.
  const path = new URL('../data/cells.json', import.meta.url);
  if (!fs.existsSync(path)) { console.log('  (skipped: data/cells.json not present)'); return; }
  const rows = JSON.parse(fs.readFileSync(path, 'utf8')).rows;

  const dense = new Map(), parents = new Set(), direct = new Set();
  for (const r of rows) { const a = anchorFor(r[0], r[1], PAST_STRIDE); dense.set(anchorKey(a[0], a[1]), a); }
  for (const a of dense.values()) { const p = coarseParent(a[0], a[1]); parents.add(anchorKey(p[0], p[1])); }
  for (const r of rows) { const s = anchorFor(r[0], r[1], FORECAST_STRIDE); direct.add(anchorKey(s[0], s[1])); }

  // the guarantee we actually rely on: nothing dense is left without a forecast
  let missing = 0;
  for (const a of dense.values()) { const p = coarseParent(a[0], a[1]); if (!parents.has(anchorKey(p[0], p[1]))) missing++; }
  assert.equal(missing, 0, `${missing} dense anchors have no coarse parent in the fetched set`);

  // and the guarantee direct snapping does NOT give: coarse anchors nothing dense points at
  let orphaned = 0;
  for (const k of direct) if (!parents.has(k)) orphaned++;
  assert.ok(orphaned > 0,
    'direct snapping used to produce coarse anchors that serve no dense anchor; if that is no longer ' +
    'true the trap has moved and this test needs rewriting, not deleting');
  console.log(`  dense ${dense.size}, coarse parents ${parents.size}, direct-snapped ${direct.size}, of which ${orphaned} serve nothing`);
});

test('lattice: anchorFor really returns the nearest active point, and index.html can rederive it', () => {
  // index.html joins cells to anchors with exactly this expression (snapLattice), reading the strides
  // from weather.json. If anchorFor ever diverges the join silently misses and the map goes blank.
  const appJoin = (lat, lon, stride) => {
    const sp = LATTICE * stride;
    return [Math.round(Math.round(lat / sp) * sp * 1e4) / 1e4, Math.round(Math.round(lon / sp) * sp * 1e4) / 1e4];
  };
  for (const stride of [PAST_STRIDE, 4, FORECAST_STRIDE]) {
    const sp = LATTICE * stride;
    for (let lat = 45.5; lat <= 49.0; lat += 0.0137) {
      for (let lon = -124.7; lon <= -117.0; lon += 0.211) {
        const a = anchorFor(lat, lon, stride);
        assert.deepEqual(a, appJoin(lat, lon, stride), `app join disagrees at ${lat},${lon} stride ${stride}`);
        assert.ok(Math.abs(lat - a[0]) <= sp / 2 + 1e-9, `not nearest in lat at ${lat} stride ${stride}`);
        assert.ok(Math.abs(lon - a[1]) <= sp / 2 + 1e-9, `not nearest in lon at ${lon} stride ${stride}`);
      }
    }
  }
});

/* ===================== the merge ===================== */

test('merge: rolling fetch into an archive equals a single full fetch', () => {
  const archive = syntheticArchive();
  const rolling = trimSeries(mergeSeries(archive, apiFetch(PAST_ROLL)), AXIS);
  const oneShot = trimSeries(mergeSeries(archive, apiFetch(PAST_FULL)), AXIS);

  assert.equal(rolling.size, AXIS.length, 'rolling merge lost or gained days');
  assert.deepEqual([...rolling.keys()], AXIS, 'rolling merge dates out of order');
  assert.deepEqual(rolling, oneShot, 'rolling merge differs from a full fetch');
  for (const d of AXIS) assert.deepEqual(rolling.get(d), truthRow(d), `wrong values at ${d}`);
});

test('merge: the overlap boundary is exact', () => {
  const merged = trimSeries(mergeSeries(syntheticArchive(), apiFetch(PAST_ROLL)), AXIS);
  const firstFresh = addDays(TODAY, -PAST_ROLL);        // first day the rolling window covers
  const lastArchive = addDays(TODAY, -PAST_ROLL - 1);   // last day only the archive covers

  assert.deepEqual(merged.get(lastArchive), truthRow(lastArchive), 'day just outside the window was disturbed');
  assert.deepEqual(merged.get(firstFresh), truthRow(firstFresh), 'first day inside the window was not refreshed');
  assert.deepEqual(merged.get(TODAY), truthRow(TODAY), 'today was not refreshed');
  for (const d of dateRange(firstFresh, addDays(TODAY, FC - 1))) {
    assert.notDeepEqual(merged.get(d), staleRow(d), `stale forecast survived at ${d}`);
  }
});

test('merge: aging forecasts get corrected toward reality', () => {
  const archive = new Map(AXIS.map(d => [d, truthRow(d)]));
  const revised = new Map([[addDays(TODAY, -1), { ...truthRow(addDays(TODAY, -1)), p: 99.9 }]]);
  const merged = mergeSeries(archive, revised);
  assert.equal(merged.get(addDays(TODAY, -1)).p, 99.9, 'revision did not overwrite');
  assert.equal(merged.get(addDays(TODAY, -2)).p, truth(addDays(TODAY, -2), 'p'), 'neighbouring day was touched');
  assert.equal(merged.size, archive.size, 'revision changed the day count');
});

test('merge: the dense grid keeps its history even though it only fetches one forecast day', () => {
  // The dense grid asks for past_days=3&forecast_days=1. Merged into a 30-day archive it must leave
  // the other 27 days alone — this is what makes 6,666 anchors cost 1.0 call each.
  const denseAxis = dateRange(addDays(TODAY, -PAST_KEEP), TODAY);
  const archive = new Map(denseAxis.map(d => [d, truthRow(d)]));
  const fresh = new Map(dateRange(addDays(TODAY, -GRIDS.past.past), TODAY).map(d => [d, { ...truthRow(d), p: 42 }]));
  const merged = trimSeries(mergeSeries(archive, fresh), denseAxis);
  assert.equal(merged.size, denseAxis.length, 'dense merge changed the day count');
  assert.equal(merged.get(TODAY).p, 42, 'today not refreshed');
  assert.equal(merged.get(addDays(TODAY, -GRIDS.past.past)).p, 42, 'first day of the window not refreshed');
  assert.equal(merged.get(addDays(TODAY, -GRIDS.past.past - 1)).p, truth(addDays(TODAY, -GRIDS.past.past - 1), 'p'),
    'a day outside the dense window was overwritten');
});

test('trim: history older than PAST_KEEP is dropped, forecast days are kept', () => {
  const old = dateRange(addDays(TODAY, -PAST_KEEP - 10), addDays(TODAY, FC - 1));
  const trimmed = trimSeries(new Map(old.map(d => [d, truthRow(d)])), AXIS);
  assert.equal(trimmed.size, AXIS.length);
  assert.equal([...trimmed.keys()][0], addDays(TODAY, -PAST_KEEP));
  assert.equal([...trimmed.keys()].at(-1), addDays(TODAY, FC - 1));
  assert.ok(!trimmed.has(addDays(TODAY, -PAST_KEEP - 1)), 'day older than the window survived the trim');
});

test('round trip: arrays -> date map -> arrays is lossless and stays aligned', () => {
  const anchor = { lat: 47.4, lon: -121.6, elev: 900 };
  for (const f of FIELDS) anchor[f.key] = AXIS.map(d => truth(d, f.key));
  const back = fromDateMap(toDateMap(AXIS, anchor), AXIS);
  for (const f of FIELDS) assert.deepEqual(back[f.key], anchor[f.key], `${f.key} changed in the round trip`);
  for (const f of FIELDS) assert.equal(back[f.key].length, AXIS.length, `${f.key} length != axis`);
});

test('round trip: a missing optional variable stays null, required ones stay arrays', () => {
  const anchor = { lat: 47.4, lon: -121.6, elev: 900 };
  for (const f of FIELDS) if (f.key !== 'rh') anchor[f.key] = AXIS.map(d => truth(d, f.key));
  anchor.rh = null;
  const back = fromDateMap(toDateMap(AXIS, anchor), AXIS);
  assert.equal(back.rh, null, 'absent optional variable should serialise as null');
  assert.ok(Array.isArray(back.p) && back.p.length === AXIS.length, 'p must always be an array');
});

test('ragged detection: an anchor missing a day is caught', () => {
  const s = new Map(AXIS.map(d => [d, truthRow(d)]));
  s.delete(AXIS[5]);
  assert.ok(AXIS.some(d => !s.has(d)), 'gap should be detectable against the shared axis');
  const whole = new Map(AXIS.map(d => [d, truthRow(d)]));
  assert.ok(!AXIS.some(d => !whole.has(d)), 'complete series must not look ragged');
});

/* ===================== cost ===================== */

test('cost: both grids floor at 1.0 call per anchor, which is the whole point of the split', () => {
  const vars = FIELDS.length;
  assert.equal(callCost(GRIDS.past.past + GRIDS.past.fc, vars), 1, 'dense past window should floor at 1.0');
  assert.equal(callCost(GRIDS.forecast.past + GRIDS.forecast.fc, vars), 1, 'coarse forecast window should floor at 1.0');
  // the variable count is free at the floor — which is why the dense grid carries all ten, not just rain
  assert.equal(callCost(GRIDS.past.past + GRIDS.past.fc, 1), 1);
  assert.equal(callCost(GRIDS.past.past + GRIDS.past.fc, 10), 1);
  // a full backfill is not free, and that is why it has to spread across runs
  assert.ok(callCost(PAST_FULL + GRIDS.past.fc, vars) > 1.5, 'a backfill should cost well over one call');
});

test('cost: the measured budget fits both Open-Meteo caps, and the monthly cap has no slack', () => {
  const dense = 6666, coarse = 493;    // measured from data/cells.json
  const runsPerDay = g => 24 / GRIDS[g].cadenceHours;
  const perDay = dense * runsPerDay('past') + coarse * runsPerDay('forecast') + 2;   // +2 probes
  assert.equal(perDay, 7654, 'the measured steady-state budget changed — recheck the caps');
  assert.ok(perDay <= 10000, `daily spend ${perDay} exceeds the 10,000 cap`);
  assert.ok(perDay * 30 <= 300000, `monthly spend ${perDay * 30} exceeds the 300,000 cap`);
  // The monthly cap is exactly 30x the daily, so there is no headroom to borrow against a busy day:
  // whatever fits daily fits monthly and nothing more. Our ceiling has to sit under the daily cap.
  assert.equal(300000, 10000 * 30);
  assert.ok(DAILY_CEILING < 10000, 'the run ceiling must leave room under the hard daily cap');
  assert.ok(DAILY_CEILING > perDay, 'the run ceiling must not starve steady-state operation');
});

/* ===================== per-grid resume guard ===================== */

test('resume guard: each grid derives its own window from its own cadence', () => {
  // The old guard was one global 5h constant tuned for four uniform 6-hourly runs. With the dense
  // grid on 24h and the coarse grid on 12h, one constant cannot serve both.
  const past = freshWindowMs('past') / 3600e3;
  const fc = freshWindowMs('forecast') / 3600e3;
  assert.notEqual(past, fc, 'the two grids must not share one freshness window');
  assert.ok(past > fc, 'the slower grid must hold a longer window');
  // the original relationship is preserved: 5h of a 6h cadence is 0.83
  assert.equal(freshWindowMs('past', 5 / 6) / 3600e3, 20);
  assert.equal(freshWindowMs('forecast', 5 / 6) / 3600e3, 10);
});

test('resume guard: a scheduled run is never skipped, an immediate re-run always is', () => {
  // This is the property the guard exists for. For each grid: an anchor refreshed one full cadence
  // ago must be refetched (the schedule must make progress), and one refreshed moments ago must not
  // (a crashed run must be resumable without paying twice).
  for (const g of GRID_ORDER) {
    const win = freshWindowMs(g);
    const cadence = GRIDS[g].cadenceHours * 3600e3;
    assert.ok(win < cadence, `${g}: window ${win / 3600e3}h >= cadence ${cadence / 3600e3}h — the next scheduled run would skip everything`);
    const isFresh = ageMs => ageMs < win;
    assert.equal(isFresh(60e3), true, `${g}: a re-run one minute later should resume, not refetch`);
    assert.equal(isFresh(cadence), false, `${g}: the next scheduled run must not skip`);
    assert.equal(isFresh(cadence * 0.99), false, `${g}: an early scheduled run must still not skip`);
  }
});

test('resume guard: the two grids disagree about freshness where they should', () => {
  // 12h after a run that touched both grids: the forecast grid is due again, the dense one is not.
  const age = 12 * 3600e3;
  assert.ok(age >= freshWindowMs('forecast'), 'the forecast grid should be due 12h on');
  assert.ok(age < freshWindowMs('past'), 'the dense grid should still be fresh 12h on');
  // A single global window could not express that; this is the bug the split would otherwise cause.
  assert.ok(FRESH_FRACTION > 0 && FRESH_FRACTION < 1, 'FRESH_FRACTION must sit strictly inside a cadence');
});

/* ===================== the seam ===================== */

test('bias: the taper starts at full strength and reaches zero on schedule', () => {
  assert.equal(biasWeight(1), 1, 'the first forecast day should carry the full correction');
  assert.equal(biasWeight(1 + BIAS_TAPER), 0, 'the correction should be gone after the taper');
  for (let k = 1; k <= 8; k++) {
    const w = biasWeight(k);
    assert.ok(w >= 0 && w <= 1, `weight out of range at day ${k}`);
    if (k > 1) assert.ok(w <= biasWeight(k - 1) + 1e-12, `weight increased at day ${k}`);
  }
  assert.ok(biasWeight(BIAS_TAPER) > 0, 'the taper should still be live on its last day');
});

test('bias: a constant offset between the grids is measured exactly', () => {
  const overlap = [];
  for (let i = 0; i < BIAS_WINDOW; i++) {
    const c = { tmax: 18 + i, tmin: 6 + i, p: 4 };
    overlap.push([{ tmax: c.tmax - 2.5, tmin: c.tmin - 1.5, p: c.p * 1.5 }, c]);
  }
  const b = measureBias(overlap);
  assert.equal(b.days, BIAS_WINDOW);
  assert.ok(Math.abs(b.tmax - -2.5) < 1e-9, `tmax offset ${b.tmax}`);
  assert.ok(Math.abs(b.tmin - -1.5) < 1e-9, `tmin offset ${b.tmin}`);
  assert.ok(Math.abs(b.rain - 1.5) < 1e-9, `rain ratio ${b.rain}`);
});

test('seam: correcting a coarse forecast by the measured bias removes the step at today', () => {
  // The failure this guards against: the dense anchor sits 300 m below its 0.2deg parent and reads
  // 2.5 C warmer and 1.5x wetter every day. Join the raw series and today -> tomorrow jumps by that
  // whole offset, which analyze() reads as a real cooling and a real drop in rain.
  const OFFSET = -2.5, RATIO = 1.5;
  const coarseAt = k => ({ tmax: 18, tmin: 6, p: 4 });                       // flat, so any step is ours
  const denseAt = k => ({ tmax: 18 - OFFSET, tmin: 6 + 1.5, p: 4 * RATIO }); // dense reads warmer/wetter

  const overlap = [];
  for (let i = 0; i < BIAS_WINDOW; i++) overlap.push([denseAt(i), coarseAt(i)]);
  const b = measureBias(overlap);

  const today = denseAt(0);
  const corrected = k => {
    const c = coarseAt(k), w = biasWeight(k);
    return { tmax: c.tmax + w * b.tmax, tmin: c.tmin + w * b.tmin, p: c.p * (1 + w * (b.rain - 1)) };
  };

  const rawJump = Math.abs(coarseAt(1).tmax - today.tmax);
  const fixedJump = Math.abs(corrected(1).tmax - today.tmax);
  assert.ok(Math.abs(rawJump - Math.abs(OFFSET)) < 1e-9, 'the raw join should step by the full offset');
  assert.ok(fixedJump < 1e-9, `the corrected join should not step at all, stepped ${fixedJump}`);
  assert.ok(Math.abs(corrected(1).p - today.p) < 1e-9, 'rain should not step at the seam either');

  // and the correction decays rather than persisting to the end of the forecast
  assert.ok(Math.abs(corrected(1).tmax - coarseAt(1).tmax) > 2, 'day 1 should be strongly corrected');
  assert.equal(corrected(1 + BIAS_TAPER).tmax, coarseAt(0).tmax, 'the correction should be gone by the end of the taper');
  assert.equal(corrected(1 + BIAS_TAPER).p, coarseAt(0).p, 'rain correction should be gone too');
});

test('bias: refuses to invent a correction from too little or too dry an overlap', () => {
  const dry = [];
  for (let i = 0; i < BIAS_WINDOW; i++) dry.push([{ tmax: 10, tmin: 2, p: 0.4 }, { tmax: 12, tmin: 3, p: 0.1 }]);
  const b = measureBias(dry);
  assert.equal(b.rain, 1, 'a 4x ratio measured on a tenth of a millimetre must be rejected');
  assert.ok(Math.abs(b.tmax - -2) < 1e-9, 'temperature is still measurable in a dry spell');

  const thin = [[{ tmax: 10, tmin: 2, p: 9 }, { tmax: 20, tmin: 9, p: 1 }]];
  const t = measureBias(thin);
  assert.equal(t.tmax, 0, 'one overlap day is not enough to correct temperature');
  assert.equal(t.rain, 1, 'one overlap day is not enough to correct rain');
  assert.equal(t.days, 1);
});

test('bias: an extreme disagreement is clamped, not propagated', () => {
  const wild = [];
  for (let i = 0; i < BIAS_WINDOW; i++) wild.push([{ tmax: 40, tmin: 30, p: 100 }, { tmax: 0, tmin: -5, p: 1 }]);
  const b = measureBias(wild);
  assert.equal(b.tmax, BIAS_LIMITS.temp, 'a 40 C disagreement must clamp');
  assert.equal(b.rain, BIAS_LIMITS.ratioHi, 'a 100x rain ratio must clamp');
  const inverse = wild.map(([d, c]) => [c, d]);
  assert.equal(measureBias(inverse).tmax, -BIAS_LIMITS.temp);
  assert.equal(measureBias(inverse).rain, BIAS_LIMITS.ratioLo);
});

test('bias: identical grids produce no correction at all', () => {
  const same = [];
  for (let i = 0; i < BIAS_WINDOW; i++) { const r = { tmax: 15 + i, tmin: 5, p: 3 }; same.push([{ ...r }, { ...r }]); }
  const b = measureBias(same);
  assert.equal(b.tmax, 0); assert.equal(b.tmin, 0); assert.equal(b.rain, 1);
});

/* ===================== dates ===================== */

test('dates: addDays crosses a DST boundary without drifting', () => {
  assert.equal(addDays('2026-11-01', 1), '2026-11-02');   // US DST ends Nov 1 2026
  assert.equal(addDays('2026-03-08', 1), '2026-03-09');   // and begins Mar 8 2026
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(dateRange('2026-09-05', '2026-09-08').length, 4);
});

test('dates: the dense grid stops at today and the coarse grid carries the future', () => {
  const denseAxis = dateRange(addDays(TODAY, -PAST_KEEP), TODAY);
  const coarseAxis = dateRange(addDays(TODAY, -PAST_KEEP), addDays(TODAY, FC - 1));
  assert.equal(denseAxis.at(-1), TODAY, 'the dense axis must end at today — it fetches one forecast day');
  assert.equal(coarseAxis.at(-1), addDays(TODAY, FC - 1));
  // the spliced axis the app builds: dense through today, then coarse beyond it
  const spliced = denseAxis.concat(coarseAxis.slice(coarseAxis.indexOf(TODAY) + 1));
  assert.deepEqual(spliced, coarseAxis, 'the splice must reproduce one continuous axis with no gap or repeat');
  assert.equal(spliced.indexOf(TODAY), denseAxis.length - 1, 'today_index must point at the last dense day');
  // and the overlap the bias is measured on is real
  const overlap = denseAxis.filter(d => coarseAxis.includes(d));
  assert.ok(overlap.length >= BIAS_LIMITS.minDays, 'the grids must overlap by enough days to measure a bias');
});

test('fallback: a coarse anchor must be derived from the dense anchor, never from the cell', () => {
  // anchorHit falls back through the coarser strides when a dense anchor has not been backfilled
  // yet. Deriving that fallback by snapping the CELL to the coarse stride is double rounding: the
  // archive's coarse set is the parents of the DENSE anchors, so the two disagree at boundaries and
  // the fallback lands on a coordinate that is not in the file. It cost 2 cells on the coast.
  const fromCell = (lat, lon) => anchorFor(lat, lon, FORECAST_STRIDE);
  const fromDense = (lat, lon) => coarseParent(...anchorFor(lat, lon, PAST_STRIDE));

  // the exact cell that failed, and its neighbour
  assert.notDeepEqual(fromCell(48.36475, -124.7085), fromDense(48.36475, -124.7085),
    'this coordinate used to expose the disagreement — if it no longer does, find one that does');
  assert.deepEqual(fromDense(48.36475, -124.7085), [48.4, -124.6]);
  assert.deepEqual(fromCell(48.36475, -124.7085), [48.4, -124.8]);

  // and the property in general: only the dense-derived parent is guaranteed to be in the fetched set
  const path = new URL('../data/cells.json', import.meta.url);
  if (!fs.existsSync(path)) return;
  const rows = JSON.parse(fs.readFileSync(path, 'utf8')).rows;
  const dense = new Map(), parents = new Set();
  for (const r of rows) { const a = anchorFor(r[0], r[1], PAST_STRIDE); dense.set(anchorKey(a[0], a[1]), a); }
  for (const a of dense.values()) { const p = coarseParent(a[0], a[1]); parents.add(anchorKey(p[0], p[1])); }
  let cellMiss = 0, denseMiss = 0;
  for (const r of rows) {
    const c = fromCell(r[0], r[1]); if (!parents.has(anchorKey(c[0], c[1]))) cellMiss++;
    const d = fromDense(r[0], r[1]); if (!parents.has(anchorKey(d[0], d[1]))) denseMiss++;
  }
  assert.equal(denseMiss, 0, `${denseMiss} cells cannot reach a coarse anchor via their dense anchor`);
  assert.ok(cellMiss > 0, 'snapping the cell directly used to miss; if it no longer does, the trap has moved');
});

test('bias: the temperature clamp is physical — it admits a real elevation offset and still rejects noise', () => {
  // Measured on the live archive: the dense-minus-coarse offset regresses on the lapse-rate
  // prediction with slope 1.293 over 2,683 anchors. It is elevation signal, so the clamp has to scale
  // with the elevation difference or it discards real forecast skill in the mountains.
  const deep = tempLimitFor(426, 1571);      // 1,145 m apart — a real Cascades pairing
  assert.ok(deep > 6, `a 1,145 m gap must admit more than 6 °C, got ${deep}`);
  assert.ok(deep >= 6.5 * 1.145, 'the limit must at least cover the plain lapse-rate prediction');
  assert.equal(tempLimitFor(800, 800), BIAS_TEMP_BASE, 'with no elevation difference the clamp stays tight');
  assert.ok(tempLimitFor(800, 800) < 6, 'and tighter than the old flat limit, since nothing explains an offset');
  assert.equal(tempLimitFor(0, 100000), BIAS_TEMP_MAX, 'an absurd gap still hits the ceiling');
  assert.equal(tempLimitFor(null, 900), BIAS_TEMP_BASE, 'a missing elevation falls back to the tight limit');
  // monotone in the elevation gap
  let prev = -Infinity;
  for (const dz of [0, 200, 500, 1000, 2000, 4000]) { const l = tempLimitFor(0, dz); assert.ok(l >= prev); prev = l; }

  // and it is actually applied: the same overlap clamps differently for flat vs mountainous pairings
  const overlap = [];
  for (let i = 0; i < BIAS_WINDOW; i++) overlap.push([{ tmax: 20, tmin: 8, p: 3 }, { tmax: 12, tmin: 2, p: 3 }]);
  assert.equal(measureBias(overlap, BIAS_LIMITS, tempLimitFor(800, 800)).tmax, BIAS_TEMP_BASE,
    'an 8 °C offset between anchors at the same elevation must be clamped hard');
  assert.equal(measureBias(overlap, BIAS_LIMITS, tempLimitFor(426, 1571)).tmax, 8,
    'the same 8 °C offset across a 1,145 m gap is physical and must survive');
});

/* ===================== the call ledger is per environment ===================== */

test('ledger: the key separates CI from local, and one repo from another', () => {
  assert.equal(envKey({}), 'local');
  assert.equal(envKey({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'misherr/wheretoforage' }), 'ci:misherr/wheretoforage');
  // production and staging are different repos and therefore different runners and quotas
  assert.notEqual(
    envKey({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'misherr/wheretoforage' }),
    envKey({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'misherr/wheretoforage-dev' }));
  // an explicit override wins, so two laptops can be told apart if they ever both build
  assert.equal(envKey({ WEATHER_BUDGET_KEY: 'laptop-2', GITHUB_ACTIONS: 'true' }), 'laptop-2');
  assert.notEqual(envKey({ WEATHER_BUDGET_KEY: 'laptop-2' }), envKey({}));
});

test('ledger: a local run cannot throttle CI — the exact bug this replaced', () => {
  // What happened: a local rebuild spent 1,601 calls, the count went into the committed archive, and
  // the next scheduled run started believing it had only 7,899 of its ceiling left — on a runner IP
  // that had spent nothing at all.
  const today = '2026-09-07';
  const stored = { budgets: { local: { day: today, spent: 1601.2 } } };
  const ci = readLedger(stored, 'ci:misherr/wheretoforage', today);
  assert.equal(ci.slot.spent, 0, 'CI must not inherit a local run\u2019s spend');
  assert.equal(ci.all.local.spent, 1601.2, 'and it must not lose the local slot either');

  // and the reverse: CI spending must not throttle a local rebuild
  const stored2 = { budgets: { 'ci:misherr/wheretoforage': { day: today, spent: 7654 } } };
  assert.equal(readLedger(stored2, 'local', today).slot.spent, 0);
});

test('ledger: a run resumes its own count within the day, and resets across days', () => {
  const key = 'ci:misherr/wheretoforage';
  const same = readLedger({ budgets: { [key]: { day: '2026-09-07', spent: 4200 } } }, key, '2026-09-07');
  assert.equal(same.slot.spent, 4200, 'a second run the same day must resume the count');
  assert.equal(same.note, null);

  const rolled = readLedger({ budgets: { [key]: { day: '2026-09-06', spent: 9400 } } }, key, '2026-09-07');
  assert.equal(rolled.slot.spent, 0, 'the count must reset when the archive timezone day rolls over');
  assert.match(rolled.note, /new day/);
});

test('ledger: writing one environment preserves every other slot', () => {
  const today = '2026-09-07';
  const stored = { budgets: { local: { day: today, spent: 1601.2 }, 'ci:other/repo': { day: '2026-09-01', spent: 42 } } };
  const { all, slot } = readLedger(stored, 'ci:misherr/wheretoforage', today);
  // this is what writeOut serialises
  const written = { ...all, 'ci:misherr/wheretoforage': { day: today, spent: slot.spent + 500 } };
  assert.equal(written.local.spent, 1601.2, 'the local slot was rewritten by a CI run');
  assert.equal(written['ci:other/repo'].spent, 42, 'an unrelated slot was rewritten');
  assert.equal(written['ci:misherr/wheretoforage'].spent, 500);
  assert.equal(Object.keys(written).length, 3);
});

test('ledger: a legacy single-environment budget is discarded, not misattributed', () => {
  // The old format recorded no environment. Adopting it would reintroduce exactly the cross-quota
  // contamination being fixed, and guessing which environment spent it is not possible. Discarding
  // can only cause a run to spend less than its cap allows, never more.
  const today = '2026-09-07';
  const legacy = { budget: { day: today, spent: 1601.2, ceiling: 9500 } };
  const r = readLedger(legacy, 'ci:misherr/wheretoforage', today);
  assert.equal(r.slot.spent, 0, 'a legacy count must not be adopted by whichever environment reads it next');
  assert.deepEqual(r.all, {}, 'and must not be carried forward under a made-up key');
  assert.match(r.note, /legacy/, 'the discard has to be announced, not silent');
});

test('ledger: missing or malformed ledgers degrade to a clean slate', () => {
  const today = '2026-09-07';
  for (const prev of [null, undefined, {}, { budgets: null }, { budgets: 'nonsense' }, { budgets: {} }]) {
    const r = readLedger(prev, 'local', today);
    assert.equal(r.slot.spent, 0);
    assert.equal(r.slot.day, today);
    assert.deepEqual(typeof r.all, 'object');
  }
  // a slot with a junk spend must not produce NaN, which would defeat every affordability check
  const junk = readLedger({ budgets: { local: { day: today, spent: 'lots' } } }, 'local', today);
  assert.equal(junk.slot.spent, 0);
  assert.ok(Number.isFinite(junk.slot.spent));
});
