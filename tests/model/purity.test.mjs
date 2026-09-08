// Enforces the rules in src/model/CLAUDE.md, so they are a property of the directory rather than a
// note somebody may or may not read.
//
// Run: node --test tests/model/purity.test.mjs   (npm run test:model runs it)
//
// The model was extracted out of index.html precisely so that an agent changing the science does not
// have to read the application. That only stays true if the science does not quietly grow a
// dependency back on the application: one `document.getElementById` in here and the modules stop
// loading in Node, the fixture suite stops running, and the next regression ships unmeasured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../../src/model/', import.meta.url));
const FILES = fs.readdirSync(DIR).filter(f => f.endsWith('.mjs'));

/* Comments and string literals are prose — verdict() legitimately contains the English words
   "window" and "date". Strip both before looking for the real thing. */
function code(file) {
  return fs.readFileSync(path.join(DIR, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

const BANNED = [
  [/\bdocument\s*[.[]/, 'the DOM (document)'],
  [/\bwindow\s*[.[]/, 'the DOM (window)'],
  [/\bnavigator\s*[.[]/, 'navigator'],
  [/\bfetch\s*\(/, 'fetch'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bL\s*\./, 'Leaflet'],
  [/\b(?:local|session)Storage\b/, 'browser storage'],
  [/\bprocess\s*[.[]/, 'process'],
  [/\brequire\s*\(/, 'require()'],
];

test('purity: no DOM, no network, no map, no storage', () => {
  for (const f of FILES) {
    const s = code(f);
    for (const [re, what] of BANNED) {
      assert.ok(!re.test(s),
        `src/model/${f} references ${what}. The model must run in Node with no browser — see src/model/CLAUDE.md.`);
    }
  }
});

test('purity: deterministic — no clock and no randomness', () => {
  // A model function that reads the clock cannot be tested: the same fixture scores differently in
  // October than in June, and the failure surfaces months later as a flaky test rather than as a bug.
  // Day of year is an argument (habitat(lat,lon,elev,doy)) for exactly this reason.
  for (const f of FILES) {
    const s = code(f);
    assert.ok(!/\bMath\.random\b/.test(s), `src/model/${f} uses Math.random — the model must be deterministic`);
    assert.ok(!/\bDate\.now\b/.test(s), `src/model/${f} reads the clock via Date.now — pass the date in instead`);
    assert.ok(!/\bnew Date\s*\(\s*\)/.test(s),
      `src/model/${f} constructs new Date() with no argument — pass the date in instead`);
  }
});

test('purity: every module imports only from within src/model', () => {
  for (const f of FILES) {
    for (const m of code(f).matchAll(/\bfrom\s+(['"])([^'"]+)\1/g)) {
      const spec = m[2];
      assert.ok(spec.startsWith('./') && !spec.includes('..'),
        `src/model/${f} imports "${spec}" — the model may only depend on itself, not on the app or on packages`);
    }
  }
});

test('purity: every module loads on its own, with no browser and no app around it', async () => {
  // A module that only loads because index.html happens to have run first is not extracted, it is
  // just relocated. Importing each one in isolation is what proves the seam. It also catches a
  // circular import, which in the browser shows up as a blank map rather than as a broken import.
  for (const f of FILES) {
    const m = await import(new URL(f, new URL('../../src/model/', import.meta.url)));
    assert.ok(Object.keys(m).length > 0, `src/model/${f} exports nothing`);
  }
});

test('purity: the same inputs give the same score twice, in either order', async () => {
  // Determinism, checked rather than assumed: evaluating fixtures in a different order must not move
  // a single number. Shared mutable state inside the model would show up here and nowhere else.
  const { habitat } = await import('../../src/model/habitat.mjs');
  const { analyze } = await import('../../src/model/weather-score.mjs');
  const N = 34, at = (f, k) => f(k);
  const w = {
    time: Array.from({ length: N }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`), today: 26, elev: 700,
    p: Array.from({ length: N }, (_, i) => (i === 14 ? 30 : i % 5 === 0 ? 3 : 0)),
    tmax: Array.from({ length: N }, (_, i) => at(k => 17 + 3 * Math.sin(k / 3), i)),
    tmin: Array.from({ length: N }, (_, i) => at(k => 7 + 2 * Math.cos(k / 4), i)),
    et0: Array.from({ length: N }, () => 2.5), snow: Array.from({ length: N }, () => 0),
    rh: Array.from({ length: N }, () => 78),
  };
  const sites = [[47.5, -121.5, 1100, 260], [47.0, -124.0, 40, 300], [48.6, -118.5, 1300, 255]];
  const once = sites.map(([a, b, e, d]) => analyze(w, 26, habitat(a, b, e, d)).score);
  const again = [...sites].reverse().map(([a, b, e, d]) => analyze(w, 26, habitat(a, b, e, d)).score).reverse();
  assert.deepEqual(again, once, 'scores depend on evaluation order — the model is holding state somewhere');
  assert.ok(once.some(s => s > 0), 'the smoke fixture should score above zero somewhere, or it proves nothing');
});
