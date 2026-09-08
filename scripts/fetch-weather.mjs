// Two-grid rolling weather archive for data/weather.json, built from the anchors implied by data/cells.json.
// Run on a schedule by .github/workflows/weather.yml. Node 20+, no dependencies.
//
// Why two grids: rain and temperature that already fell are worth resolving precisely; an 8-day
// forecast is a guess and does not deserve the same spend. So we run
//
//   past     stride 2 (0.05deg, ~6,700 anchors)  past_days=3  forecast_days=1   once daily
//   forecast stride 8 (0.2deg,  ~500 anchors)    past_days=1  forecast_days=8   twice daily
//
// Open-Meteo bills each location as max(1, days/14 x variables/10). Both windows are far under 14
// days, so both floor at 1.0 call per location and cost is purely anchor count. Because the variable
// count is free at that floor, the dense grid carries every variable, not just precipitation — past
// temperature matters as much as past rain, since the standard lapse rate assumes a well-mixed
// atmosphere and PNW autumn inversions routinely invert its sign.
//
// Both grids sit on the same lattice and stride 8 is a multiple of stride 2, so every coarse anchor
// is also a dense anchor and keeps whatever history it has accumulated.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ===================== lattice ===================== */
// Anchors live on a fixed lattice of LATTICE-degree steps. A lattice point (i,j) is an *active*
// anchor of a grid only when i % stride === 0 && j % stride === 0, and its coordinates are
// (i*LATTICE, j*LATTICE).
//
// The point of this scheme: halving a stride must preserve every existing anchor position, so we can
// densify without refetching history for the anchors we already have. That holds because an anchor's
// coordinate depends only on its lattice index i, and activity is i % stride === 0:
//   stride 8 -> 4: i % 8 === 0 implies i % 4 === 0, so every 0.2-degree anchor is still active at 0.1.
//   stride 4 -> 2: i % 4 === 0 implies i % 2 === 0, so every 0.1-degree anchor is still active at 0.05.
// Verified by assertStrideNesting() below and by the unit test. It only holds while the lattice origin
// stays 0 and each new stride divides the previous one, so halve - never rescale.
export const LATTICE = 0.025;
export const PAST_STRIDE = 2;       // dense past grid: 0.05deg, near HRRR's 3km native resolution
export const FORECAST_STRIDE = 8;   // coarse forecast grid: 0.2deg, the original anchor set

export const PAST_KEEP = 30;   // past days retained in the archive (model needs 26; 30 gives headroom)
export const FC = 8;           // forecast days on the coarse grid, counting today
export const PAST_FULL = 26;   // past window when an anchor has no history yet
export const PAST_ROLL = 3;    // past window when a dense anchor already has history

// Each grid's own fetch window and cadence. `cadenceHours` is how often the workflow runs that grid;
// the resume guard derives its freshness window from it (see freshWindowMs), so the two grids can
// never disagree about what "already refreshed" means the way one global 5h constant did.
export const GRIDS = {
  past:     { stride: PAST_STRIDE,     past: PAST_ROLL, fc: 1,  cadenceHours: 24, label: 'dense past' },
  forecast: { stride: FORECAST_STRIDE, past: 1,         fc: FC, cadenceHours: 12, label: 'coarse forecast' },
};
export const GRID_ORDER = ['forecast', 'past'];   // priority: the user-facing forecast is cheap, never starve it

const BATCH = 50;              // anchors per request
const GAP = 8000;              // ms between batches (stay under the per-minute limit)
const REQ_TIMEOUT = 45000;     // ms per attempt
const ATTEMPTS = 8;
const TZ = 'America/Los_Angeles';

const CELLS_FILE = process.env.CELLS_FILE || 'data/cells.json';
const WEATHER_FILE = process.env.WEATHER_FILE || 'data/weather.json';

// Which grids this invocation runs. The workflow passes GRIDS=forecast on the off-cycle run and
// GRIDS=past,forecast on the daily one.
const WANT = (process.env.GRIDS || 'past,forecast').split(',').map(s => s.trim()).filter(Boolean);

