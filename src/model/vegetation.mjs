/* How good the host trees are, from LANDFIRE cover, height and vegetation type.

   This is the model's species discrimination: a Sitka spruce stand and a logged Douglas-fir
   plantation get the same weather and the same terrain, and this is the only thing that separates
   them. It was inert statewide for a while and nothing looked wrong — see HOST_NO_INFO below.

   The vegetation *name* is read by three separate mechanisms, deliberately kept apart:

     1. NON_HOST_COVER  — what the ground is. A cap, not a host. Bare rock cannot inherit a host
                          score from the word "subalpine" sitting next to it.
     2. HOST_SPECIES    — which trees are named. Sets the value, averaged over every species named,
                          so a mixed type scores toward its weaker member.
     3. HOST_FALLBACK   — "some kind of conifer forest", used only when no species is recognised.

   Those three used to be one ordered list of regexes, first match wins. That conflation produced two
   whole classes of error at once: `North Pacific Alpine and Subalpine Bedrock and Scree` scored 1.0
   because /subalpine/ appears in the true-fir rule and won before /scree/ was reached, and
   `North Pacific Mesic Western Hemlock-Silver Fir Forest` scored 1.0 — identical to pure silver fir —
   because /silver fir/ won before /western hemlock/. Reordering the list cannot fix both; the
   mechanisms are answering different questions and have to be evaluated separately. */
import { clamp, interp, bell } from './util.mjs';

/* ===================== 1. land cover: a cap, never a host =====================

   Every pattern is word-bounded, and that is load-bearing rather than tidiness. Substring matching
   made "Northern Rocky Mountain ..." match /rock/ and "Subalpine ..." match /alpine/ — 63 names in
   the LANDFIRE table, including most of the state's genuine montane conifer forest. Those false
   matches were harmless only for as long as an earlier rule happened to win first, which is not a
   property anyone should be relying on. \b turns them off: "Rocky" is not the word "rock". */
export const NON_HOST_COVER = [
  [/\b(?:open water|water|lake|riverine)\b/i,                                       'open water'],
  [/\b(?:bedrock|scree|talus|rock|cinder|cliff|bluff|barren|badland|playa|dune|beach)\b/i, 'rock, scree or bare ground'],
  [/\b(?:snow|ice|glacier)\b/i,                                                     'snow and ice'],
  [/\balpine\b/i,                                                                   'above treeline'],
  [/\b(?:grassland|meadow|fell-field|steppe|prairie|pasture|hayland|herbaceous)\b/i, 'grass, meadow or herbaceous'],
  [/\b(?:shrubland|dwarf-shrubland|heath|chaparral)\b/i,                            'shrubland'],
  [/\b(?:marsh|wetland|bog|fen|swamp)\b/i,                                          'wetland'],
  /* Plurals and inflections matter here: "Quarries-Strip Mines-Gravel Pits" contains neither the
     word "quarry" nor the word "mine", and scoring a gravel pit as unrecognised-but-plausible
     vegetation is worse than the substring matching this replaced. Word-bounded stems, not words. */
  [/\b(?:developed|urban|agricultur\w*|cropland|crops?|orchards?|vineyards?|quarr\w+|mines?|mining|gravel pits?|road|railroad)\b/i, 'developed or cultivated'],
];

/* Open, discontinuous canopy. 0.3 is not a new number — it is the value the old rule list already
   carried for "open subalpine woodland", kept rather than re-tuned.

   It applies only when the name does not also say "forest". `Subalpine Woodland and Parkland` and
   `Ponderosa Pine Woodland and Savanna` describe genuinely open ground; `Ponderosa Pine Forest and
   Woodland` and `Spruce-Fir Forest and Woodland` are forest/woodland mosaics whose forest half is
   real habitat, and capping those at 0.3 would throw away the host information in the name. Eight
   in-state types are mosaics, ten are open — see the table in CLAUDE.md. */
export const OPEN_CANOPY = /\b(?:woodland|savanna|parkland|krummholz)\b/i;
export const IS_FOREST = /\bforest\b/i;
export const OPEN_CANOPY_CAP = 0.3;

