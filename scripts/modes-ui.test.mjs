/* The hike mode, from the stored parts to the words on the sheet.
   Run: node --test scripts/modes-ui.test.mjs   (npm run test:data globs it)

   The arithmetic the user agreed — brush at three times trail, bushwhack past 800 m — lives in one
   place, src/access.mjs, and the app computes minutes and buckets from stored parts, so a threshold
   can move without a re-bake. And the filters: off by default, never touching a score, and always
   saying how many cells they hide. That is what the amended hard rule 8 allows, and no more. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as AC from '../src/access.mjs';

const read = rel => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const app = read('../index.html');
const P = (on, off, onUp = 0, offUp = 0) => ({ on, off, onUp, offUp });

test('effort: brush is three times trail, climb off trail twice as dear', () => {
  assert.equal(Math.round(AC.footMinutes(P(4000, 0))), 60, '4 km of trail is an hour');
  assert.equal(Math.round(AC.footMinutes(P(0, 0, 100))), 10, '100 m of climb is ten minutes');
  assert.equal(Math.round(AC.footMinutes(P(0, 4000 / 3))), 60, 'a third of that off trail is an hour');
  assert.equal(Math.round(AC.footMinutes(P(0, 0, 0, 100))), 20, 'and climbing off trail costs double');
  /* the user's Deming day for scale: 6 mi and 2,000 ft, much of it off trail, in 6.5 h */
  const deming = AC.footMinutes(P(6437, 3219, 300, 310));
  assert.ok(deming > 300 && deming < 420, 'four miles of trail and two of brush is about the day they had: ' + Math.round(deming));
});

test('buckets: the thresholds, and bushwhack decided by the off-trail leg alone', () => {
  const key = p => AC.bucketOf(p).key;
  assert.equal(key(P(500, 50)), 'drive', 'ten minutes or less');
  assert.equal(key(P(1600, 100)), 'easy');
  assert.equal(key(P(6000, 200)), 'moderate');
  assert.equal(key(P(9000, 200)), 'long');
  assert.equal(key(P(0, AC.BUSHWHACK_M + 1)), 'bushwhack', 'a short time does not rescue a long off-trail leg');
  assert.equal(key(P(0, AC.BUSHWHACK_M)), 'moderate', 'exactly the limit is not a bushwhack');
  assert.equal(AC.BUSHWHACK_M, 800, 'the agreed default — and one constant, so it can be revisited');
  assert.deepEqual(AC.BUCKETS.map(b => b.label), ['Drive-up', 'Easy walk', 'Moderate hike', 'Long approach', 'Bushwhack']);
});

test('buckets: the app computes them from parts, so nothing baked can disagree with the constants', () => {
  assert.match(app, /bucketOf\(h\)/, 'the sheet asks src/access.mjs for the bucket');
  assert.match(app, /footMinutes\(h\)/, 'and for the minutes');
  assert.ok(!/maxMin|<=\s*120\b|800/.test(app.slice(app.indexOf('function hikeBlock'), app.indexOf('function hikeBlock') + 2500)),
    'no threshold is written into the sheet itself');
});

test('duration: coarse, because the model is', () => {
  assert.equal(AC.durationLabel(7), '5 min');
  assert.equal(AC.durationLabel(27), '25 min');
  assert.equal(AC.durationLabel(90), '1.5 h');
  assert.equal(AC.durationLabel(700), '12 h');
});

test('format: the mode columns decode, and a missing figure is null rather than zero', () => {
  const row = new Array(AC.ROW_WIDTH).fill(-1);
  assert.deepEqual(AC.decodeModes(row, 47.5, -121.5), { hike: null, worst: null, direct: null });
  row[AC.HIKE_AT] = 3000; row[AC.HIKE_AT + 1] = 200; row[AC.HIKE_AT + 2] = 400; row[AC.HIKE_AT + 3] = 30;
  row[AC.HIKE_AT + 4] = 1000; row[AC.HIKE_AT + 5] = -2000; row[AC.HIKE_AT + 6] = AC.STOP.gate;
  const m = AC.decodeModes(row, 47.5, -121.5);
  assert.equal(m.hike.on, 3000); assert.equal(m.hike.stop, AC.STOP.gate);
  assert.ok(Math.abs(m.hike.park[0] - (47.5 - 2000 / 111320)) < 1e-9, 'the park point is metres north of the centre');
  assert.ok(m.hike.park[1] > -121.5, 'and metres east');
  assert.equal(AC.STOP_LABEL[AC.STOP.gate], 'from a mapped gate');
});