/* ===================== call budget ===================== */
// Open-Meteo's free tier is 10,000 calls/day and 300,000/month (exactly 30x, so there is no monthly
// headroom to borrow against a busy day). Steady state here is ~7,650/day. The one-off stride-2
// backfill is ~7,700 calls on top of that, which does not fit in a single day — so a run stops
// cleanly at the ceiling and the next run resumes from the checkpoint rather than failing.
export const DAILY_CEILING = Number(process.env.DAILY_CALL_CEILING || 9500);
// Open-Meteo's free tier is rate-limited by IP, so a GitHub runner and a laptop draw on completely
// separate quotas. The ledger therefore has to be keyed by where the run happened, or the two
// environments corrupt each other's counts: a local rebuild that spent 1,601 calls left the next
// scheduled run believing it had only 7,899 of its ceiling left, on an IP that had spent nothing.
//
// It still lives inside data/weather.json rather than a sidecar, and that is deliberate: GitHub
// runners are ephemeral, so the committed artifact is the only state two scheduled runs share. A
// gitignored file would be cleaner locally and useless in CI, which is where the ledger actually
// does its job.
//
// Known conservatism, left alone on purpose: GitHub-hosted runners get a fresh IP per job, so two CI
// runs are not really sharing a quota either. Carrying the count between them spends less than the
// cap allows rather than more, which is the safe direction, and the whole budget model in CLAUDE.md
// is written around one shared daily figure. Do not "fix" that without re-costing the schedule.
export function envKey(env = process.env) {
  if (env.WEATHER_BUDGET_KEY) return env.WEATHER_BUDGET_KEY;          // explicit override
  if (env.GITHUB_ACTIONS === 'true') return 'ci:' + (env.GITHUB_REPOSITORY || 'unknown');
  return 'local';
}
// Pick this run's slot out of a stored ledger, and say what happened. A legacy single-object budget
// is discarded rather than adopted: it carries no record of which environment spent it, and guessing
// wrong is exactly the bug being fixed here. Discarding can only under-count, never over-count.
export function readLedger(prev, key, today) {
  const all = (prev && prev.budgets && typeof prev.budgets === 'object') ? { ...prev.budgets } : {};
  let note = null;
  if (!prev || !prev.budgets) {
    if (prev && prev.budget && prev.budget.day) note = `legacy single-environment ledger (${prev.budget.day}, ${Math.round(Number(prev.budget.spent) || 0)} calls) discarded — it cannot be attributed to an environment`;
  }
  const mine = all[key];
  const slot = (mine && mine.day === today) ? { day: today, spent: Number(mine.spent) || 0 } : { day: today, spent: 0 };
  if (mine && mine.day !== today) note = note || `new day for ${key} (${mine.day} -> ${today}) — resetting spend from ${Math.round(Number(mine.spent) || 0)}`;
  return { all, slot, note };
}
// Held back from the *backfill* phase only, so a long backfill can never eat the budget the next
// forecast run needs. Rolling refreshes and the forecast grid itself are never withheld.
const RESERVE = process.env.FORECAST_RESERVE == null ? null : Number(process.env.FORECAST_RESERVE);
// Open-Meteo also throttles per hour. A 6,700-anchor dense run would otherwise fire every batch
// inside ~20 minutes, so batches are paced against a sliding one-hour window as well as the ledger.
const HOURLY_CEILING = Number(process.env.HOURLY_CALL_CEILING || 5000);
// Batches between checkpoint writes. The archive is several megabytes and a dense run is ~134
// batches, so writing after every one is a lot of I/O for little extra safety.
const CHECKPOINT_EVERY = Number(process.env.CHECKPOINT_EVERY || 5);

/* ===================== anchors ===================== */
export function latticeIndex(deg) { return Math.round(deg / LATTICE); }
export function isActive(i, j, stride) { return i % stride === 0 && j % stride === 0; }

// Nearest active anchor of `stride` to a coordinate. Round straight to the active spacing
// (LATTICE*stride) rather than rounding to the lattice index and then to the stride: that double
// rounding can land on a neighbour that is not the closest anchor (it disagreed for 5,844 of 48,032
// cells), and index.html has to derive the identical anchor from the same coordinate or the join
// misses.
export function anchorFor(lat, lon, stride = PAST_STRIDE) {
  const sp = LATTICE * stride;
  return [round4(Math.round(lat / sp) * sp), round4(Math.round(lon / sp) * sp)];
}
export const anchorKey = (lat, lon) => lat.toFixed(4) + ',' + lon.toFixed(4);
function round4(x) { return Math.round(x * 1e4) / 1e4; }

// The coarse anchor that serves a dense anchor's forecast. Deriving the coarse set as the *parents of
// the dense anchors* rather than by snapping cells straight to 0.2deg is what guarantees every dense
// anchor has a forecast to bias-correct against: snapping cells directly yields 498 anchors of which
// 74 are not stride-2 points at all (the same double-rounding trap as above), leaving 10 dense
// anchors orphaned. Parents-of-dense yields 493 and cannot orphan anything. index.html performs the
// identical two-step, so the two sides cannot disagree.
export const coarseParent = (lat, lon) => anchorFor(lat, lon, FORECAST_STRIDE);

// Every anchor active at `stride` must still be active at stride/2, stride/4, ... down to 2.
export function assertStrideNesting(stride = FORECAST_STRIDE, span = 400) {
  for (let s = stride; s >= 2; s = s / 2) {
    if (!Number.isInteger(s)) throw new Error(`stride ${stride} does not halve cleanly to an integer`);
    for (let i = -span; i <= span; i++) {
      if (i % stride === 0 && i % s !== 0) throw new Error(`stride nesting broken: index ${i} active at ${stride} but not at ${s}`);
    }
  }
  return true;
}

/* ===================== daily variables ===================== */
// Billing charges variables/10 and both grids floor at 1.0 call, so ten variables cost the same as
// one. Fetching the extra four now means we never have to refetch history when a future species model
// wants them.
export const FIELDS = [
  { key: 'p', api: 'precipitation_sum', dp: 1, required: true },
  { key: 'tmax', api: 'temperature_2m_max', dp: 1, required: true },
  { key: 'tmin', api: 'temperature_2m_min', dp: 1, required: true },
  { key: 'et0', api: 'et0_fao_evapotranspiration', dp: 1, required: true },
  { key: 'snow', api: 'snowfall_sum', dp: 1, required: true },
  { key: 'rh', api: 'relative_humidity_2m_mean', dp: 0 },
  { key: 'srad', api: 'shortwave_radiation_sum', dp: 1 },
  { key: 'ph', api: 'precipitation_hours', dp: 1 },
  { key: 'sm7', api: 'soil_moisture_0_to_7cm_mean', dp: 3 },
  { key: 'st7', api: 'soil_temperature_0_to_7cm_mean', dp: 1 },
];