export function coverCap(name) {
  let cap = null, why = '';
  for (const [re, label] of NON_HOST_COVER) {
    if (re.test(name)) { cap = 0; why = label; break; }
  }
  if (cap === null && OPEN_CANOPY.test(name) && !IS_FOREST.test(name)) { cap = OPEN_CANOPY_CAP; why = 'open woodland or parkland'; }
  return cap === null ? null : { cap, why };
}

/* ===================== 2. host species =====================

   One entry per taxon, each with the value that taxon alone would earn. `unless` keeps a generic
   pattern from double-counting a specific one: a name saying "Western Hemlock" must contribute
   hemlock once, not twice.

   Values are the ones the old rule list was tuned to, moved rather than changed — with one
   exception, stated plainly: western red-cedar is 0. Thuja plicata is arbuscular-mycorrhizal, so it
   forms no ectomycorrhiza and cannot host Boletus edulis at all. Its stems are dead space. That is a
   fact about the fungus, not a tuning choice, and it is why a redcedar-hemlock type must score below
   pure hemlock instead of equal to it. */
export const HOST_SPECIES = [
  ['Sitka spruce',        /\bsitka spruce\b/i,                                1.0],
  ['Pacific silver fir',  /\bsilver fir\b/i,                                  1.0],
  ['mountain hemlock',    /\bmountain hemlock\b/i,                            1.0],
  ['subalpine fir',       /\bsubalpine fir\b/i,                               1.0],
  ['noble fir',           /\bnoble fir\b/i,                                   1.0],
  ['red fir',             /\bred fir\b/i,                                     1.0],
  ['Engelmann spruce',    /\bengelmann\b/i,                                   1.0],
  ['spruce-fir',          /\bspruce-fir\b/i,                                  1.0],
  ['grand fir',           /\bgrand fir\b/i,                                   0.8],
  ['white fir',           /\bwhite fir\b/i,                                   0.8],
  ['western white pine',  /\bwestern white pine\b/i,                          0.8],
  ['lodgepole pine',      /\blodgepole\b/i,                                   0.8],
  ['whitebark/limber pine', /\bwhitebark\b|\blimber\b/i,                      0.8],
  ['shore pine',          /\bshore pine\b/i,                                  0.8],
  ['mixed conifer',       /\bmixed[- ]conifer\b|\bmesic[- ]conifer\b/i,       0.8],
  ['western hemlock',     /\bwestern hemlock\b/i,                             0.6],
  ['hemlock',             /\bhemlock\b/i,                                     0.6, /\b(?:western|mountain) hemlock\b/i],
  ['Douglas-fir',         /\bdouglas-fir\b/i,                                 0.45],
  ['ponderosa pine',      /\bponderosa\b/i,                                   0.4],
  ['larch',               /\blarch\b|\btamarack\b/i,                          0.4],
  ['western red-cedar',   /\bred-?cedar\b/i,                                  0.0],
  ['cedar',               /\bcedar\b/i,                                       0.0, /\bred-?cedar\b/i],
  ['juniper',             /\bjuniper\b/i,                                     0.0],
  ['hardwood / riparian', /\bhardwood\b|\boak\b|\baspen\b|\balder\b|\bcottonwood\b|\bmaple\b|\bmadrone\b|\bmahogany\b|\briparian\b|\bdeciduous\b|\bbroadleaf\b|\bwillow\b|\bbirch\b/i, 0.1],
];

/* "Some kind of conifer forest" — no taxon we recognise, but the name says forest. 0.5, as before. */
export const HOST_FALLBACK = [/\bforest\b/i, /\bconifer\b/i, /\bpine\b/i, /\bfir\b/i, /\bspruce\b/i, /\btreed\b/i];

/* Host quality when we have no usable information about the type — either LANDFIRE said nothing at
   all, or it named a type we have no rule for. One constant for both cases, on purpose.

   It used to be two: hostOf() returned 0.3 for an unrecognised name while a missing name scored
   HOST_UNKNOWN = 0.4, so "LANDFIRE said nothing" outranked "LANDFIRE said something we cannot
   interpret" — backwards, since knowing the type is strictly more information. Making it one
   constant means the two cases cannot drift back out of order. It sits below dry pine (0.4) and
   Douglas-fir (0.45): absent information must never outrank known-mediocre. It is a penalty, not an
   estimate.

   Before this was a penalty at all it was 1.0, and while EVT was broken every one of 39,981 forested
   cells was scored as though its host trees were ideal. */
