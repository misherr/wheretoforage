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

/* One of the sheet's own functions, extracted and RUNNABLE, with the app's module scope handed in.
   A regex over index.html proves a call is written; it cannot prove the figure that comes out is the
   right one — the same gap as a log line reporting work the code did not do. `MODE` is a parameter
   here because the app reads it as a module-scope variable, and `edgeLine` is stubbed: the border
   note has its own test. */
function sheetBlock(name, MODE) {
  const from = app.indexOf('function ' + name);
  const src = app.slice(from, app.indexOf('\n}', from) + 2);
  const deps = { ...AC, MODE, edgeLine: () => '' };
  const keys = Object.keys(deps).filter(k => /^[A-Za-z_$][\w$]*$/.test(k));
  return new Function(...keys, src + '\nreturn ' + name + ';')(...keys.map(k => deps[k]));
}

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

test('format: the hike row decodes, and a missing figure is null rather than zero', () => {
  const row = [1, 2, ...new Array(AC.MODE_WIDTH.hike - 2).fill(-1)];
  assert.deepEqual(AC.decodeModeRow('hike', row, 47.5, -121.5), { hike: null, direct: null });
  const r2 = [1, 2, 3000, 200, 400, 30, 1000, -2000, AC.STOP.gate, -1, -1, -1, -1];
  assert.equal(r2.length, AC.MODE_WIDTH.hike, 'the width the file is written at');
  const m = AC.decodeModeRow('hike', r2, 47.5, -121.5);
  assert.equal(m.hike.on, 3000); assert.equal(m.hike.stop, AC.STOP.gate);
  assert.equal(m.direct, null);
  assert.ok(Math.abs(m.hike.park[0] - (47.5 - 2000 / 111320)) < 1e-9, 'the park point is metres north of the centre');
  assert.ok(m.hike.park[1] > -121.5, 'and metres east');
  assert.equal(AC.STOP_LABEL[AC.STOP.gate], 'from a mapped gate');
  /* the worst case is in the BASE row, because every mode's block shows it */
  const base = [1, 2, ...new Array(AC.BASE_WIDTH - 2).fill(-1)];
  assert.equal(AC.decodeWorst(base), null);
  base[AC.WORST_AT] = 5000; base[AC.WORST_AT + 1] = 300; base[AC.WORST_AT + 2] = 800; base[AC.WORST_AT + 3] = 60;
  assert.equal(AC.decodeWorst(base).on, 5000);
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

test('mode: all four are built', () => {
  assert.match(app, /hike:\{label:'Hike',ready:true\}/);
  assert.match(app, /drive:\{label:'Drive',ready:true\}/);
  assert.match(app, /bike:\{label:'Bike',ready:true\}/);
  assert.match(app, /moto:\{label:'Dirt bike',ready:true\}/);
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
  assert.match(app, /MODE==='drive'\?driveBlock\(e,dim\):MODE==='bike'\?bikeBlock\(e,dim\)[\s\S]{0,40}MODE==='moto'\?motoBlock\(e,dim\):hikeBlock\(e,dim\)/,
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
  const row = [1, 2, 0, 1609, 3218, 210, 800, 40, 300, 25, 500, -250, AC.STOP.gate];
  assert.equal(row.length, AC.MODE_WIDTH.drive);
  const d = AC.decodeModeRow('drive', row, 47.5, -121.5).drive;
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

test('route: one region is fetched when asked, stamped with the bake, and version-checked', () => {
  const fn = app.slice(app.indexOf('async function loadRouteShard'), app.indexOf('async function drawRoute'));
  assert.match(fn, /routeShardFile\(key\)\+'\?g='\+encodeURIComponent\(accessAsOf\|\|''\)/,
    'the shard the tapped cell is in, stamped with the bake');
  assert.match(fn, /j2\.version!==ACCESS_FORMAT/);
  assert.match(fn, /if\(!r\.ok\) return null;/, 'a region with no routes is an answer, not an error');
  assert.match(fn, /routeShards\.set\(key,p=/, 'and each region is asked for once');
  assert.match(app, /const R=await loadRouteShard\(cell\.lat,cell\.lon\);/);
  assert.match(app, /dr\.onclick=ev=>\{ ev\.preventDefault\(\); dr\.textContent='Loading the route…'; drawRoute\(e,dr\); \}/);
  /* the shard geometry is shared with the bake, like the lattice */
  assert.equal(AC.ROUTE_SHARD, 16);
  assert.equal(AC.routeShardKey(3365, -5704), '210_-357');
  assert.equal(AC.routeShardFile('210_-357'), 'data/access-routes/210_-357.json');
  assert.equal(AC.routeShardKey(3365 + 16, -5704), '211_-357', 'sixteen cells north is the next shard');
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
  const row = [1, 2, 0, 6000, 1200, 300, 900, 60, 200, 30, 100, 200, -400, 900, AC.STOP.closed,
               /* and the mode's own worst case, whose walk here is the same walk */
               0, 9000, 1200, 400, -1, -1, -1, -1, AC.STOP.closed];
  assert.equal(row.length, AC.MODE_WIDTH.bike);
  const b = AC.decodeModeRow('bike', row, 47.5, -121.5).bike;
  assert.ok(b, 'a ride with no road in it is still a ride — 0 is not -1');
  assert.equal(b.rough, 6000); assert.equal(b.walk.on, 900); assert.equal(b.stop, AC.STOP.closed);
  assert.ok(b.park[1] > -121.5 && b.dismount[1] < -121.5, 'the car east of the centre, the dismount west of it');
  assert.ok(b.dismount[0] > b.park[0], 'and the dismount further north');
  assert.equal(AC.rideMetres(b), 7200);
  assert.ok(b.worst, 'and the bound for a gate nobody mapped, which for a bicycle is a ride');
  assert.equal(AC.rideMetres(b.worst), 10200, 'further, because it starts at the pavement');
  assert.equal(b.worst.walk.on, 900, 'the -1 means the same walk as the figure above, not no walk');
  assert.equal(b.worst.walk.offUp, 30);
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

test('moto: the speeds and the climb cost the user agreed', () => {
  const per = mph => mph * 1609.34 / 60;
  assert.deepEqual(AC.MOTO_MPH, { road: 25, rough: 20, trail: 10 });
  assert.equal(AC.MOTO_CLIMB_MIN_PER_100M, 2);
  assert.ok(Math.abs(AC.motoMinutes({ road: per(25) * 30, rough: 0, trail: 0, up: 0 }) - 30) < 1e-6);
  assert.ok(Math.abs(AC.motoMinutes({ road: 0, rough: 0, trail: 0, up: 100 }) - 2) < 1e-6,
    '100 m of climb is two minutes on a motor, against eight on a bicycle and ten on foot');
  /* the user's own case: six miles of gated rough road with 500 m of climb */
  const theirs = AC.motoMinutes({ road: 0, rough: 9656, trail: 0, up: 500 });
  assert.ok(theirs > 25 && theirs < 32, 'about half an hour, against an hour and a half by bicycle: ' + Math.round(theirs));
  assert.ok(AC.motoMinutes({ road: 0, rough: 1609, trail: 0, up: 0 })
    < AC.rideMinutes({ road: 0, rough: 1609, trail: 0, up: 0 }), 'and a motor beats pedals on the same road');
});

test('moto: silence about motorized use means closed, and the sheet says what that leaves out', () => {
  assert.equal(AC.usfsMotoDesignation({ terra_motorized: 'Y' }), 1);
  assert.equal(AC.usfsMotoDesignation({ allowed_terra_use: '4321' }), 1, 'the 4 is the motorcycle');
  assert.equal(AC.usfsMotoDesignation({ allowed_terra_use: '321' }), 0, 'and 321 is hiker, horse, bicycle');
  assert.equal(AC.usfsMotoDesignation({ terra_motorized: 'N' }), 0);
  assert.equal(AC.usfsMotoDesignation({ terra_motorized: 'N/A', allowed_terra_use: 'N/A' }), null,
    'N/A is silence, and silence is neither yes nor no');
  assert.equal(AC.usfsMotoDesignation({}), null);
  assert.equal(AC.motoDesignation({ motorcycle: 'yes' }), 1);
  assert.equal(AC.motoDesignation({ motor_vehicle: 'designated' }), 1);
  assert.equal(AC.motoDesignation({ motor_vehicle: 'no' }), 0);
  assert.equal(AC.motoDesignation({ highway: 'path' }), null, 'an untagged path says nothing');
  /* and what the sheet says about it */
  const note = AC.motoExcludedNote({ designated_mi: 352, undesignated_mi: 5098, nonmotorized_mi: 1935, osm_only_mi: 15510 });
  assert.match(note, /5,098 mi of USFS trail with no designation recorded/);
  assert.match(note, /most likely to be wrong/);
  assert.ok(AC.motoExcludedNote(null).length > 40, 'and it still says something with no figures to hand');
});

test('format: the moto row decodes like the bike row, because the machines record the same things', () => {
  const row = [1, 2, 1000, 8000, 2400, 400, 600, 40, 150, 20, 50, -80, 300, 900, AC.STOP.designation,
               1000, 12000, 2400, 700, 1500, 90, 150, 20, AC.STOP.closed];
  assert.equal(row.length, AC.MODE_WIDTH.moto);
  const m = AC.decodeModeRow('moto', row, 47.5, -121.5).moto;
  assert.equal(m.road, 1000); assert.equal(m.rough, 8000); assert.equal(m.trail, 2400);
  assert.equal(m.walk.on, 600); assert.equal(m.stop, AC.STOP.designation);
  assert.equal(AC.STOP_LABEL[AC.STOP.designation], 'from where the singletrack has no motorized designation recorded');
  assert.equal(AC.STOP_LABEL[AC.STOP.restricted], 'from where motor vehicles are not allowed');
  assert.equal(AC.motoMetres(m), 11400);
  assert.equal(AC.motoMetres(m.worst), 15400);
  assert.equal(m.worst.walk.on, 1500, 'a worst case that ends somewhere else carries its own walk');
  assert.equal(m.worst.stop, AC.STOP.closed, 'and its own reason for stopping');
});

test('sheet: the dirt bike block says the ride, the walk, and what the designation rule excludes', () => {
  const block = app.slice(app.indexOf('function motoBlock'), app.indexOf('/* The route a figure describes'));
  assert.match(block, /motoMinutes\(b\)/, 'minutes from the stored metres');
  assert.match(block, /MOTO_CLASS_LABEL\[/);
  assert.match(block, /STOP_LABEL\[b\.stop\]/, 'why the ride ended');
  assert.match(block, /motoExcludedNote\(STATIC\.access&&STATIC\.access\.excluded&&STATIC\.access\.excluded\.moto\)/,
    'the excluded mileage comes from the bake, not from a constant that can go stale');
  assert.match(block, /MOTO_NOTE/);
  assert.match(block, /AS_MAPPED_NOTE/);
  assert.match(block, /worstBlock\(e,dim,motoTravelMinutes\(b\)\)/);
});

test('files: one per mode, fetched when the mode is on screen', () => {
  assert.deepEqual(AC.MODES_IN_FILE, ['hike', 'drive', 'bike', 'moto']);
  assert.equal(AC.modeFile('moto'), 'data/access-moto.json');
  const fn = app.slice(app.indexOf('function loadMode'), app.indexOf('async function loadAccessGeom'));
  assert.match(fn, /if\(STATIC\.access\.loaded\.has\(mode\)\) return Promise\.resolve\(true\);/, 'asked for once');
  assert.match(fn, /j\.version!==ACCESS_FORMAT/, 'and version-checked on its own');
  assert.match(fn, /Object\.assign\(cur,dec\)/, 'merged into the per-cell object the sheet already holds');
  assert.match(app, /const modeStarted=fetch\(modeFile\(MODE\),\{cache:'no-cache'\}\)/,
    'the mode on screen is fetched alongside the base file, not after it');
  assert.match(app, /await loadMode\(MODE\);/);
  assert.match(app, /topMode=b\.dataset\.tmode\|\|null; await loadMode\(modeFor\('top'\)\);/,
    "and Top spots' override waits for its own file");
});

test('worst case: a walk for the modes a gate strands, a ride for the machines it does not', () => {
  /* Until v10 there was one worst case, the walk from the nearest paved road, shown under all four
     modes. It is the right bound for the hike and for the drive — a closure leaves both on foot at
     the pavement — and it was wrong by an order of magnitude for the two riding modes: at Deming the
     sheet told a rider his own gravel was a 5.5-hour walk. An overstatement is not automatically the
     safe direction. */
  assert.equal(AC.MODE_WIDTH.bike, 24); assert.equal(AC.MODE_WIDTH.moto, 24);
  assert.equal(AC.MODE_WIDTH.hike, 13, 'the hike and the drive still read the base file\'s one walk');
  assert.equal(AC.MODE_WIDTH.drive, 13);
  assert.equal(AC.RIDE_WORST_AT, 15);
  /* the base file still carries the walker's version, for the two modes that need it */
  const base = [1, 2, ...new Array(AC.BASE_WIDTH - 2).fill(-1)];
  base[AC.WORST_AT] = 6000; base[AC.WORST_AT + 1] = 400; base[AC.WORST_AT + 2] = 300; base[AC.WORST_AT + 3] = 60;
  assert.equal(AC.decodeWorst(base).on, 6000);
  /* a rider with nothing to ride from the pavement gets no ride, and the sheet falls back to the walk */
  const row = [1, 2, ...new Array(AC.MODE_WIDTH.moto - 2).fill(-1)];
  row[2] = 0; row[3] = 0; row[4] = 0; row[5] = 0; row[6] = 1200; row[7] = 100; row[8] = 400; row[9] = 50;
  const m = AC.decodeModeRow('moto', row, 47.5, -121.5).moto;
  assert.equal(m.worst, null, 'no columns, no figure — and never a figure invented from the walk');
  assert.match(AC.RIDE_WORST_NOTE, /unloading at the nearest paved road/);
  assert.match(AC.RIDE_WORST_BLOCKED_NOTE, /this is the walk/);
});

test('sheet: the worst case is the ride for a rider and the walk for a walker', () => {
  const fn = app.slice(app.indexOf('function worstBlock'), app.indexOf('/* The edge of the data'));
  assert.match(fn, /RIDE_MODES\.includes\(MODE\)/, 'the riding modes read their own bound');
  assert.match(fn, /R=rider\?M\[MODE\]\.worst:null/, 'out of the mode file, beside the mode figure');
  assert.match(fn, /riding from the nearest paved road/, 'and it says where the ride starts');
  assert.match(fn, /RIDE_WORST_NOTE/);
  assert.match(fn, /The same closure costs a walker/, 'with the walker\'s figure named, since that is the contrast');
  assert.match(fn, /RIDE_WORST_BLOCKED_NOTE/, 'and the walk when nothing rideable leaves the pavement');
  assert.match(fn, /WORST_CASE_NOTE/, 'the hike and the drive keep the walk');
  /* every mode's block still shows it, which is what makes an unmapped gate visible at all */
  for (const m of ['hikeBlock', 'driveBlock', 'bikeBlock', 'motoBlock'])
    assert.match(app.slice(app.indexOf('function ' + m)), /worstBlock\(e,dim,/, m + ' shows the worst case');
});

test('sheet: the gated case is RUN, and a rider is given a ride where a walker is given the walk', () => {
  /* Deming's shape, to scale: ten kilometres of gravel with 600 m of climb, and 640 m off the end of
     it. On foot that is four hours. On the dirt bike in the user's garage it is an hour — and until
     v10 the sheet printed the four hours under the dirt bike, which is not a conservative figure but
     a wrong one, in the single case the mode exists for. */
  const gravel = { on: 9700, onUp: 600, off: 640, offUp: 60 };
  const walk = { on: 0, onUp: 0, off: 640, offUp: 60 };
  const ridden = { road: 0, rough: 9700, trail: 0, up: 600, walk, stop: AC.STOP.end };
  const e = { lat: 48.8, lon: -122.05,
              modes: { worst: gravel, moto: { ...ridden, walk, worst: ridden },
                       bike: { ...ridden, walk, worst: ridden } } };
  const plain = s => s;
  const walked = AC.durationLabel(AC.footMinutes(gravel));
  assert.equal(walked, '4 h', 'the walker\'s bound, for scale');

  const moto = sheetBlock('worstBlock', 'moto')(e, plain, 20);
  assert.match(moto, /riding from the nearest paved road/, 'the rider unloads at the pavement and rides');
  assert.match(moto, new RegExp('<b>' + AC.durationLabel(AC.motoTravelMinutes(ridden)) + '</b>'),
    'and the figure is the ride plus the walk, not the walk');
  assert.ok(AC.motoTravelMinutes(ridden) < AC.footMinutes(gravel) / 3, 'which is a third of the walk or better');
  assert.match(moto, /The same closure costs a walker 4 h/, 'the walker\'s figure is named as the contrast');
  assert.ok(!moto.includes(AC.WORST_CASE_NOTE), 'and the walking note is not what a rider is told');
  assert.match(moto, /Moderate hike/, 'the bucket still describes the walk that is left');

  /* the bicycle is slower over the same gravel, and says so on its own numbers */
  const bike = sheetBlock('worstBlock', 'bike')(e, plain, 20);
  assert.match(bike, new RegExp('<b>' + AC.durationLabel(AC.bikeTravelMinutes(ridden)) + '</b>'));
  assert.ok(AC.bikeTravelMinutes(ridden) > AC.motoTravelMinutes(ridden), 'pedals are slower than a motor');

  /* the hike and the drive still get the walk, out of the base file */
  const hike = sheetBlock('worstBlock', 'hike')(e, plain, 20);
  assert.match(hike, /from the nearest paved road, then/);
  assert.match(hike, /<b>4 h<\/b>/, 'the walker keeps the walker\'s bound');
  assert.ok(hike.includes(AC.WORST_CASE_NOTE));

  /* a rider with nothing rideable leaving the pavement is told the walk, and told why */
  const stuck = { lat: 48.8, lon: -122.05, modes: { worst: gravel, moto: { ...ridden, walk, worst: null } } };
  const none = sheetBlock('worstBlock', 'moto')(stuck, plain, 20);
  assert.match(none, /<b>4 h<\/b>/, 'the walk is the bound when there is nothing to ride');
  assert.ok(none.includes(AC.RIDE_WORST_BLOCKED_NOTE), 'and the sheet says that is why');

  /* and a figure the gate does not change says so rather than repeating itself */
  assert.match(sheetBlock('worstBlock', 'moto')(e, plain, 999), /No different/);
});