/* ===================== dates ===================== */
const isoFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
export function todayISO(now = new Date()) { return isoFmt.format(now); }          // local date at the anchor timezone
export function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');                                          // noon UTC: DST-proof
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function dateRange(fromISO, toISO) {
  const out = [];
  for (let d = fromISO; d <= toISO; d = addDays(d, 1)) out.push(d);
  return out;
}

/* ===================== archive shape ===================== */
// An anchor is stored as parallel arrays aligned to its grid's shared `time` axis. For merging we
// pivot to date -> {field: value} and back, so overlapping dates overwrite cleanly and new dates
// append.
export function toDateMap(time, anchor) {
  const m = new Map();
  for (let k = 0; k < time.length; k++) {
    const row = {};
    for (const f of FIELDS) { const arr = anchor[f.key]; if (Array.isArray(arr)) row[f.key] = arr[k] ?? null; }
    m.set(time[k], row);
  }
  return m;
}
export function fromDateMap(map, axis, fields = FIELDS) {
  const out = {};
  for (const f of fields) {
    let any = false;
    const arr = axis.map(d => { const v = map.get(d)?.[f.key]; if (v != null) any = true; return v ?? null; });
    out[f.key] = (any || f.required) ? arr : null;
  }
  return out;
}
// Fresh values win on overlapping dates; untouched dates survive; new dates append.
export function mergeSeries(existing, fresh) {
  const m = new Map(existing);
  for (const [date, row] of fresh) m.set(date, { ...(m.get(date) || {}), ...row });
  return m;
}
export function trimSeries(map, axis) {
  const keep = new Set(axis);
  const m = new Map();
  for (const [d, row] of map) if (keep.has(d)) m.set(d, row);
  return m;
}

/* ===================== cost model ===================== */
// Open-Meteo weights a location by days/14 x variables/10, with a floor of one call.
export function callCost(days, vars) { return Math.max(1, (days / 14) * (vars / 10)); }

/* ===================== per-grid resume guard ===================== */
// Each anchor stores `u`, the time its grid last refreshed it. A run skips anchors refreshed inside
// that grid's freshness window, so a run that dies partway can be re-run immediately without paying
// again for what it already got.
//
// The window is derived from the grid's own cadence rather than one hard-coded constant. The old
// global 5h assumed four uniform 6-hourly runs; with the dense grid on 24h and the coarse grid on 12h
// a single constant either skips a whole scheduled coarse run or fails to protect a resumed dense one.
// FRESH_FRACTION of the cadence keeps the original relationship (5h of a 6h cadence is 0.83) while
// letting each grid answer the question for itself.
export const FRESH_FRACTION = Number(process.env.FRESH_FRACTION || 0.8);
export function freshWindowMs(grid, fraction = FRESH_FRACTION) {
  return GRIDS[grid].cadenceHours * 3600e3 * fraction;
}
// An off-cycle manual build shifts a grid's phase and the next scheduled run can land inside the
// window and skip everything — harmless and self-correcting on the following run, but set
// FORCE_REFRESH=1 to override when you actually mean to rebuild now.
const FORCE_REFRESH = process.env.FORCE_REFRESH === '1';

// Freshness alone is NOT enough to skip an anchor.
//
// The guard used to ask only "was this refreshed recently?", which quietly assumes recently-refreshed
// means up to date. That holds inside a timezone day and breaks across one: an anchor fetched at
// 22:00 Pacific is 11h old at 09:00 next morning — well inside the dense grid's 19.2h window — and is
// a whole day behind. It was skipped, so it never got the new day; meanwhile any anchor that *was*
// stale got rolled and pulled the shared axis forward to today; and the ragged check then found
// thousands of anchors short of that axis and refetched every one of them IN FULL at 1.6 calls
// instead of the 1.0 a rolling fetch costs. Measured on the run that exposed it: 4,983 anchors,
// ~7,973 calls of full refetch on top of the roll, ceiling hit, run stopped at 4,250/4,983.
//
// So an anchor may be skipped only when it is BOTH fresh AND already carries the last day this grid
// is fetching toward. The target is a fixed date, not the store's current axis: the axis end is
// *created* by this run's fetches, so testing against it is circular — before fetching, nothing has
// today, everything looks covered, and the bug reproduces exactly.
//
// The invariant this buys: a run either brings every anchor up to today, or changes nothing. There is
// no longer a state where some anchors advance and the rest are left behind to go ragged.
export function coversThrough(entry, endDate) {
  return !!(entry && entry.series && entry.series.has(endDate));
}
export function isFreshAt(entry, freshCut) {
  const u = entry && entry.u;
  return !!u && Date.parse(u) > freshCut;
}
export function canSkip(entry, endDate, freshCut, force = false) {
  if (force) return false;
  return isFreshAt(entry, freshCut) && coversThrough(entry, endDate);
}

/* ===================== main ===================== */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = (v, dp) => v == null ? null : (dp === 0 ? Math.round(v) : Math.round(v * 10 ** dp) / 10 ** dp);

async function fetchJSON(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(REQ_TIMEOUT) });
  if (!r.ok) {
    const reason = (await r.json().catch(() => ({}))).reason || '';
    const e = new Error(`HTTP ${r.status} ${reason}`);
    e.status = r.status; e.reason = reason;
    throw e;
  }
  return r.json();
}

