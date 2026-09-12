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
  assert.deepEqual(AC.decodeModes(row, 47.5, -121.5), { hike: null, worst: null, direct: null, drive: null, bike: null });
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

test('mode: all three are built', () => {
  assert.match(app, /hike:\{label:'Hike',ready:true\}/);
  assert.match(app, /drive:\{label:'Drive',ready:true\}/);
  assert.match(app, /bike:\{label:'Bike',ready:true\}/);
  assert.match(app, /return MODES\[m\]&&MODES\[m\]\.ready\?m:'hike'/, 'a remembered mode that is not built falls back to hike');
  assert.match(app, /const modeFor=view=>view==='top'&&topMode\?topMode:MODE;/, 'Top spots can override the map');
});

test('sheet: the hike figure says what it is — as mapped, with the worst case beside it', () => {
  const block = app.slice(app.indexOf('function hikeBlock'), app.indexOf('let routesFetch'));
  assert.match(block, /AS_MAPPED_NOTE/);
  assert.match(block, /worstBlock\(e,dim,min\)/, 'the worst case, against the minutes just read');
  assert.match(block, /STOP_LABEL\[h\.stop\]/, 'and why the car stopped');
  const worst = app.slice(app.indexOf('function worstBlock'), app.indexOf('function driveBlock'));
  assert.match(worst, /If the gravel is gated/);
  assert.match(worst, /WORST_CASE_NOTE/);
  assert.match(AC.AS_MAPPED_NOTE, /gated six\s+miles short/, 'the Deming case is named, not hidden');
  assert.match(app, /h\+=\(MODE==='drive'\?driveBlock\(e,dim\):MODE==='bike'\?bikeBlock\(e,dim\):hikeBlock\(e,dim\)\);/,
    'the mode on screen decides which figure the sheet leads with');
});

test('sheet: the drive figure names the drive, the walk left, and what it does not know', () => {
  const block = app.slice(app.indexOf('function driveBlock'), app.indexOf('/* The route the hike figure describes'));
  assert.match(block, /driveMinutes\(d\)/, 'the minutes come from the stored metres, not from the bake');
  assert.match(block, /from the nearest paved road/);
  assert.match(block, /DRIVE_CLASS_LABEL\[c\]/, 'and it says how much of the road is what');
  assert.match(block, /STOP_LABEL\[d\.stop\]/, 'why the car stopped');
  assert.match(block, /AS_MAPPED_NOTE/);
  assert.match(block, /DRIVE_NOTE/, 'and what the speeds assume');
  assert.match(block, /worstBlock\(e,dim,travelMinutes\(d\)\)/, 'the worst case is beside the drive too');
  assert.match(AC.DRIVE_NOTE, /35 mph|Snow/, 'the note says what is not in the figure');
});

test('format: the drive columns decode, and no pavement is not no figure', () => {
  const row = new Array(AC.ROW_WIDTH).fill(-1);
  row[AC.DRIVE_AT] = 0; row[AC.DRIVE_AT + 1] = 1609; row[AC.DRIVE_AT + 2] = 3218; row[AC.DRIVE_AT + 3] = 210;
  row[AC.DRIVE_AT + 4] = 800; row[AC.DRIVE_AT + 5] = 40; row[AC.DRIVE_AT + 6] = 300; row[AC.DRIVE_AT + 7] = 25;
  row[AC.DRIVE_AT + 8] = 500; row[AC.DRIVE_AT + 9] = -250; row[AC.DRIVE_AT + 10] = AC.STOP.gate;
  const d = AC.decodeModes(row, 47.5, -121.5).drive;
  assert.ok(d, 'a drive that begins where the pavement ends is still a drive — 0 is not -1');
  assert.equal(d.rough, 3218); assert.equal(d.stop, AC.STOP.gate);
  assert.equal(d.walk.on, 800);
  assert.ok(Math.abs(d.park[0] - (47.5 - 250 / 111320)) < 1e-9, 'the park point is metres north of the centre');
  /* the speeds the user agreed: 35 mph paved, 25 graded, 15 rough */
  assert.deepEqual(AC.DRIVE_MPH, { paved: 35, graded: 25, rough: 15 });
  assert.ok(Math.abs(AC.driveMinutes({ paved: 0, graded: 0, rough: 1609 }) - 4) < 0.05, 'a mile of rough gravel is four minutes');
  assert.ok(Math.abs(AC.driveMinutes(d) - (1609 / (25 * 1609.34 / 60) + 3218 / (15 * 1609.34 / 60))) < 1e-9);
  assert.ok(AC.travelMinutes(d) > AC.driveMinutes(d), 'door to cell is the drive plus the walk');
  assert.equal(AC.driveMetres(d), 4827);
});