export const HOST_NO_INFO = 0.3;

/* The species named in a type, deduplicated by taxon. */
export function speciesIn(name) {
  const out = [];
  for (const [taxon, re, sc, unless] of HOST_SPECIES) {
    if (!re.test(name)) continue;
    if (unless && unless.test(name)) continue;
    out.push({ taxon, sc });
  }
  return out;
}

/* Host quality of a LANDFIRE vegetation type, by name.

   A type naming several hosts is scored as the mean of them. That is a co-dominance assumption — the
   name tells us which species are present but not in what proportion, so absent better information
   each named species is treated as an equal share of the stand. It is also what makes redcedar bite:
   a redcedar-hemlock type comes out at (0 + 0.6)/2 = 0.3, i.e. the hemlock value scaled by the
   ectomycorrhizal fraction of the stand, which is the quantity that actually matters to a bolete. */
export function hostOf(name) {
  if (!name) return null;
  const cover = coverCap(name);
  const spp = speciesIn(name);
  let sc, lab;
  if (spp.length) {
    sc = spp.reduce((a, s) => a + s.sc, 0) / spp.length;
    lab = spp.length === 1 ? spp[0].taxon : spp.map(s => s.taxon).join(' + ');
  } else if (HOST_FALLBACK.some(re => re.test(name))) {
    sc = 0.5; lab = 'conifer forest';
  } else {
    sc = HOST_NO_INFO; lab = 'unrecognised vegetation';
  }
  if (cover) {
    if (cover.cap < sc) { sc = cover.cap; lab = cover.why; }
    else if (!spp.length) lab = cover.why;
  }
  return { sc: +sc.toFixed(4), lab };
}

/* ===================== 3. stand structure =====================

   One joint factor, replacing an independent fCanopy(c) * fHeight(h) product whose two flat tops
   overlapped into a plateau at 1.0 covering everything from 49 ft and 25% cover upward — 76.7% of
   all forested cells in the state sat on it, which is why stand structure was doing almost no work.
   57 ft second growth at 61% cover scored exactly the same as 200 ft old growth at 55%.

   The shape, and the reason for each number:

   - Nothing under 5 m, whatever the cover. Boletus edulis fruits from established ectomycorrhizal
     root systems; a stand at 16 ft is regenerating clearcut or a thicket and has none worth finding.
   - The height reward keeps climbing to 33 m instead of saturating at 15 m. 33 m is not a guess and
     not the height of real old growth: it is the 99th percentile of LANDFIRE EVH across Washington.
     The dataset tops out at 40 m, so the genuine 60 m Douglas-fir and hemlock this ought to reward
     cannot be expressed in the input at all — see the limitation noted in CLAUDE.md. Calibrating to
     the data's real range is the only honest option; anchoring at 60 m would put the top of the
     scale somewhere no cell can reach.
   - Moderate cover beats both extremes. Kings favour stands with light reaching the floor — road
     cuts, edges, openings under true fir — while a closed canopy suppresses the understorey and
     open ground is not forest.
   - The preferred cover falls and broadens as stands get taller: 44% at 33 m, 60% at 8 m. Wide
     spacing in old growth means large crowns and an extensive root network, so 40% cover at 33 m is
     a cathedral stand while 40% at 8 m is a failed plantation. EVC never exceeds 84% statewide, so
     the dense tail of the curve is largely unreachable and is there for completeness.

   Cover modulates rather than gates (the 0.55 floor): getting the cover wrong should cost a mature
   stand something, not everything, because EVC is a 30 m average over a square mile and a single
   number cannot distinguish an even 60% from a mosaic of gaps and closed patches. */
export const HEIGHT_QUALITY = [[0, 0], [5, 0.06], [8, 0.35], [12, 0.58], [18, 0.78], [25, 0.92], [33, 1.0]];
export const COVER_OPTIMUM = [[8, 60], [15, 56], [25, 48], [33, 44]];
export const COVER_WIDTH = [[8, 17], [15, 20], [25, 26], [33, 30]];
export const COVER_FLOOR = 0.55;