// Open-Meteo answers 429 for three different things. A minutely limit clears inside the retry budget,
// so retrying is right. An hourly or daily limit does not clear for the rest of the run — retrying it
// burns eight attempts per batch and then marks perfectly good anchors as failed, which walks the run
// into the >25% abort and loses everything it had. Treat those two as the API telling us the same
// thing our own ledger would: stop, checkpoint, resume next run.
export const isQuota429 = e => e && e.status === 429 && /(hourly|daily)/i.test(e.reason || e.message || '');
function buildURL(pts, vars, past, fc) {
  return `https://api.open-meteo.com/v1/forecast?latitude=${pts.map(a => a[0].toFixed(4)).join(',')}` +
    `&longitude=${pts.map(a => a[1].toFixed(4)).join(',')}&daily=${vars.join(',')}` +
    `&past_days=${past}&forecast_days=${fc}&timezone=${encodeURIComponent(TZ)}`;
}

// Confirm the exact daily parameter names before spending a run on them. Two failure modes matter:
// a name the API rejects outright (400), and a name it accepts but returns entirely null for — the
// 0-7cm soil aggregates do the latter under the default model, populating only for models=ecmwf_ifs025.
// We will not pin that model, because it would change the provenance of precipitation and temperature
// too and silently move every score. Either way we log which variable went and carry on without it.
const allNull = arr => Array.isArray(arr) && arr.length > 0 && arr.every(v => v == null);

async function probeVariables(probePt) {
  const wanted = FIELDS.map(f => f.api);
  const dropped = []; let calls = 0;
  let daily = null;
  try {
    calls++;
    daily = (await fetchJSON(buildURL([probePt], wanted, 0, 3))).daily;
  } catch (e) {
    if (e.status !== 400) throw e;
    console.log(`probe: batch rejected (${e.message}) — testing each variable`);
    const ok = [];
    for (const v of wanted) {
      try { calls++; const d = (await fetchJSON(buildURL([probePt], [v], 0, 3))).daily; if (allNull(d[v])) { dropped.push(`${v} (no data)`); } else ok.push(v); }
      catch (err) { if (err.status !== 400) throw err; dropped.push(`${v} (rejected)`); }
      await sleep(300);
    }
    for (const d of dropped) console.log(`  dropped: ${d}`);
    console.log(`probe: ${ok.length} usable, ${dropped.length} dropped`);
    return { ok, dropped, calls };
  }
  const ok = wanted.filter(v => {
    if (!(v in daily)) { dropped.push(`${v} (absent)`); return false; }
    if (allNull(daily[v])) { dropped.push(`${v} (no data under the default model)`); return false; }
    return true;
  });
  for (const d of dropped) console.log(`  dropped: ${d}`);
  console.log(`probe: ${ok.length} usable daily variables${dropped.length ? `, ${dropped.length} dropped` : ''}`);
  return { ok, dropped, calls };
}

