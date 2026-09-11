/* Does `npm test` actually run every test in this repo?

   It did not. `scripts/coords.test.mjs` sat in the tree passing ten assertions for a while without
   ever being executed, because `test:data` named its files one by one and nobody added the new one.
   It was caught only because two mutations that should have failed did not — which is to say, by
   luck, while checking something else. A test that does not run is worse than no test: it looks like
   coverage, it goes green, and it makes the suite less trustworthy rather than more.

   Two defences, and this file is the second one. The npm scripts now glob, so a new file in either
   test directory is picked up with no edit at all. This test covers the case a glob cannot: a test
   file somewhere neither glob looks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP = new Set(['node_modules', '.git', '.github']);

function findTestFiles(dir = ROOT, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findTestFiles(p, out);
    else if (/\.test\.(m?js|cjs)$/.test(e.name)) out.push(path.relative(ROOT, p).replace(/\\/g, '/'));
  }
  return out;
}

/* Which files a `node --test` argument covers. Deliberately narrow: it understands a plain path and
   a single-directory `*.test.mjs` glob, and throws on anything else rather than assuming coverage.
   A pattern this cannot read is a pattern whose coverage nobody has verified. */
function filesCoveredBy(arg) {
  const a = arg.replace(/^["']|["']$/g, '').replace(/\\/g, '/');
  if (!a.includes('*')) {
    const abs = path.join(ROOT, a);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return findTestFiles(abs);
    return [a];
  }
  const m = /^([^*]*\/)?\*\.test\.(m?js|cjs)$/.exec(a);
  if (!m) throw new Error('this test cannot tell what "' + arg + '" covers — teach it, or use a plainer pattern');
  const dir = m[1] || '';
  return findTestFiles(path.join(ROOT, dir)).filter(f => f.startsWith(dir) && !f.slice(dir.length).includes('/'));
}

/* Every `node --test` invocation reachable from `npm test`, following `npm run` chains. */
function testedFiles() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const scripts = pkg.scripts || {};
  const seen = new Set(), files = new Set();
  const walk = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const cmd = scripts[name];
    assert.ok(cmd, `npm script "${name}" is referenced but does not exist`);
    for (const part of cmd.split('&&')) {
      const run = /npm run ([\w:-]+)/.exec(part);
      if (run) { walk(run[1]); continue; }
      const nt = /node\s+--test\s+(.+)$/.exec(part.trim());
      if (!nt) continue;
      for (const arg of nt[1].trim().split(/\s+/)) {
        if (arg.startsWith('--')) continue;
        for (const f of filesCoveredBy(arg)) files.add(f);
      }
    }
  };
  walk('test');
  return files;
}

test('registration: every test file in the repo is executed by npm test', () => {
  const found = findTestFiles().sort();
  const run = testedFiles();
  assert.ok(found.length >= 8, `expected to find the suite, found ${found.length} files`);
  const missed = found.filter(f => !run.has(f));
  assert.deepEqual(missed, [],
    'these test files exist but npm test never runs them:\n  ' + missed.join('\n  ')
    + '\n(npm test covers: ' + [...run].sort().join(', ') + ')');
});

test('registration: npm test names no file that does not exist', () => {
  /* The other direction. A typo in an explicit list fails loudly — node --test exits non-zero on a
     missing file — but a stale entry left behind after a rename would be a confusing red, and this
     says which one it is. */
  for (const f of testedFiles()) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `npm test names ${f}, which does not exist`);
  }
});

test('registration: both halves of the suite are reached, and in order', () => {
  /* CLAUDE.md: the suite has two halves with opposite rules, and the model runs first so a red X
     names which half broke. Globbing must not have quietly merged them into one run. */
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /test:model.*&&.*test:data/, 'model first, then data');
  const model = new Set(filesCoveredBy(/node\s+--test\s+(\S+)/.exec(pkg.scripts['test:model'])[1]));
  const data = new Set(filesCoveredBy(/node\s+--test\s+(\S+)/.exec(pkg.scripts['test:data'])[1]));
  assert.ok(model.size >= 3, 'the model half must cover the model tests');
  assert.ok(data.size >= 5, 'the data half must cover the script tests');
  for (const f of model) assert.ok(!data.has(f), `${f} would run in both halves`);
});

test('registration: the scripts glob, so a new test file needs no edit', () => {
  /* The first defence, and the reason coords.test.mjs was missed: an explicit list is a second place
     to remember. If someone goes back to naming files one at a time, the test above still catches an
     omission — but this one says why not to. */
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const key of ['test:model', 'test:data']) {
    assert.match(pkg.scripts[key], /\*/,
      `${key} should glob rather than list files: a new test file must not need a package.json edit`);
  }
});
