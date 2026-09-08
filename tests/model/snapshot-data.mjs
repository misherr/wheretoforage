// Shared by snapshot.test.mjs (which compares) and update-snapshots.mjs (which rewrites), so the two
// can never compute the recorded values differently.
import { evaluate } from './model.mjs';
import { FIXTURES } from './fixtures.mjs';

/* A spread wide enough that a change to any one part of the model moves at least one row: rain
   history, both temperature kill switches, all three habitat regions, the elevation response, aspect,
   and the full host-quality range including the missing-data case. */
export const SNAPSHOT_FIXTURES = [
  'dry', 'recentHeavyRain', 'midFlush', 'postFlushDecay',
  'hardFrost', 'freshSnow', 'heatOnFlush', 'humid', 'arid',
  'coastalFall', 'lowlandFall', 'eastsideFall',
  'highElevation', 'lowElevation', 'sweetSpot',
  'northAspect', 'southAspect',
  'strongHost', 'mediumHost', 'weakHost', 'douglasFirHost',
  'missingVegData', 'noTreeCover', 'youngPlantation', 'sparseCanopy',
];

const r6 = x => (x == null || !Number.isFinite(x)) ? x : Math.round(x * 1e6) / 1e6;

export function computeSnapshots() {
  const out = {};
  for (const name of SNAPSHOT_FIXTURES) {
    const fx = FIXTURES[name];
    if (!fx) throw new Error(`snapshot fixture "${name}" is not defined in fixtures.mjs`);
    const e = evaluate(fx);
    const n = e.A.now;
    out[name] = {
      score: r6(n.score),
      habitat: r6(e.hab.score),
      vegMult: e.veg ? r6(e.veg.mult) : null,
      // the factors the score is a product of, so a diff points at which term moved
      F: r6(n.F), M: r6(n.M), X: r6(n.X), Hu: r6(n.Hu), K: r6(n.K), C: r6(n.C),
      kill: n.kill ?? null,
      best: r6(e.A.best.score),
    };
  }
  return out;
}