async function main() {
  assertStrideNesting();
  for (const g of WANT) if (!GRIDS[g]) { console.error(`unknown grid "${g}" — expected some of ${Object.keys(GRIDS).join(', ')}`); process.exit(1); }

  if (!fs.existsSync(CELLS_FILE)) {
    console.error(`${CELLS_FILE} not found — export it from the app first (info panel -> Export cells.json).`);
    process.exit(1);
  }
  let cells;
  try { cells = JSON.parse(fs.readFileSync(CELLS_FILE, 'utf8')); }
  catch (e) { console.error(`${CELLS_FILE} is not valid JSON:`, e.message); process.exit(1); }
  if (!cells.rows || !cells.rows.length) { console.error(`${CELLS_FILE} has no rows — re-export it after a complete load.`); process.exit(1); }

  // ---- the two anchor sets ----
  const wantAnchors = { past: new Map(), forecast: new Map() };
  for (const r of cells.rows) { const a = anchorFor(r[0], r[1], PAST_STRIDE); wantAnchors.past.set(anchorKey(a[0], a[1]), a); }
  for (const a of wantAnchors.past.values()) { const c = coarseParent(a[0], a[1]); wantAnchors.forecast.set(anchorKey(c[0], c[1]), c); }
  console.log(`grids (LATTICE ${LATTICE}):`);
  for (const g of GRID_ORDER) console.log(`  ${g.padEnd(8)} stride ${String(GRIDS[g].stride).padStart(2)} = ${round4(LATTICE * GRIDS[g].stride)}deg, ${wantAnchors[g].size} anchors, past_days=${GRIDS[g].past} forecast_days=${GRIDS[g].fc}, every ${GRIDS[g].cadenceHours}h`);
  console.log(`running: ${WANT.join(', ')}`);

  const today = todayISO();
  const axisWanted = {
    past: dateRange(addDays(today, -PAST_KEEP), today),
    forecast: dateRange(addDays(today, -PAST_KEEP), addDays(today, FC - 1)),
  };

  // ---- load the existing archive ----
  const store = { past: new Map(), forecast: new Map() };   // grid -> anchorKey -> {lat,lon,elev,u,series}
  const BKEY = envKey();
  let budget = { day: today, spent: 0 };
  let budgets = {};              // every environment's slot, so writing ours never erases theirs
  let budgetNote = null;
  let rebuilt = false;

  // A date whose every field is null is padding, not data — an anchor that joined the archive later
  // than the others carries one. Treating it as coverage would keep the shared axis anchored to a day
  // nobody can actually fill, so drop it and let the axis close up.
  const loadAnchors = (grid, time, rows) => {
    for (const a of rows) {
      const series = toDateMap(time, a);
      for (const [d, row] of series) if (FIELDS.every(f => row[f.key] == null)) series.delete(d);
      store[grid].set(anchorKey(a.lat, a.lon), { lat: a.lat, lon: a.lon, elev: a.elev, u: a.u || null, series });
    }
  };

  if (fs.existsSync(WEATHER_FILE)) {
    try {
      const prev = JSON.parse(fs.readFileSync(WEATHER_FILE, 'utf8'));
      if (prev.LATTICE !== LATTICE) {
        console.log(`archive lattice ${prev.LATTICE} != ${LATTICE} — discarding and rebuilding in full`);
        rebuilt = true;
      } else if (prev.format === 2 && prev.past && prev.forecast) {
        // Same two-grid format. A stored stride is reusable when it is a multiple of ours: every
        // stored anchor is then still an active point and keeps its history.
        for (const g of GRID_ORDER) {
          const s = prev[g];
          if (!s || !Array.isArray(s.anchors) || !Array.isArray(s.time)) continue;
          if (s.stride !== GRIDS[g].stride) console.log(`  ${g}: stride ${s.stride} -> ${GRIDS[g].stride}; anchors still active keep their history`);
          const rows = s.anchors.filter(a => wantAnchors[g].has(anchorKey(a.lat, a.lon)));
          loadAnchors(g, s.time, rows);
          console.log(`  ${g}: adopted ${rows.length} of ${s.anchors.length} stored anchors, ${s.time.length} days (${s.time[0]} .. ${s.time[s.time.length - 1]})`);
        }
        const led = readLedger(prev, BKEY, today);
        budgets = led.all; budget = led.slot; budgetNote = led.note;
      } else if (Array.isArray(prev.anchors) && Array.isArray(prev.time) && Number.isInteger(prev.STRIDE)) {
        // Single-grid (format 1) archive. Its anchors are active in any grid whose stride divides the
        // stored one, so the old stride-4 file seeds the dense past grid outright and its stride-8
        // subset seeds the forecast grid. That is what makes this migration cost 4,983 backfills
        // instead of 6,666.
        console.log(`archive is single-grid (STRIDE ${prev.STRIDE}) — adopting each stored anchor into whichever grids it is active in`);
        for (const g of GRID_ORDER) {
          const rows = prev.anchors.filter(a => wantAnchors[g].has(anchorKey(a.lat, a.lon)));
          loadAnchors(g, prev.time, rows);
          console.log(`  ${g}: adopted ${rows.length} of ${prev.anchors.length} stored anchors`);
        }
      }
    } catch (e) { console.log(`archive unreadable (${e.message}) — rebuilding in full`); rebuilt = true; }
  } else console.log('no archive yet — first full build');

  // drop anchors that are no longer active in their grid
  for (const g of GRID_ORDER) for (const k of [...store[g].keys()]) if (!wantAnchors[g].has(k)) store[g].delete(k);

  // ---- daily call ledger ----
  // Runs are separate processes, so the ledger has to live in the committed file. It resets when the
  // archive's timezone day rolls over.
  if (budgetNote) console.log('budget: ' + budgetNote);
  const reserve = RESERVE != null ? RESERVE : wantAnchors.forecast.size + 1;
  const others = Object.keys(budgets).filter(k => k !== BKEY);
  console.log(`budget [${BKEY}]: ${budget.spent.toFixed(0)} of ${DAILY_CEILING} already spent today; backfill holds back ${reserve} for the next forecast run` +
    (others.length ? `  (other environments tracked separately: ${others.join(', ')})` : ''));

  let stoppedOnBudget = false;
  const hourWindow = [];     // [{t, cost}] for the sliding hourly pace
  function hourlySpend() { const cut = Date.now() - 3600e3; while (hourWindow.length && hourWindow[0].t < cut) hourWindow.shift(); return hourWindow.reduce((a, x) => a + x.cost, 0); }
  function spend(cost) { budget.spent += cost; hourWindow.push({ t: Date.now(), cost }); }
  function affordable(cost, extraReserve = 0) { return budget.spent + cost <= DAILY_CEILING - extraReserve; }
  async function pace(cost) {
    while (hourWindow.length && hourlySpend() + cost > HOURLY_CEILING) {
      const wait = Math.max(30e3, 3600e3 - (Date.now() - hourWindow[0].t) + 1000);
      console.log(`pacing: ${hourlySpend().toFixed(0)}/${HOURLY_CEILING} calls in the last hour — waiting ${Math.round(wait / 1000)}s`);
      await sleep(Math.min(wait, 300e3));
    }
  }

  const probe = await probeVariables(wantAnchors.past.values().next().value);
  const vars = probe.ok;
  const activeFields = FIELDS.filter(f => vars.includes(f.api));
  if (!activeFields.some(f => f.key === 'p')) { console.error('precipitation_sum unavailable — refusing to write an archive without rain.'); process.exit(1); }
  spend(probe.calls * callCost(2, vars.length));

  const runStamp = new Date().toISOString();
  let failed = 0, sinceWrite = 0;
  const counts = {};   // "grid/phase" -> {anchors, cost, days}

  /* ---- serialisation ---- */
  // Build a grid's shared time axis and the aligned per-anchor arrays. All anchors of a grid must sit
  // on one axis. The axis starts at the *latest* first-date across that grid's anchors, not the
  // earliest: a newly added anchor can only reach back past_days, so taking the union would mark every
  // new anchor short of the older ones' deepest history, refetch them all pointlessly, and still have
  // to pad with nulls. Starting where everyone has data costs at most a day or two of depth and keeps
  // the series dense.
  // The axis start is the LATEST first-date across anchors, not the earliest — one deep anchor must
  // not drag it back past what the rest can fill. The end is deliberately still a union: it is the
  // guard's job (canSkip) to make sure nothing is left short of it, not the axis's job to shrink to
  // the laggard. Shrinking instead would throw away today for every anchor that does have it.
  function axisFor(grid) {
    const present = new Set();
    let start = null;
    for (const a of store[grid].values()) {
      let first = null;
      for (const d of a.series.keys()) { present.add(d); if (!first || d < first) first = d; }
      if (first && (!start || first > start)) start = first;
    }
    return axisWanted[grid].filter(d => present.has(d) && (!start || d >= start));
  }
  function materialize(grid) {
    const axis = axisFor(grid);
    const rows = [];
    for (const a of store[grid].values()) {
      const s = trimSeries(a.series, axis);
      rows.push({ lat: a.lat, lon: a.lon, elev: a.elev, u: a.u, ...fromDateMap(s, axis, activeFields) });
    }
    return { axis, anchors: rows };
  }

  // Checkpointing rewrites a multi-megabyte file, and on Windows a transient sharing violation on
  // that write killed a 1,300-call run outright. So: serialise to a sibling temp file and rename over
  // the target — rename replaces in one step, and a failed open can no longer truncate a good
  // archive — retry a few times, and treat a failed *checkpoint* as a warning, since the run has more
  // batches coming and the next checkpoint carries the same state. Only the final write is fatal.
  let ckptFails = 0;
  async function writeOut(partial, fatal = false) {
    const out = {};
    for (const g of GRID_ORDER) {
      const { axis, anchors } = materialize(g);
      out[g] = { stride: GRIDS[g].stride, time: axis, today_index: axis.indexOf(today), anchors };
    }
    const body = JSON.stringify({
      generated: new Date().toISOString(),
      format: 2,
      LATTICE, PAST_STRIDE, FORECAST_STRIDE,
      today,
      bias: { taper_days: BIAS_TAPER, window_days: BIAS_WINDOW },
      partial,
      // Keyed by environment. Other environments' slots are carried through untouched — a local run
      // must never rewrite CI's count, which is the whole point of the split.
      budgets: { ...budgets, [BKEY]: { day: budget.day, spent: Math.round(budget.spent * 10) / 10 } },
      budget_ceiling: DAILY_CEILING,
      past: out.past,
      forecast: out.forecast,
    });
    fs.mkdirSync(path.dirname(WEATHER_FILE), { recursive: true });
    const tmp = WEATHER_FILE + '.tmp';
    let lastErr = null;
    for (let i = 0; i < 4; i++) {
      try { fs.writeFileSync(tmp, body); fs.renameSync(tmp, WEATHER_FILE); return true; }
      catch (e) {
        lastErr = e;
        try { fs.rmSync(tmp, { force: true }); } catch (_) {}
        if (i < 3) await sleep(500 * (i + 1));
      }
    }
    if (fatal) throw lastErr;
    console.log(`checkpoint write failed (${lastErr.code || lastErr.message}) — carrying on, the next checkpoint will catch up`);
    ckptFails++;
    return false;
  }

  /* ---- fetching ---- */
  async function fetchGroup(grid, pts, past, phase, extraReserve = 0) {
    const G = GRIDS[grid];
    const label = `${grid}/${phase}`;
    const per = callCost(past + G.fc, vars.length);
    counts[label] = counts[label] || { anchors: 0, cost: 0, days: past + G.fc };
    for (let i = 0; i < pts.length; i += BATCH) {
      const b = pts.slice(i, i + BATCH);
      const cost = b.length * per;
      if (!affordable(cost, extraReserve)) {
        stoppedOnBudget = true;
        console.log(`budget ceiling reached (${budget.spent.toFixed(0)}/${DAILY_CEILING}${extraReserve ? `, ${extraReserve} reserved` : ''}) — stopping ${label} at ${i}/${pts.length}; the next run resumes here`);
        await writeOut(true);
        return false;
      }
      await pace(cost);
      let j = null, lastErr = '', quota = null;
      for (let k = 0; k < ATTEMPTS; k++) {
        try { j = await fetchJSON(buildURL(b, vars, past, G.fc)); break; }
        catch (err) {
          if (isQuota429(err)) { quota = err.reason || err.message; break; }
          lastErr = err.cause?.code || err.status || err.name || err.message;
          await sleep(err.status === 429 ? 25000 : Math.min(30000, 4000 * (k + 1)));
          console.log(`retry ${k + 1}/${ATTEMPTS} (${label}): ${lastErr}`);
        }
      }
      if (quota) {
        stoppedOnBudget = true;
        console.log(`Open-Meteo says: ${quota} — stopping ${label} at ${i}/${pts.length}; the next run resumes here`);
        await writeOut(true);
        return false;
      }
      spend(cost);   // a failed batch still counts against the quota
      if (!j) {
        failed += b.length;
        console.log(`batch failed permanently (${lastErr}) — ${failed} anchors missing so far`);
        await writeOut(true);
        if (failed > wantAnchors[grid].size * 0.25) { console.error('Too many anchors failed; keeping the archive as it stands.'); process.exit(1); }
        continue;
      }
      if (!Array.isArray(j)) j = [j];
      j.forEach((x, k) => {
        const [lat, lon] = b[k];
        const kk = anchorKey(lat, lon);
        const d = x.daily;
        const freshMap = new Map();
        d.time.forEach((date, n) => {
          const row = {};
          for (const f of activeFields) { const arr = d[f.api]; if (arr) row[f.key] = rnd(arr[n], f.dp); }
          freshMap.set(date, row);
        });
        const prev = store[grid].get(kk);
        const merged = prev ? mergeSeries(prev.series, freshMap) : freshMap;
        store[grid].set(kk, { lat, lon, elev: x.elevation, u: runStamp, series: trimSeries(merged, axisWanted[grid]) });
      });
      counts[label].anchors += b.length; counts[label].cost += cost;
      console.log(`${label}: ${Math.min(i + BATCH, pts.length)}/${pts.length}  (spent ${budget.spent.toFixed(0)}/${DAILY_CEILING})`);
      if (++sinceWrite >= CHECKPOINT_EVERY || i + BATCH >= pts.length) { sinceWrite = 0; await writeOut(true); }
      if (i + BATCH < pts.length) await sleep(GAP);
    }
    return true;
  }

  // New anchors joining an existing grid fetch deep enough to reach its earliest day, so adding them
  // does not cost the older anchors their extra history. Open-Meteo allows 92 past days.
  function pastForNew(grid) {
    let start = null;
    for (const a of store[grid].values()) for (const d of a.series.keys()) if (!start || d < start) start = d;
    const depth = start ? Math.round((Date.parse(today + 'T12:00:00Z') - Date.parse(start + 'T12:00:00Z')) / 86400e3) : 0;
    return { past: Math.min(92, Math.max(PAST_FULL, depth)), start };
  }

  /* ---- run each grid ---- */
  const freshCut = {};
  for (const g of GRID_ORDER) freshCut[g] = Date.now() - freshWindowMs(g);

  for (const grid of GRID_ORDER) {
    if (!WANT.includes(grid)) continue;
    if (stoppedOnBudget) break;
    const G = GRIDS[grid];
    const roll = [], backfill = [];
    let resumed = 0, behind = 0;
    // The last day this grid fetches toward: today for the dense past grid (forecast_days=1), today+7
    // for the coarse forecast grid. An anchor short of it is behind no matter how recently it ran.
    const gridEnd = axisWanted[grid][axisWanted[grid].length - 1];
    for (const a of wantAnchors[grid].values()) {
      const k = anchorKey(a[0], a[1]);
      const e = store[grid].get(k);
      if (canSkip(e, gridEnd, freshCut[grid], FORCE_REFRESH)) { resumed++; continue; }
      if (isFreshAt(e, freshCut[grid]) && !FORCE_REFRESH) behind++;
      (e && e.series.size ? roll : backfill).push(a);
    }
    const pn = pastForNew(grid);
    console.log(`\n[${grid}] ${G.label}: ${roll.length} rolling (${G.past}+${G.fc}d), ${backfill.length} backfill (${pn.past}+${G.fc}d)` +
      `${resumed ? `, ${resumed} skipped as refreshed within ${(freshWindowMs(grid) / 3600e3).toFixed(1)}h and already covering ${gridEnd}` : ''}` +
      `${behind ? `, ${behind} fresh but short of ${gridEnd} — rolled rather than left to go ragged` : ''}` +
      `${pn.start && pn.past !== PAST_FULL ? ` — backfill reaches back to ${pn.start}` : ''}`);

    // Rolling refreshes keep the live data current and are never withheld; the backfill is
    // opportunistic and holds back the forecast reserve so it can spread over several runs.
    if (roll.length && !await fetchGroup(grid, roll, G.past, 'roll')) break;
    if (backfill.length && !await fetchGroup(grid, backfill, pn.past, 'backfill', grid === 'past' ? reserve : 0)) break;

    // ragged check: every anchor must cover its grid's shared axis, else refetch it in full
    const axis = materialize(grid).axis;
    const ragged = [];
    for (const [k, a] of store[grid]) if (axis.some(d => !a.series.has(d))) ragged.push(wantAnchors[grid].get(k) || [a.lat, a.lon]);
    if (ragged.length) {
      console.log(`[${grid}] ${ragged.length} anchors diverge from the shared time axis — refetching them in full`);
      if (!await fetchGroup(grid, ragged, pn.past, 'refetch', reserve)) break;
      const axis2 = materialize(grid).axis;
      let still = 0;
      for (const a of store[grid].values()) if (axis2.some(d => !a.series.has(d))) still++;
      if (still) console.log(`[${grid}] warning: ${still} anchors still short after refetch — padded with nulls`);
    }
  }

  if (!store.past.size && !store.forecast.size) { console.error('No anchors in the archive.'); process.exit(1); }
  await writeOut(stoppedOnBudget || failed > 0, true);
  if (ckptFails) console.log(`(${ckptFails} checkpoint writes were retried or skipped during the run)`);

  /* ---- report ---- */
  const done = { past: materialize('past'), forecast: materialize('forecast') };
  console.log(`\nwrote ${WEATHER_FILE}`);
  for (const g of GRID_ORDER) {
    const d = done[g], have = d.anchors.length, want = wantAnchors[g].size;
    console.log(`  ${g.padEnd(8)} ${have}/${want} anchors, ${d.axis.length} days (${d.axis[0] || '-'} .. ${d.axis[d.axis.length - 1] || '-'}), today_index ${d.axis.indexOf(today)}${have < want ? `  <- ${want - have} still to backfill` : ''}`);
  }
  if (failed) console.log(`  ${failed} anchors failed this run`);
  if (rebuilt) console.log('  archive rebuilt');
  console.log('--- cost ---');
  console.log(`variables: ${vars.length}${probe.dropped.length ? ` (dropped: ${probe.dropped.join(', ')})` : ''}`);
  let total = probe.calls * callCost(2, vars.length);
  console.log(`  probe              ${String(probe.calls).padStart(5)} requests        = ${total.toFixed(1)} calls`);
  for (const [k, c] of Object.entries(counts)) {
    if (!c.anchors) continue;
    total += c.cost;
    console.log(`  ${k.padEnd(18)} ${String(c.anchors).padStart(5)} anchors x ${c.days}d = ${c.cost.toFixed(1)} calls`);
  }
  console.log(`  total    ${total.toFixed(1)} calls this run`);
  console.log(`  today    ${budget.spent.toFixed(0)} of ${DAILY_CEILING} (our ceiling) / 10,000 (Open-Meteo daily)`);
  const steady = wantAnchors.past.size + wantAnchors.forecast.size * 2 + 2;
  console.log(`  steady state: ${wantAnchors.past.size} dense x1 + ${wantAnchors.forecast.size} coarse x2 + 2 probes = ${steady}/day, ${steady * 30}/month`);
  if (stoppedOnBudget) console.log('\nstopped at the call ceiling — rerun, or wait for the next scheduled run, to continue the backfill');
}

