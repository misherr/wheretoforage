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

/* Everything here is imported from the model itself, never copied in. A second copy of the tuned
   scoring constants would keep passing after the real ones changed, which is the failure this file
   exists to catch. Until the model was extracted into src/model/ these were scraped out of
   index.html by regex to get the same guarantee; the import replaces that. */
import { hostOf, speciesIn, HOST_SPECIES, NON_HOST_COVER, HOST_NO_INFO, OPEN_CANOPY_CAP }
  from '../src/model/vegetation.mjs';

const TABLE = new URL('../data/evt-names.json', import.meta.url);

const load = () => { const j = JSON.parse(fs.readFileSync(TABLE, 'utf8')); return j.names || j; };

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
  const m = load();
  const host = code => hostOf(m[String(code)]);

  // 7036 is the coastal Sitka spruce type — the best king bolete habitat in the state
  assert.equal(host(7036).sc, 1.0, 'Sitka spruce must score full host quality');
  /* 7039 is Douglas-fir/western hemlock — decent, not prime. Asserted relationally rather than as
     an exact number: it is a two-species type, so its value is the mean of its members and moves
     whenever either of them is retuned. What must stay true is that it sits between them. */
  const df = hostOf('North Pacific Douglas-fir Forest').sc;
  const hem = hostOf('North Pacific Western Hemlock Forest').sc;
  assert.ok(host(7039).sc > df && host(7039).sc < hem,
    `Douglas-fir-hemlock (${host(7039).sc}) must sit between Douglas-fir (${df}) and hemlock (${hem})`);
  assert.ok(host(7039).sc < host(7036).sc, 'Douglas-fir-hemlock must rank below Sitka spruce');
  // 9826 is grassland — not forest at all
  assert.equal(host(9826).sc, 0, 'ruderal grassland is not forest');
});

test('rules: every host species is reachable from a real vegetation type', () => {
  // A rule that matches nothing is a rule that silently stopped applying — a renamed LANDFIRE class,
  // or a regex edited past the names it was written for. Nothing else here would notice: hostOf()
  // would quietly fall through and every cell of that type would lose host quality.
  //
  // Host identity is no longer first-match-wins, so reachability means "some name where this taxon
  // actually contributes to the average" rather than "some name this pattern wins on".
  /* LANDFIRE does not name these four anywhere in LF2024. It calls those stands "Spruce-Fir" (6
     names) or "Mixed Conifer" (10 names) instead, so the 1.0 tier is reached through those and
     through silver fir / mountain hemlock / Sitka spruce. The patterns are kept because they are
     correct about the species and would apply the moment a LANDFIRE release names one — but they
     are listed here so the gap is recorded rather than mistaken for coverage. This is the same
     class of limitation as the EVH height ceiling: the model can discriminate only as finely as
     the vegetation data names things. See CLAUDE.md, "What the vegetation data cannot say". */
  const NOT_NAMED_BY_LF2024 = ['subalpine fir', 'noble fir', 'Engelmann spruce', 'grand fir'];

  const names = Object.values(load());
  const dead = [];
  for (const [taxon] of HOST_SPECIES) {
    const reached = names.filter(n => speciesIn(n).some(sp => sp.taxon === taxon)).length;
    if (!reached && !NOT_NAMED_BY_LF2024.includes(taxon)) dead.push(taxon);
  }
  assert.deepEqual(dead, [],
    'these host species match no LANDFIRE type name any more: ' + dead.join(', '));

  // and the other direction: a name that starts appearing must be noticed, not silently absorbed
  const nowNamed = NOT_NAMED_BY_LF2024.filter(t =>
    names.some(n => speciesIn(n).some(sp => sp.taxon === t)));
  assert.deepEqual(nowNamed, [],
    'LANDFIRE now names ' + nowNamed.join(', ') + ' — drop it from NOT_NAMED_BY_LF2024 and re-check ' +
    'whether those stands are still reaching the model through the spruce-fir and mixed-conifer rules');
});

test('rules: every land-cover cap is reachable, and none of them swallows a forest', () => {
  const names = Object.values(load());
  for (const [re, label] of NON_HOST_COVER) {
    const hit = names.filter(n => re.test(n));
    assert.ok(hit.length > 0, `land-cover cap "${label}" (${re}) matches no LANDFIRE type name`);
  }
  // The reason every pattern is word-bounded: substring matching put most of the state's montane
  // conifer forest into the not-forest rule via "Rocky" containing "rock".
  const falsePositives = names.filter(n => {
    const spp = speciesIn(n);
    return hostOf(n).sc === 0 && spp.some(sp => sp.sc >= 0.8) && /\bforest\b/i.test(n);
  });
  assert.deepEqual(falsePositives.filter(n => /^(?:North Pacific|Northern Rocky|East Cascades|Rocky Mountain|Columbia)/.test(n)), [],
    'a Washington forest type naming a strong host must not be capped to zero: ' + falsePositives.join(' | '));
});

test('rules: the three mechanisms stay separate', () => {
  // The bug being prevented: one ordered list conflated land cover, host identity and the generic
  // fallback, so /subalpine/ in the true-fir rule scored bare rock at 1.0 and /silver fir/ scored a
  // hemlock mix as pure silver fir. Reordering cannot fix both — they answer different questions.
  assert.equal(hostOf('North Pacific Alpine and Subalpine Bedrock and Scree').sc, 0,
    'land cover must cap regardless of what host words appear in the name');
  const mix = hostOf('North Pacific Mesic Western Hemlock-Silver Fir Forest').sc;
  const pure = hostOf('North Pacific Mesic Silver Fir Forest').sc;
  assert.ok(mix < pure, 'a mixed type must score below its strongest member');
  assert.ok(mix > hostOf('North Pacific Western Hemlock Forest').sc,
    'and above its weakest — the mean of the species named, not the min');
  assert.equal(hostOf('Some Type With No Recognised Words').sc, HOST_NO_INFO,
    'an unrecognised name falls through to the no-information penalty');
  assert.ok(hostOf('North Pacific Maritime Mesic Subalpine Parkland').sc <= OPEN_CANOPY_CAP,
    'open parkland is capped at the open-canopy value');
});
test('chain: unknown never outranks known-mediocre', () => {
  // The whole point of HOST_NO_INFO. Before it existed, a missing type multiplied by 1.0, so an
  // unmapped cell beat every real forest type in the state including Sitka spruce. It is also the
  // single constant for both absence cases now: an unrecognised name and a missing one score the
  // same, so they cannot drift back out of order the way 0.3 and 0.4 did.
  const unknown = HOST_NO_INFO;
  assert.equal(typeof unknown, 'number', 'HOST_NO_INFO must be a number');
  assert.equal(hostOf('A Type We Have No Rule For').sc, unknown,
    'an unrecognised name must score exactly the no-information penalty, not something else');
  assert.ok(unknown < 1, 'a missing vegetation type must never score as ideal habitat');

  const m = load();
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