test('filters: off by default, on the map and in Top spots', () => {
  assert.match(app, /let mapWithin=null, topWithin=null;/, 'both start off');
  assert.match(app, /<option value="">at any distance<\/option>/, 'the map menu offers "any distance" first');
  assert.ok(!/localStorage\.setItem\('bolete\.within/.test(app), 'and a filter is never remembered into a later visit');
});

test('filters: they hide a cell by not drawing it, and never touch its score', () => {
  const draw = app.slice(app.indexOf('const CellCanvas='), app.indexOf('const cellLayer='));
  assert.match(draw, /if\(mapWithin!=null&&!withinOK\(e,MODE,mapWithin\)\) continue;/, 'a skipped draw');
  for (const m of app.matchAll(/withinOK\([^)]*\)/g)) assert.ok(!/score\s*=/.test(m[0]));
  assert.ok(!/\.score\s*=/.test(app.slice(app.indexOf('const MODES='), app.indexOf('const scoredPool='))),
    'the filter code assigns no score');
});

test('filters: they say how many cells they hide, and that unmapped is not unreachable', () => {
  assert.match(app, /hiddenNote\(filterCounts\(scoredPool\(\),MODE,mapWithin\),MODE,mapWithin\)/, 'the map legend states it');
  assert.match(app, /hiddenNote\(counts,tMode,topWithin\)/, 'Top spots states it');
  assert.match(app, /which means unmapped, not unreachable/);
  assert.match(app, /never changes a score/);
});

test('mode: hike is the default and the only one built; drive and bike say they are coming', () => {
  assert.match(app, /hike:\{label:'Hike',ready:true\}/);
  assert.match(app, /drive:\{label:'Drive',ready:false/);
  assert.match(app, /bike:\{label:'Bike',ready:false/);
  assert.match(app, /return MODES\[m\]&&MODES\[m\]\.ready\?m:'hike'/, 'a remembered mode that is not built falls back to hike');
  assert.match(app, /const modeFor=view=>view==='top'&&topMode\?topMode:MODE;/, 'Top spots can override the map');
});

test('sheet: the hike figure says what it is — as mapped, with the worst case beside it', () => {
  const block = app.slice(app.indexOf('function hikeBlock'), app.indexOf('let routesFetch'));
  assert.match(block, /AS_MAPPED_NOTE/);
  assert.match(block, /If the gravel is gated/);
  assert.match(block, /WORST_CASE_NOTE/);
  assert.match(block, /STOP_LABEL\[h\.stop\]/, 'and why the car stopped');
  assert.match(AC.AS_MAPPED_NOTE, /gated six\s+miles short/, 'the Deming case is named, not hidden');
  assert.match(app, /h\+=hikeBlock\(e,dim\);/, 'rendered in the Getting there section');
});

test('route: its file is fetched only when asked, stamped with the bake, and version-checked', () => {
  const fn = app.slice(app.indexOf('async function loadAccessRoutes'), app.indexOf('async function drawRoute'));
  assert.match(fn, /data\/access-routes\.json\?g='\+encodeURIComponent\(accessAsOf\|\|''\)/);
  assert.match(fn, /j\.version!==ACCESS_FORMAT/);
  assert.match(app, /dr\.onclick=ev=>\{ ev\.preventDefault\(\); dr\.textContent='Loading the route…'; drawRoute\(e,dr\); \}/);
});

test('entries: modes come from the containing cell, in the one place entries get access', () => {
  assert.match(app, /const withAccess=e=>\{[^\n]*e\.modes=accessAt\(STATIC\.access&&STATIC\.access\.modes,e\.lat,e\.lon\)/);
});

test('rule 8: the amendment is recorded, with its reason', () => {
  const claude = read('../CLAUDE.md');
  assert.match(claude, /explicit, counted and off by default/);
  assert.match(claude, /silently/);
});