/* ===================== bias correction (consumed by index.html) ===================== */
// The seam. The dense grid ends at today; the coarse grid carries today+1..today+7. Joining them
// naively makes every value jump at today, because the two grids resolve terrain differently — a
// valley-bottom dense anchor and its 0.2deg parent are not the same place. Blending would smear the
// dense detail we just paid for, so instead we transplant the coarse forecast onto the dense anchor:
// measure how the two grids disagree over the days they *both* cover, then carry that offset forward,
// tapering to zero as forecast uncertainty grows and the measured offset stops meaning anything.
//
// Temperature is additive (dense minus coarse — an elevation/inversion offset in degrees) and
// precipitation multiplicative (dense over coarse — an orographic factor). Both are exported here so
// the app and the tests use one implementation.
export const BIAS_WINDOW = 7;   // overlap days used to measure the offset
export const BIAS_TAPER = 4;    // forecast days over which the correction decays to zero
export const BIAS_LIMITS = { temp: 6, ratioLo: 0.4, ratioHi: 2.5, minDays: 3, minRain: 2 };

// The temperature clamp has to be physical, not a round number. A dense anchor and its 0.2deg parent
// can sit 1,000 m apart in the Cascades, and 6.5 C/km makes a 6-7 C offset between them entirely
// real. Measured on the live archive, the offset regresses on the lapse-rate prediction with slope
// 1.293 (n=2,683) — it is elevation signal, and a flat +/-6 clamp was discarding it for 7.3% of
// anchors, all of them large elevation gaps, leaving up to 2.6 C of error in the mountains where the
// boletes are. So allow what the elevation difference can physically explain, with headroom for
// inversions steeper than the standard rate, and keep a tight limit where there is no elevation
// reason for any offset at all.
export const LAPSE_C_PER_KM = 6.5;
export const BIAS_TEMP_BASE = 4;    // allowed with no elevation difference at all
export const BIAS_TEMP_SLACK = 1.5; // multiplier on the lapse prediction: inversions beat the standard rate
export const BIAS_TEMP_MAX = 20;    // absolute ceiling, still well inside physical plausibility
export function tempLimitFor(denseElev, coarseElev) {
  if (!Number.isFinite(denseElev) || !Number.isFinite(coarseElev)) return BIAS_TEMP_BASE;
  const dzKm = Math.abs(denseElev - coarseElev) / 1000;
  return Math.min(BIAS_TEMP_MAX, LAPSE_C_PER_KM * dzKm * BIAS_TEMP_SLACK + BIAS_TEMP_BASE);
}