/* Genuinely open cover is a separate question from being off the optimum, and the bell plus the 0.55
   floor cannot express both: with only those, a 25 m stand at 12% cover came out at 0.67 — higher
   than the 0.26 the old fCanopy gave it, which is the wrong direction entirely. Wide spacing in old
   growth is not the same thing as 12% canopy, and the floor's justification (that one EVC number
   cannot distinguish an even 60% from a mosaic of gaps) stops applying once cover is that low.

   So the low end keeps its own ramp. The shape is the old fCanopy's, preserved rather than re-tuned:
   0.15 below 10% cover, rising to full by 25%. */
export const LOW_COVER = [[0, 0.15], [10, 0.15], [25, 1.0], [100, 1.0]];

export function structureFactor(canopy, height) {
  const hq = interp(HEIGHT_QUALITY, height);
  const cq = bell(canopy, interp(COVER_OPTIMUM, height), interp(COVER_WIDTH, height));
  return clamp(hq * interp(LOW_COVER, canopy) * (COVER_FLOOR + (1 - COVER_FLOOR) * cq), 0, 1);
}

/* ===================== the multiplier =====================
   tree cover x stand structure x host quality. The 0.02 floor keeps a cell with real trees from
   collapsing to exactly zero on host alone, so it stays distinguishable from bare ground. */
export function vegMult(v) {
  return v.treeFrac === 0 ? 0
    : clamp(v.treeFrac * structureFactor(v.canopy, v.height)
            * (v.host == null ? HOST_NO_INFO : Math.max(v.host, 0.02)), 0, 1);
}

/* ===================== per-cell summary from LANDFIRE samples =====================

   A sample counts toward the host average when it is a tree, or when its type scores 0 — a bare-rock
   or grassland sample is real evidence about the square mile and has to drag the average down, which
   is precisely what saves a partially-treed subalpine parkland from inheriting a forest score. */
export function vegSummary(evt, evc, evh, evtNames) {
  let n = 0, tree = 0, canopy = 0, ht = 0, host = 0, hn = 0;
  const names = {}, types = [];
  let treeMask = 0;
  for (let k = 0; k < evc.length; k++) {
    n++;
    const c = evc[k], h = evh[k], t = evt[k];
    const isTree = c != null && c >= 101 && c <= 199;
    if (isTree) {
      tree++; treeMask |= 1 << k;
      canopy += c - 100;
      ht += (h != null && h >= 101 && h <= 199) ? h - 100 : (h != null && h >= 1 && h <= 100 ? h : 10);
    }
    const name = evtNames && t != null ? evtNames.get(t) : null;
    types.push(name || null);
    if (name) {
      names[name] = (names[name] || 0) + 1;
      const hs = hostOf(name);
      if (isTree || hs.sc === 0) { host += hs.sc; hn++; }
    }
  }
  if (!n) return null;
  const treeFrac = tree / n, cv = tree ? canopy / tree : 0, hh = tree ? ht / tree : 0, hs = hn ? host / hn : null;
  const top = Object.entries(names).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => ({ name: k, share: v / n, host: hostOf(k) }));
  const v = { treeFrac, canopy: cv, height: hh, host: hs, top, types, treeMask };
  v.mult = vegMult(v);
  return v;
}

/* Host quality from the per-sample types baked into data/cells.json, rather than from the
   pre-averaged value. This is the same arithmetic as vegSummary's loop, and it exists so that
   changing a host rule no longer means re-baking: the app recomputes host at load time from the
   types and the tree flags, which is everything the average depends on. `top` is derived here too,
   which incidentally removes the 3-name truncation — 18.5% of forested cells hold a fourth type that
   the old baked `top` recorded nowhere, and in the worst case that dropped type was Sitka spruce. */
export function hostFromSamples(types, treeMask) {
  let host = 0, hn = 0, n = 0;
  const names = {};
  for (let k = 0; k < types.length; k++) {
    n++;
    const name = types[k];
    if (!name) continue;
    names[name] = (names[name] || 0) + 1;
    const hs = hostOf(name);
    if ((treeMask >> k & 1) || hs.sc === 0) { host += hs.sc; hn++; }
  }
  const top = Object.entries(names).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ name: k, share: v / n, host: hostOf(k) }));
  return { host: hn ? host / hn : null, top };
}
