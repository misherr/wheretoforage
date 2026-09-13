/* Do the documentation's cross-references still point at something?
   Run: node --test scripts/docs-links.test.mjs   (npm run test:data globs it)
 *
 * The docs here are load-bearing rather than decorative: CLAUDE.md's invariants say "read X before
 * changing this area", and several of those pointers are the only warning a future session gets. A
 * dead one is a real defect, and they rot silently — a heading gets reworded and every link to it
 * goes quiet, because nothing renders these files in CI.
 *
 * This was written after consolidating four sections of verification.md, which moved two anchors. It
 * immediately found a third, dead since the commit before: a link built by hand from a heading with
 * an em dash in it. GitHub strips the dash and collapses the surrounding spaces to ONE hyphen, and I
 * had guessed two. Exactly the class of mistake worth spending a test on rather than an eye.
 *
 * One honesty note, in the spirit of the section that prompted this file: `slug()` is a MODEL of
 * GitHub every bit as much as the links are, so asserting it against itself would prove nothing. The
 * evidence that the model is right is the corpus — 35 anchor links written by hand across many
 * sessions, several of them verified by clicking, all resolving under this rule. The unit test below
 * pins the punctuation cases that corpus exercises; it is not the proof. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function markdownFiles() {
  const out = [];
  for (const f of ['CLAUDE.md', 'ROADMAP.md', 'README.md', 'src/model/CLAUDE.md']) {
    if (fs.existsSync(path.join(ROOT, f))) out.push(f);
  }
  const docs = path.join(ROOT, 'docs');
  if (fs.existsSync(docs)) for (const f of fs.readdirSync(docs)) if (f.endsWith('.md')) out.push('docs/' + f);
  return out;
}

/* GitHub's heading slug: lowercase, drop anything that is not word / space / hyphen, spaces to
   hyphens. An em dash vanishes and the spaces around it collapse into a single hyphen. */
const slug = h => h.replace(/^#+\s*/, '').toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

function headings(file) {
  const out = [];
  let inFence = false;
  for (const line of fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (!inFence && /^#{1,6}\s/.test(line)) out.push(slug(line));
  }
  return out;
}

test('docs: the slug rule matches GitHub, including the punctuation that bites', () => {
  assert.equal(slug('## The 30 m grid, measured'), 'the-30-m-grid-measured', 'commas are dropped');
  assert.equal(slug('### QUEUED: the rebuild — fetch first, decide after'),
    'queued-the-rebuild-fetch-first-decide-after',
    'an em dash vanishes and the spaces around it collapse to ONE hyphen, not two');
  assert.equal(slug("## The rider's worst case, checked"), 'the-riders-worst-case-checked',
    'an apostrophe is dropped rather than becoming a hyphen');
  assert.equal(slug('## ~~Done~~ — done in v5'), 'done-done-in-v5',
    'stripped punctuation and the space around it collapse to ONE hyphen — the ROADMAP is full of '
    + 'these struck-through headings and their anchors carry no trace of the dash');
  assert.equal(slug('## A - B'), 'a---b',
    'a hyphen that survives, with spaces either side, is where a run of hyphens really comes from');
  assert.equal(slug('## Four checks that could not have failed'), 'four-checks-that-could-not-have-failed');
});

test('docs: every anchor link resolves to a heading that exists', () => {
  const files = markdownFiles();
  assert.ok(files.length >= 10, 'found ' + files.length + ' markdown files to check');
  const anchors = new Map(files.map(f => [f, new Set(headings(f))]));
  const dead = [];
  let checked = 0;
  for (const f of files) {
    const txt = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of txt.matchAll(/\]\(([^)\s]*?)#([A-Za-z0-9_-]+)\)/g)) {
      const rel = m[1], anchor = m[2].toLowerCase();
      checked++;
      const target = rel === '' ? f : path.posix.normalize(path.posix.join(path.posix.dirname(f), rel));
      if (!anchors.has(target)) { dead.push(f + ' -> ' + rel + '#' + anchor + ' (no such file here)'); continue; }
      if (!anchors.get(target).has(anchor)) dead.push(f + ' -> ' + (rel || '(self)') + '#' + anchor);
    }
  }
  assert.ok(checked >= 30, 'only ' + checked + ' anchor links found — has the link syntax changed?');
  assert.deepEqual(dead, [], 'dead anchor links:\n  ' + dead.join('\n  '));
});

test('docs: the files CLAUDE.md promises exist, and it points at all of them', () => {
  const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  /* every relative markdown link resolves to a file */
  const missing = [];
  for (const m of claude.matchAll(/\]\((?!https?:)([^)#\s]+\.md)/g)) {
    if (!fs.existsSync(path.join(ROOT, m[1]))) missing.push(m[1]);
  }
  assert.deepEqual(missing, [], 'CLAUDE.md links to files that do not exist');
  /* and the docs index at the bottom mentions every doc in docs/ — a doc nothing points at is a doc
     nobody reads, which is how the long-form detail got lost before it was split out */
  const docs = fs.readdirSync(path.join(ROOT, 'docs')).filter(f => f.endsWith('.md'));
  const unlinked = docs.filter(f => !claude.includes(f));
  assert.deepEqual(unlinked, [], 'docs/ files CLAUDE.md never mentions');
});
