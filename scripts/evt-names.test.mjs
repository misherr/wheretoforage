// Tests for the checked-in LANDFIRE EVT code -> name table.
// Run: node --test scripts/evt-names.test.mjs
//
// Why this file exists. getSamples returns a numeric EVT code and nothing else; every vegetation name
// in the model comes from mapping that code. The mapping used to arrive at runtime in the service's
// legend, where each item carried values:["7039"]. The service changed that field to repeat the class
// name instead, parseInt went NaN on all 831 entries, evtNames came out empty, and — because
// vegFor() gates EVT sampling on `evtNames ? ... : nulls` — EVT was skipped entirely for a full bake
// of 48,032 cells. Nothing failed loudly; host quality simply went missing and every forested cell
// scored as though its trees were ideal.
//
// So the table is checked in, and these tests guard the two things that would silently break it
// again: the file being truncated or reshaped, and the code->name->host chain drifting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TABLE = new URL('../data/evt-names.json', import.meta.url);
const APP = new URL('../index.html', import.meta.url);

const load = () => { const j = JSON.parse(fs.readFileSync(TABLE, 'utf8')); return j.names || j; };

/* HOST_RULES and hostOf are lifted out of index.html rather than copied, so this test cannot drift
   away from the tuned scoring constants it is checking. If the extraction stops matching, that is a
   failure worth seeing — not a reason to paste the rules in here as a second source of truth. */
function appHostOf() {
  const src = fs.readFileSync(APP, 'utf8');
  const rules = /const HOST_RULES=\[[\s\S]*?\n\];/.exec(src);
  const fn = /^function hostOf\(name\)\{.*$/m.exec(src);
  assert.ok(rules, 'could not find HOST_RULES in index.html — extraction needs updating');
  assert.ok(fn, 'could not find hostOf() in index.html — extraction needs updating');
  return new Function(`${rules[0]}\n${fn[0]}\nreturn hostOf;`)();
}

test('table: well-formed, and big enough to be the real thing', () => {
  const raw = JSON.parse(fs.readFileSync(TABLE, 'utf8'));
  assert.ok(raw.source, 'the table must record where it came from');
  assert.ok(raw.names, 'expected a names object');
  const m = load();
  const keys = Object.keys(m);
  assert.ok(keys.length > 500, `only ${keys.length} entries — a truncated table is how this broke before`);
  for (const k of keys.slice(0, 50)) assert.ok(!isNaN(parseInt(k)), `key ${k} is not a numeric code`);
  for (const k of keys) assert.equal(typeof m[k], 'string');
  // the >50 gate in loadEvtNames() must pass for this file
  assert.ok(keys.filter(k => !isNaN(parseInt(k))).length > 50, 'would not pass loadEvtNames() size gate');
});

test('table: the three codes verified against the live service still resolve', () => {
  // Sampled from LF2024_EVT_CONUS getSamples at known Washington points and checked by hand:
  // a west-Cascades forest cell, the outer coast, and a lowland non-forest point.
  const m = load();
  assert.equal(m['7039'], 'North Pacific Maritime Mesic-Wet Douglas-fir-Western Hemlock Forest');
  assert.equal(m['7036'], 'North Pacific Seasonal Sitka Spruce Forest');
  assert.equal(m['9826'], 'Southern Vancouverian Lowland Ruderal Grassland');
});

test('chain: code -> name -> host score behaves for the types that actually matter in Washington', () => {
  const m = load(), hostOf = appHostOf();
  const host = code => hostOf(m[String(code)]);

  // 7036 is the coastal Sitka spruce type — the best king bolete habitat in the state
  assert.equal(host(7036).sc, 1.0, 'Sitka spruce must score full host quality');
  // 7039 is Douglas-fir/western hemlock — decent, not prime, and must rank below Sitka spruce
  assert.equal(host(7039).sc, 0.6, 'Douglas-fir - western hemlock should be moderate');
  assert.ok(host(7039).sc < host(7036).sc, 'Douglas-fir-hemlock must rank below Sitka spruce');
  // 9826 is grassland — not forest at all
  assert.equal(host(9826).sc, 0, 'ruderal grassland is not forest');
});

test('chain: unknown never outranks known-mediocre', () => {
  // The whole point of HOST_UNKNOWN. Before it existed, a missing type multiplied by 1.0, so an
  // unmapped cell beat every real forest type in the state including Sitka spruce.
  const src = fs.readFileSync(APP, 'utf8');
  const mm = /const HOST_UNKNOWN=([\d.]+);/.exec(src);
  assert.ok(mm, 'HOST_UNKNOWN not found in index.html');
  const unknown = parseFloat(mm[1]);
  assert.ok(unknown < 1, 'a missing vegetation type must never score as ideal habitat');

  const m = load(), hostOf = appHostOf();
  const best = hostOf(m['7036']).sc;
  assert.ok(unknown < best, 'unknown must rank below the best real host type');
  // and below a genuinely mediocre but *known* type, which is the failure mode being prevented
  const mediocre = hostOf('North Pacific Maritime Dry-Mesic Douglas-fir-Western Hemlock Forest').sc;
  assert.ok(unknown < mediocre, `unknown (${unknown}) must rank below known Douglas-fir-hemlock (${mediocre})`);
});

test('table: covers the vegetation types the baked cells actually reference', () => {
  // data/cells.json stores type names, not codes, so a name it carries that this table cannot produce
  // would mean the two files were built from different sources.
  const cells = new URL('../data/cells.json', import.meta.url);
  if (!fs.existsSync(cells)) { console.log('  (skipped: data/cells.json not present)'); return; }
  const j = JSON.parse(fs.readFileSync(cells, 'utf8'));
  const names = j.names || [];
  if (!names.length) { console.log('  (skipped: cells.json has no vegetation names baked in)'); return; }
  const known = new Set(Object.values(load()));
  const missing = names.filter(n => !known.has(n));
  assert.deepEqual(missing, [], `cells.json references ${missing.length} type names this table cannot produce`);
  console.log(`  cells.json references ${names.length} distinct types, all present in the table`);
});

test('table: every baked forested cell has a vegetation type', () => {
  // The regression itself: 39,981 forested cells shipped with host -1 and no types at all.
  const cells = new URL('../data/cells.json', import.meta.url);
  if (!fs.existsSync(cells)) { console.log('  (skipped: data/cells.json not present)'); return; }
  const rows = JSON.parse(fs.readFileSync(cells, 'utf8')).rows;
  let forested = 0, noType = 0;
  for (const r of rows) { const v = r[5]; if (!v || v[0] === 0) continue; forested++; if (v[3] < 0 || !v[4] || !v[4].length) noType++; }
  assert.ok(forested > 1000, 'expected a substantial number of forested cells');
  assert.equal(noType, 0, `${noType} of ${forested} forested cells have no vegetation type — EVT is broken again`);
  console.log(`  ${forested.toLocaleString()} forested cells, all with a vegetation type`);
});
