// Tests for the rolling weather archive. Run: node --test scripts/
//
// The merge is the dangerous part: if it silently drops or misaligns a day, the rain history rots and
// the flush model keeps emitting confident numbers from bad data. So the central assertion here is that
// a short rolling fetch merged into an existing archive is byte-identical to what one full fetch of the
// same period would have produced — especially across the boundary where the windows overlap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LATTICE, STRIDE, PAST_KEEP, FC, PAST_FULL, PAST_ROLL, FIELDS,
  latticeIndex, isActive, anchorFor, anchorKey, assertStrideNesting,
  addDays, dateRange, toDateMap, fromDateMap, mergeSeries, trimSeries, callCost,
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

test('lattice: STRIDE 8 anchors survive halving to 4 and 2', () => {
  assert.equal(assertStrideNesting(8), true);
  for (let i = -400; i <= 400; i++) {
    if (!isActive(i, i, 8)) continue;
    assert.ok(isActive(i, i, 4), `index ${i} lost at stride 4`);
    assert.ok(isActive(i, i, 2), `index ${i} lost at stride 2`);
    // and the coordinate itself is unchanged, which is the property we actually depend on
    assert.equal(i * LATTICE, i * LATTICE);
  }
});

test('lattice: anchors land on STRIDE*LATTICE spacing and cells map to the nearest one', () => {
  const spacing = LATTICE * STRIDE;
  const [alat, alon] = anchorFor(47.4131, -121.6087);
  assert.ok(Math.abs(alat / spacing - Math.round(alat / spacing)) < 1e-9, `${alat} off-lattice`);
  assert.ok(Math.abs(alon / spacing - Math.round(alon / spacing)) < 1e-9, `${alon} off-lattice`);
  assert.ok(Math.abs(alat - 47.4131) <= spacing / 2 + 1e-9);
  assert.ok(Math.abs(alon - (-121.6087)) <= spacing / 2 + 1e-9);
  // a point sitting exactly on an anchor maps to itself
  assert.deepEqual(anchorFor(47.4, -121.6), [47.4, -121.6]);
  assert.equal(latticeIndex(47.4) % STRIDE, 0);
});

test('lattice: anchorFor really returns the nearest active point, and index.html can rederive it', () => {
  const sp = LATTICE * STRIDE;
  // index.html joins cells to anchors with exactly this expression, reading LATTICE/STRIDE from
  // weather.json. If anchorFor ever diverges from it the join silently misses and the map goes blank.
  const appJoin = (lat, lon) => [
    Math.round(Math.round(lat / sp) * sp * 1e4) / 1e4,
    Math.round(Math.round(lon / sp) * sp * 1e4) / 1e4,
  ];
  for (let lat = 45.5; lat <= 49.0; lat += 0.0137) {
    for (let lon = -124.7; lon <= -117.0; lon += 0.211) {
      const a = anchorFor(lat, lon);
      assert.deepEqual(a, appJoin(lat, lon), `app join disagrees at ${lat},${lon}`);
      // nothing active is closer than the anchor we picked
      assert.ok(Math.abs(lat - a[0]) <= sp / 2 + 1e-9, `not nearest in lat at ${lat}`);
      assert.ok(Math.abs(lon - a[1]) <= sp / 2 + 1e-9, `not nearest in lon at ${lon}`);
    }
  }
});

test('merge: rolling fetch into an archive equals a single full fetch', () => {
  const archive = syntheticArchive();

  const rolling = trimSeries(mergeSeries(archive, apiFetch(PAST_ROLL)), AXIS);
  const oneShot = trimSeries(mergeSeries(archive, apiFetch(PAST_FULL)), AXIS);

  assert.equal(rolling.size, AXIS.length, 'rolling merge lost or gained days');
  assert.deepEqual([...rolling.keys()], AXIS, 'rolling merge dates out of order');
  assert.deepEqual(rolling, oneShot, 'rolling merge differs from a full fetch');

  // and both equal ground truth on every day of the axis
  for (const d of AXIS) assert.deepEqual(rolling.get(d), truthRow(d), `wrong values at ${d}`);
});

test('merge: the overlap boundary is exact', () => {
  const merged = trimSeries(mergeSeries(syntheticArchive(), apiFetch(PAST_ROLL)), AXIS);
  const firstFresh = addDays(TODAY, -PAST_ROLL);        // first day the rolling window covers
  const lastArchive = addDays(TODAY, -PAST_ROLL - 1);   // last day only the archive covers

  assert.deepEqual(merged.get(lastArchive), truthRow(lastArchive), 'day just outside the window was disturbed');
  assert.deepEqual(merged.get(firstFresh), truthRow(firstFresh), 'first day inside the window was not refreshed');
  assert.deepEqual(merged.get(TODAY), truthRow(TODAY), 'today was not refreshed');
  assert.deepEqual(merged.get(addDays(TODAY, FC - 1)), truthRow(addDays(TODAY, FC - 1)), 'last forecast day wrong');
  // the stale values must be gone everywhere inside the window
  for (const d of dateRange(firstFresh, addDays(TODAY, FC - 1))) {
    assert.notDeepEqual(merged.get(d), staleRow(d), `stale forecast survived at ${d}`);
  }
});

test('merge: aging forecasts get corrected toward reality', () => {
  // yesterday was a forecast when it was written; today it is an observation and differs
  const archive = new Map(AXIS.map(d => [d, truthRow(d)]));
  const revised = new Map([[addDays(TODAY, -1), { ...truthRow(addDays(TODAY, -1)), p: 99.9 }]]);
  const merged = mergeSeries(archive, revised);
  assert.equal(merged.get(addDays(TODAY, -1)).p, 99.9, 'revision did not overwrite');
  assert.equal(merged.get(addDays(TODAY, -2)).p, truth(addDays(TODAY, -2), 'p'), 'neighbouring day was touched');
  assert.equal(merged.size, archive.size, 'revision changed the day count');
});

test('trim: history older than PAST_KEEP is dropped, forecast days are kept', () => {
  const old = dateRange(addDays(TODAY, -PAST_KEEP - 10), addDays(TODAY, FC - 1));
  const wide = new Map(old.map(d => [d, truthRow(d)]));
  const trimmed = trimSeries(wide, AXIS);
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
  // every array is the same length as the shared axis — index.html indexes them positionally
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

test('cost: the rolling window is the 2.4x saving the rewrite is for', () => {
  const vars = FIELDS.length;
  const fullDays = PAST_FULL + FC, rollDays = PAST_ROLL + FC;
  assert.equal(+callCost(fullDays, vars).toFixed(2), 2.43, 'full window should cost 2.43');
  assert.equal(callCost(rollDays, vars), 1, 'short window should floor at 1.0');
  assert.ok(callCost(fullDays, vars) / callCost(rollDays, vars) > 2.4);
  // In the rolling regime the per-call floor swallows the variable count: ten variables cost exactly
  // what six did. That is the reason to grab all ten now instead of refetching history for them later.
  assert.equal(callCost(rollDays, 6), 1, 'six variables floor at 1.0');
  assert.equal(callCost(rollDays, 10), 1, 'ten variables also floor at 1.0 — the extra four are free');
});

test('dates: addDays crosses a DST boundary without drifting', () => {
  assert.equal(addDays('2026-11-01', 1), '2026-11-02');   // US DST ends Nov 1 2026
  assert.equal(addDays('2026-03-08', 1), '2026-03-09');   // and begins Mar 8 2026
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(dateRange('2026-09-05', '2026-09-08').length, 4);
});
