// Loads the ecological model out of index.html so it can be exercised in Node, with no browser and
// no network.
//
// The model functions live inside index.html's single inline <script>, alongside Leaflet setup, DOM
// handlers and fetch calls. Evaluating that script wholesale would need a fake DOM and would kick off
// a statewide load, so instead this pulls out only the declarations the model needs, by name, and
// evaluates those together in one sandbox.
//
// This is deliberately a *reader* of index.html, not a copy of it. Copying the constants into the
// tests would mean the tests keep passing after the model changes underneath them, which is the exact
// failure mode this suite exists to prevent. A later commit is going to extract these into real
// modules; when it does, delete everything above `buildModel` and import them directly.
import fs from 'node:fs';

const APP = new URL('../../index.html', import.meta.url);

/* The model surface, in dependency order (which is also source order in index.html). Asking for a
   name that shares a `const a=1, b=2` line pulls in its neighbours too, which is harmless. */
const WANTED = [
  // constants
  'DLAT', 'LAPSE', 'WA', 'CREST', 'BANDS',
  // numeric helpers
  'clamp', 'lerp', 'interp', 'trap', 'bell',
  // geography + formatting (verdict() needs the formatters)
  'inWA', 'crestLon', 'doyOf', 'localISO', 'fmtDay', 'ft', 'f', 'inch',
  'bandOf', 'colorOf', 'labelOf', 'dist', 'compass',
  // habitat
  'habitat', 'everHabitat',
  // weather score
  'kernel', 'tmaxSuit', 'tminSuit', 'analyze', 'fullAnalysis', 'verdict',
  // fruiting stages
  'stageMix', 'STAGE_KEYS', 'STAGE_LABELS', 'stageBreakdown', 'stageOf',
  // vegetation
  'vegBroken', 'HOST_RULES', 'hostOf', 'fCanopy', 'fHeight', 'HOST_UNKNOWN', 'vegMult', 'vegSummary',
  // terrain + assembly
  'DOY', 'adjustWeather', 'makeEntry', 'applyVeg',
];

function scriptOf(html) {
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('no inline <script> found in index.html');
  return m[1];
}

/* Find every top-level declaration and where it ends.

   index.html declares everything at column 0, so a declaration ends either on its own line (it closes
   with `;` or `}`) or at the next line that *starts* with `}` or `]`. That is a formatting-dependent
   rule, which is why extraction failing is loud: a missing name throws rather than silently producing
   a model with a hole in it. */
function declarations(src) {
  // Split on /\r?\n/, not '\n'. index.html is CRLF in the working tree, and \r is a *line terminator*
  // in JS regex — so `.` will not match it and a `(.+)$` anchor fails on every single line, which
  // silently reduces this extractor to functions-only.
  const lines = src.split(/\r?\n/);
  const decls = new Map();
  const ends = (start) => {
    // `;` or `}` closes the declaration on its own line — allowing for a trailing // comment, which
    // several of these constants carry. Without the comment clause a line like
    // `const DLAT=0.0145, DLON=0.0214, BLK=4; // 1 sq mi cells` reads as unterminated and swallows
    // every declaration after it until the next `}` at column 0.
    const t = lines[start].trimEnd();
    if (/[;}]\s*(?:\/\/.*)?$/.test(t)) return start;
    for (let i = start + 1; i < lines.length; i++) if (/^[}\]]/.test(lines[i])) return i;
    throw new Error(`unterminated declaration at line ${start + 1}: ${lines[start].slice(0, 60)}`);
  };
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    let names = null;
    let m = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(L);
    if (m) names = [m[1]];
    else if ((m = /^(?:const|let|var)\s+(.+)$/.exec(L))) {
      // `const a=1, b=2, c=3;` — take every name declared on the line
      names = [...m[1].matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*=/g)].map(x => x[1]);
      if (!names.length) continue;
    }
    if (!names) continue;
    const end = ends(i);
    for (const n of names) if (!decls.has(n)) decls.set(n, { start: i, end });
    i = end;
  }
  return { lines, decls };
}

function extract() {
  const { lines, decls } = declarations(scriptOf(fs.readFileSync(APP, 'utf8')));
  const missing = WANTED.filter(n => !decls.has(n));
  if (missing.length) {
    throw new Error(
      `index.html no longer declares: ${missing.join(', ')}.\n` +
      `The model was renamed, moved or reformatted. Fix the WANTED list in tests/model/model.mjs — ` +
      `do NOT copy the definitions in here, or these tests stop tracking the real model.`);
  }
  // de-duplicate by line range (shared `const a, b` lines), then emit in source order
  const ranges = [...new Set(WANTED.map(n => { const d = decls.get(n); return d.start + ':' + d.end; }))]
    .map(s => s.split(':').map(Number)).sort((a, b) => a[0] - b[0]);
  let src = ranges.map(([a, b]) => lines.slice(a, b + 1).join('\n')).join('\n');

  // DOY is `const DOY=doyOf(new Date())` — today's date. Tests must pin the day of year or every
  // seasonal assertion becomes a time bomb that fails in a different month.
  const before = src;
  src = src.replace(/^const DOY=/m, 'let DOY=');
  if (src === before) throw new Error('could not make DOY assignable — its declaration changed');
  return src;
}

export function buildModel() {
  const src = extract();
  const factory = new Function(`
    "use strict";
    ${src}
    return {
      ${WANTED.filter(n => n !== 'DOY').join(', ')},
      get DOY(){ return DOY; },
      setDOY(d){ DOY = d; },
      setEvtNames(m){ evtNames = m; },
    };
  `);
  return factory();
}

export const M = buildModel();

/* ===================== fixture -> score, through the real pipeline ===================== */
// This mirrors exactly what loadFromStatic() does per baked cell: makeEntry() builds terrain +
// habitat + weather, then applyVeg() folds in the vegetation multiplier. Running the same two calls
// is what makes these tests about the shipped path rather than about a reimplementation of it.
export function evaluate(fx) {
  M.setDOY(fx.doy);
  const veg = fx.veg ? { ...fx.veg, mult: M.vegMult(fx.veg) } : null;
  const e = M.makeEntry(fx.lat, fx.lon, 0.0145, fx.elev, fx.terr, fx.weather);
  if (veg) { e.veg = veg; M.applyVeg(e); }
  return e;
}

export const scoreOf = fx => evaluate(fx).A.now.score;
export const analysisOf = fx => evaluate(fx).A;
export const habitatOf = fx => evaluate(fx).hab;
