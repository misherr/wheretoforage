// Rewrites tests/model/snapshots.json from the current model.  Run: npm run snapshots:update
//
// This is the sanctioned way to change those numbers. Run it when you have deliberately retuned the
// model, then READ THE DIFF — every moved value should be one you intended to move. It is not a way
// to make a red suite green: the relational assertions in relational.test.mjs are unaffected by this
// script, and if those are failing, the model is wrong rather than the snapshot being stale.
import fs from 'node:fs';
import { computeSnapshots } from './snapshot-data.mjs';

const FILE = new URL('./snapshots.json', import.meta.url);
const before = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')).fixtures : null;
const fixtures = computeSnapshots();

fs.writeFileSync(FILE, JSON.stringify({
  note: 'Recorded model output. Regenerate deliberately with `npm run snapshots:update` after tuning, then read the diff. See tests/model/snapshot.test.mjs.',
  updated: new Date().toISOString().slice(0, 10),
  fixtures,
}, null, 2) + '\n');

if (!before) {
  console.log(`created snapshots.json with ${Object.keys(fixtures).length} fixtures`);
} else {
  const moved = [];
  for (const [name, cur] of Object.entries(fixtures)) {
    const old = before[name];
    if (!old) { moved.push(`  + ${name} (new)`); continue; }
    for (const k of Object.keys(cur)) {
      if (old[k] !== cur[k]) moved.push(`  ~ ${name}.${k}: ${old[k]} -> ${cur[k]}`);
    }
  }
  for (const name of Object.keys(before)) if (!fixtures[name]) moved.push(`  - ${name} (removed)`);
  console.log(moved.length ? `${moved.length} value(s) changed:\n${moved.join('\n')}` : 'no change');
}