// Weight for forecast day k (1 = the first day past the seam).
export function biasWeight(k, taper = BIAS_TAPER) { return Math.max(0, 1 - (k - 1) / taper); }

// dense/coarse: {date -> row} style accessors over the overlap. Returns additive offsets per
// temperature field and one multiplicative rain ratio.
export function measureBias(overlap, lim = BIAS_LIMITS, tempLimit = lim.temp) {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const out = { tmax: 0, tmin: 0, rain: 1, days: 0 };
  const acc = { tmax: [0, 0], tmin: [0, 0] };
  let dRain = 0, cRain = 0, n = 0;
  for (const [d, c] of overlap) {
    if (!d || !c) continue;
    n++;
    for (const f of ['tmax', 'tmin']) if (d[f] != null && c[f] != null) { acc[f][0] += d[f] - c[f]; acc[f][1]++; }
    if (d.p != null && c.p != null) { dRain += d.p; cRain += c.p; }
  }
  out.days = n;
  if (n < lim.minDays) return out;                       // too little overlap to say anything
  for (const f of ['tmax', 'tmin']) if (acc[f][1]) out[f] = clamp(acc[f][0] / acc[f][1], -tempLimit, tempLimit);
  // A ratio needs enough rain on the coarse side to divide by; a dry fortnight would otherwise produce
  // a wild multiplier from two tenths of a millimetre.
  if (cRain >= lim.minRain) out.rain = clamp(dRain / cRain, lim.ratioLo, lim.ratioHi);
  return out;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
