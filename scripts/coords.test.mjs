/* Tests for src/coords.mjs — the coordinate readout and the paste parser.
   Run: node --test scripts/coords.test.mjs   (npm run test:data runs it)

   The parser's job is to be strict. Every format here is one someone will actually paste: decimal
   degrees from Google Maps or onX, and the degrees-minutes-seconds the iPhone Compass app shows.
   Anything it cannot read must return null, because a pin dropped in the wrong drainage is worse
   than an error message — the user would drive to it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCoords, formatCoords, normalizeCoordText } from '../src/coords.mjs';

const near = (a, b, tol = 1e-5) => Math.abs(a - b) <= tol;
const ok = (input, lat, lon, tol) => {
  const r = parseCoords(input);
  assert.ok(r, `failed to parse ${JSON.stringify(input)}`);
  assert.ok(near(r.lat, lat, tol), `${JSON.stringify(input)}: lat ${r.lat} != ${lat}`);
  assert.ok(near(r.lon, lon, tol), `${JSON.stringify(input)}: lon ${r.lon} != ${lon}`);
};

test('coords: decimal degrees, the form every other app pastes', () => {
  ok('47.45125, -119.93630', 47.45125, -119.9363);
  ok('47.45125,-119.9363', 47.45125, -119.9363);
  ok('47.45125 -119.9363', 47.45125, -119.9363);
  ok('  47.45125 , -119.93630  ', 47.45125, -119.9363);
  ok('47, -119', 47, -119);
});

test('coords: hemisphere letters, before or after, in either order', () => {
  ok('47.45125 N, 119.93630 W', 47.45125, -119.9363);
  ok('N 47.45125, W 119.93630', 47.45125, -119.9363);
  ok('N47.45125 W119.93630', 47.45125, -119.9363);
  /* Letters are an explicit statement of which value is which, so they win over position. Someone
     pasting from a tool that writes longitude first should not end up in the Indian Ocean. */
  ok('W119.9363 N47.45125', 47.45125, -119.9363);
  ok('119.93630 W 47.45125 N', 47.45125, -119.9363);
});

test('coords: the iPhone Compass degrees-minutes-seconds form', () => {
  /* 47 deg 27 min 04 sec = 47 + 27/60 + 4/3600 */
  ok("47°27'04\" N  119°56'11\" W", 47 + 27 / 60 + 4 / 3600, -(119 + 56 / 60 + 11 / 3600));
  ok("46°51'12.3\" N 121°45'37.8\" W", 46 + 51 / 60 + 12.3 / 3600, -(121 + 45 / 60 + 37.8 / 3600));
  const r = parseCoords("47°27'04\" N 119°56'11\" W");
  assert.equal(r.dms, true, 'and it reports that it read a dms form');
  assert.equal(parseCoords('47.45125, -119.9363').dms, false);
});

test('coords: degrees and decimal minutes', () => {
  ok("47° 27.07' N, 119° 56.18' W", 47 + 27.07 / 60, -(119 + 56.18 / 60));
  /* Without symbols the same digits are ambiguous with the pair (47, 27.07), so they are refused
     rather than read as one of the two. Symbols are what make a minutes form unambiguous, and every
     app that emits one includes them. */
  assert.equal(parseCoords('47 27.07 N 119 56.18 W'), null, 'symbol-less minutes are ambiguous');
});

test('coords: the unicode a clipboard actually delivers', () => {
  /* Primes, curly quotes, the masculine ordinal some apps emit for a degree sign, en dashes for
     minus, and non-breaking spaces. Every one of these has to survive a paste. */
  ok('47°27′04″ N 119°56′11″ W', 47 + 27 / 60 + 4 / 3600, -(119 + 56 / 60 + 11 / 3600));
  ok('47º27\'04" N 119º56\'11" W', 47 + 27 / 60 + 4 / 3600, -(119 + 56 / 60 + 11 / 3600));
  ok('47.45125, -119.93630', 47.45125, -119.9363);
  ok('47.45125, −119.93630', 47.45125, -119.9363);
  ok('47.45125, –119.93630', 47.45125, -119.9363);
  assert.equal(normalizeCoordText('47º27′04″'), '47°27\'04"');
});