test('the edge of the data: a border cell says so, an inland cell never does', () => {
  /* The bake holds Washington's roads only, so a cell near a LAND border can be handed the long way
     round. The coast is not such a border — nothing is missing in the Pacific — and flagging every
     coastal cell would turn the caveat into noise. */
  const idaho = AC.borderDistance(48.4372, -117.0687);          // the state's deepest drive
  assert.equal(idaho.who, 'Idaho');
  assert.ok(idaho.m < 4000, 'and it is two and a half kilometres from the line');
  assert.equal(AC.borderDistance(48.98, -121.0).who, 'British Columbia');
  assert.equal(AC.borderDistance(45.70, -122.60).who, 'Oregon');
  assert.ok(AC.borderDistance(47.62, -122.33).m > 100000, 'Seattle is nowhere near a land border');
  assert.ok(AC.borderDistance(47.30, -124.30).m > 100000, 'and the Pacific coast is not a land border');
  assert.ok(!AC.WA_LAND_BORDER.some(p => p[1] > 46.5 && p[0] < -124),
    'no coastal vertex is in the land border, or every coastal cell reads as doubtful');

  assert.ok(AC.edgeDoubt(48.4372, -117.0687, 56800), '35 miles of driving 2.7 km from Idaho is doubtful');
  assert.equal(AC.edgeDoubt(48.4372, -117.0687, 4000), null, 'two miles of it is not');
  assert.equal(AC.edgeDoubt(47.40, -121.40, 56800), null, 'and an inland cell is never doubtful, however long the figure');
  assert.match(AC.borderNote(AC.edgeDoubt(48.4372, -117.0687, 56800)),
    /Washington's roads only[\s\S]*Idaho/, 'the note names what is missing and whose it is');
  assert.equal(AC.borderNote(null), '', 'and says nothing when there is nothing to say');

  const line = app.slice(app.indexOf('function edgeLine'), app.indexOf('function driveBlock'));
  assert.match(line, /edgeDoubt\(e\.lat,e\.lon,metres\)/, 'measured at the cell, against that figure');
  assert.match(app, /edgeLine\(e,dim,h\.on\+h\.off\)/, 'said on the hike figure');
  assert.match(app, /edgeLine\(e,dim,driveMetres\(d\)\)/, 'on the drive');
  assert.match(app, /edgeLine\(e,dim,W\.on\)/, 'and on the worst case');
  assert.match(app, /if\(edgeSaid\) return '';/, 'said once per sheet, not once per figure');
  assert.match(app, /edgeSaid=false;\s+h\+=\(MODE==='drive'/, 'and reset where the section starts');
});

test('filter: the drive filter counts the drive alone; the sort counts the whole journey', () => {
  const state = app.slice(app.indexOf('const WITHIN='), app.indexOf('const withinOK='));
  assert.match(state, /drive:\[15,30,60,120\]/, 'half an hour of driving is one of the choices');
  assert.match(state, /if\(mode==='drive'\) return M\.drive\?driveMinutes\(M\.drive\):null;/,
    'the filter measures the leg its label names');
  assert.match(state, /if\(mode==='drive'\) return M\.drive\?travelMinutes\(M\.drive\):null;/,
    'and the sort measures the journey');
  assert.match(app, /const accessSort=\(a,b\)=>\{ const ma=rankMinutes\(a,tMode\), mb=rankMinutes\(b,tMode\);/);
  assert.match(app, /within '\+durationLabel\(within\)\+' of driving'/, 'and says so on the pill');
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

test('bike: the speeds, the climb, and what the ride is measured in', () => {
  const per = mph => mph * 1609.34 / 60;
  assert.deepEqual(AC.BIKE_MPH, { road: 12, rough: 8, trail: 5 });
  assert.equal(AC.BIKE_CLIMB_MIN_PER_100M, 8);
  const b = { road: per(12) * 30, rough: 0, trail: 0, up: 0, walk: P(0, 0) };
  assert.ok(Math.abs(AC.rideMinutes(b) - 30) < 1e-6, 'half an hour of road is half an hour');
  assert.ok(Math.abs(AC.rideMinutes({ road: 0, rough: 0, trail: 0, up: 100, walk: P(0, 0) }) - 8) < 1e-6,
    '100 m of climb is eight minutes on a bike, against ten on foot');
  assert.ok(AC.rideMinutes({ road: 1609, rough: 0, trail: 0, up: 0 })
    < AC.rideMinutes({ road: 0, rough: 0, trail: 1609, up: 0 }), 'a road is quicker than a trail');
  /* the whole journey from the car, for the sort and the summary */
  const j = { road: per(12) * 30, rough: 0, trail: 0, up: 0, walk: P(4000, 0) };
  assert.ok(Math.abs(AC.bikeTravelMinutes(j) - 90) < 1e-6, 'ride plus walk, an hour of trail after half an hour of road');
});

test('bike: blocked by wilderness and by a tag — and NOT by a road closed to motor vehicles', () => {
  /* Reversed in v9 at the user's request, on the measurement: a bicycle is not a motor vehicle, and
     riding past a gate is the point of bringing one. The assertion is here so that re-reading the
     original instruction cannot quietly re-tighten it. */
  assert.equal(AC.BIKE_BLOCKS_CLOSED_ROADS, false, 'lifted on purpose in v9 — see ROADMAP.md');
  assert.equal(AC.bikeRestriction({ bicycle: 'no' }), 'no');
  assert.equal(AC.bikeRestriction({ bicycle: 'dismount' }), 'dismount', 'pushing a bike is walking');
  assert.equal(AC.bikeRestriction({ bicycle: 'yes' }), null);
  assert.equal(AC.bikeRestriction({}), null);
  assert.equal(AC.STOP_LABEL[AC.STOP.wilderness], 'from the wilderness boundary, where a bicycle is illegal');
  assert.match(AC.BIKE_PARK_NOTE, /national parks/, 'and the sheet says what the layer does not cover');
});

test('format: the bike columns decode, including where the bike is left', () => {
  const row = new Array(AC.ROW_WIDTH).fill(-1);
  row[AC.BIKE_AT] = 0; row[AC.BIKE_AT + 1] = 6000; row[AC.BIKE_AT + 2] = 1200; row[AC.BIKE_AT + 3] = 300;
  row[AC.BIKE_AT + 4] = 900; row[AC.BIKE_AT + 5] = 60; row[AC.BIKE_AT + 6] = 200; row[AC.BIKE_AT + 7] = 30;
  row[AC.BIKE_AT + 8] = 100; row[AC.BIKE_AT + 9] = 200; row[AC.BIKE_AT + 10] = -400; row[AC.BIKE_AT + 11] = 900;
  row[AC.BIKE_AT + 12] = AC.STOP.closed;
  const b = AC.decodeModes(row, 47.5, -121.5).bike;
  assert.ok(b, 'a ride with no road in it is still a ride — 0 is not -1');
  assert.equal(b.rough, 6000); assert.equal(b.walk.on, 900); assert.equal(b.stop, AC.STOP.closed);
  assert.ok(b.park[1] > -121.5 && b.dismount[1] < -121.5, 'the car east of the centre, the dismount west of it');
  assert.ok(b.dismount[0] > b.park[0], 'and the dismount further north');
  assert.equal(AC.rideMetres(b), 7200);
});

test('sheet: the bike figure names the ride, the walk left, and what the layer does not cover', () => {
  const block = app.slice(app.indexOf('function bikeBlock'), app.indexOf('/* The route the hike figure describes'));
  assert.match(block, /rideMinutes\(b\)/, 'minutes from the stored metres');
  assert.match(block, /BIKE_CLASS_LABEL\[/, 'and what kind of riding it is');
  assert.match(block, /STOP_LABEL\[b\.stop\]/, 'why the ride ended');
  assert.match(block, /BIKE_PARK_NOTE/, 'the national parks are not in the wilderness layer');
  assert.match(block, /BIKE_NOTE/);
  assert.match(block, /AS_MAPPED_NOTE/);
  assert.match(block, /worstBlock\(e,dim,bikeTravelMinutes\(b\)\)/);
  /* the ride is drawn, unlike the drive */
  assert.match(app, /onBike&&R\.byBike\.get\(k\)/, 'the bike has its own line');
  assert.match(app, /Where the car stops and the ride begins/, 'with the car marked where the ride starts');
});
