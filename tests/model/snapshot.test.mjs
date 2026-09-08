// SNAPSHOT tests — the deliberately brittle half of the suite.
//
// ============================================================================================
//  THESE ARE MEANT TO BE UPDATED WHEN YOU TUNE THE MODEL.  Run:   npm run snapshots:update
//  Then read the diff. Every changed number should be one you meant to change.
//
//  The relational assertions in relational.test.mjs are the opposite: they are NOT to be
//  updated to make a failing model pass. If those break, the model broke.
// ============================================================================================
//
// Why both. Relational tests survive retuning, which is what makes them worth keeping — but it also
// means a change that shifts every score by 15% while preserving every ordering slides straight
// through them. These snapshots exist to make that visible in a diff, nothing more. A failure here is
// a question ("did you mean to move these?"), not a verdict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computeSnapshots, SNAPSHOT_FIXTURES } from './snapshot-data.mjs';

const FILE = new URL('./snapshots.json', import.meta.url);

test('snapshots: recorded scores still match the current model', () => {
  if (!fs.existsSync(FILE)) {
    assert.fail('tests/model/snapshots.json is missing — run `npm run snapshots:update` to create it');
  }
  const recorded = JSON.parse(fs.readFileSync(FILE, 'utf8')).fixtures;
  const current = computeSnapshots();

  const drifted = [];
  for (const name of SNAPSHOT_FIXTURES) {
    const a = recorded[name], b = current[name];
    if (!a) { drifted.push(`${name}: not in the snapshot file (new fixture?)`); continue; }
    for (const k of Object.keys(b)) {
      const x = a[k], y = b[k];
      const same = (typeof x === 'number' && typeof y === 'number') ? Math.abs(x - y) < 1e-9 : x === y;
      if (!same) drifted.push(`${name}.${k}: recorded ${x} -> now ${y}`);
    }
  }

  assert.deepEqual(drifted, [],
    `\n${drifted.length} recorded value(s) moved.\n` +
    `If you meant to change the model, run \`npm run snapshots:update\` and commit the diff.\n` +
    `If you did not, something changed the model by accident.\n`);
});

test('snapshots: the recorded set still covers the model surface', () => {
  // Cheap guard against the file quietly shrinking until it protects nothing.
  const recorded = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.ok(recorded.fixtures, 'snapshot file has no fixtures block');
  assert.equal(Object.keys(recorded.fixtures).length, SNAPSHOT_FIXTURES.length,
    'the snapshot file and SNAPSHOT_FIXTURES disagree on how many fixtures are covered');
  const kills = new Set(Object.values(recorded.fixtures).map(f => f.kill));
  for (const k of ['frost', 'snow', 'heat', null]) {
    assert.ok(kills.has(k), `no snapshot fixture exercises the ${k ?? 'no-kill'} path any more`);
  }
  const scores = Object.values(recorded.fixtures).map(f => f.score);
  assert.ok(Math.max(...scores) > 50, 'no snapshot fixture scores well — the set has lost its high end');
  assert.ok(Math.min(...scores) === 0, 'no snapshot fixture scores zero — the set has lost its floor');
});