test('coords: what must NOT parse', () => {
  /* Each of these would otherwise become a marker somewhere, and the user would drive to it. */
  for (const bad of ['', null, undefined, '   ', 'not coordinates', 'Mount Rainier',
                     '47.45125',                       // one number is not a pair
                     '200, 50',                        // no valid assignment: 200 is neither
                     '91, 181',                        // both out of range
                     'N, W']) {
    assert.equal(parseCoords(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
});

test('coords: an unambiguous lon,lat pair is repaired, an ambiguous one is not', () => {
  /* A first value beyond 90 cannot be a latitude, so lon,lat is the only reading. */
  ok('-119.9363, 47.45125', 47.45125, -119.9363);
  /* But two values that are both valid latitudes stay in the conventional order rather than being
     guessed at — 47, -46 is a real place and so is -46, 47. */
  const r = parseCoords('47, -46');
  assert.equal(r.lat, 47);
  assert.equal(r.lon, -46);
});

test('coords: the readout is the form other apps accept', () => {
  /* A minus sign rather than a W: "-119.93630" pastes into Google Maps, onX, Gaia and CalTopo;
     "119.93630 W" does not work reliably in any of them. */
  assert.equal(formatCoords(47.45125, -119.9363), '47.45125, -119.93630');
  assert.equal(formatCoords(47, -119), '47.00000, -119.00000');
  assert.match(formatCoords(47.45125, -119.9363), /^-?\d+\.\d{5}, -?\d+\.\d{5}$/);
  assert.ok(!/[NSEW°'"]/.test(formatCoords(47.45125, -119.9363)), 'no letters, no symbols');
});

test('coords: the readout round-trips through the parser', () => {
  /* The two halves of the feature have to agree, or copying a coordinate out of the app and pasting
     it back in would not return to the same place. */
  for (const [la, lo] of [[47.45125, -119.9363], [46.13175, -121.4985], [48.9, -117.03], [45.5, -124.8]]) {
    const r = parseCoords(formatCoords(la, lo));
    assert.ok(r, 'the app\'s own readout must parse');
    assert.ok(near(r.lat, la), `lat round-trip ${r.lat} != ${la}`);
    assert.ok(near(r.lon, lo), `lon round-trip ${r.lon} != ${lo}`);
  }
});

test('coords: the app uses one parser and one formatter, on both paths', () => {
  /* A tap and a pasted coordinate have to land on the same cell, and the bug this repo has already
     paid for was two paths into showPoint that resolved differently. showAt() is the single
     resolution, and both the map click and the coordinate input must go through it. */
  const app = fs.readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  assert.match(app, /function showAt\(lat,lng\)/, 'the shared resolution must exist');
  const click = app.slice(app.indexOf("map.on('click'"), app.indexOf("map.on('click'") + 400);
  assert.match(click, /showAt\(lat,lng\)/, 'a map tap resolves through showAt');
  const go = app.slice(app.indexOf('function gotoSubmit'), app.indexOf('function gotoSubmit') + 900);
  assert.match(go, /parseCoords\(raw\)/, 'the input uses the shared parser');
  assert.match(go, /showAt\(c\.lat,c\.lon\)/, 'and resolves through the same showAt');
  assert.match(go, /inWA\(c\.lat,c\.lon\)/, 'a coordinate outside Washington is refused, not pinned');
  assert.match(app, /formatCoords\(e\.lat,e\.lon\)/, 'the sheet readout uses the shared formatter');
});

test('coords: the readout says which point it is', () => {
  /* A cell sheet describes a square mile, so its coordinate is the cell centre — up to about 0.7 mi
     from wherever the finger landed. An exact-point sheet is the point itself. Handing over a
     coordinate without saying which one it is would send someone to a spot they did not choose. */
  const app = fs.readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  const at = app.indexOf('id="coord-text"');
  assert.ok(at > 0, 'the readout must exist');
  const block = app.slice(at, at + 600);
  assert.match(block, /e\.exact\?/, 'it has to distinguish an exact point from a cell');
  assert.match(block, /centre of this cell/, 'and name the cell centre as such');
  /* And it must be copyable without the clipboard API, which is unavailable on an insecure origin
     and refused outright by some browsers. */
  assert.match(app, /user-select:all/, 'the readout is selectable by hand as a fallback');
  assert.match(app, /navigator\.clipboard\.writeText/, 'with the clipboard as the fast path');
  assert.match(app, /catch\(_\)\{[\s\S]{0,200}selectNodeContents/,
    'and a fallback that selects the text when the clipboard is refused');
});
