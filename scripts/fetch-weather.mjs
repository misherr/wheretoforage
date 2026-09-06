// Rolling weather archive for data/weather.json, built from the anchors implied by data/cells.json.
// Run on a schedule by .github/workflows/weather.yml. Node 20+, no dependencies.
//
// Why rolling: Open-Meteo bills each location as max(1, days/14 x variables/10). Refetching 34 days
// costs 2.43 per anchor; refetching only the last few days costs 1.0. We keep the history locally and
// merge a short fresh window into it each run, so the archive stays complete at ~2.4x lower cost.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ===================== lattice ===================== */
// Anchors live on a fixed lattice of LATTICE-degree steps. A lattice point (i,j) is an *active*
// anchor only when i % STRIDE === 0 && j % STRIDE === 0, and its coordinates are (i*LATTICE, j*LATTICE).
// At STRIDE 8 that is every 0.2 degrees.
//
// The point of this scheme: halving STRIDE must preserve every existing anchor position, so we can
// densify later without refetching history for the anchors we already have. That holds because an
// anchor's coordinate depends only on its lattice index i, and activity is i % STRIDE === 0:
//   STRIDE 8 -> 4: i % 8 === 0 implies i % 4 === 0, so every 0.2-degree anchor is still active at 0.1.
//   STRIDE 4 -> 2: i % 4 === 0 implies i % 2 === 0, so every 0.1-degree anchor is still active at 0.05.
// Verified for 8 -> 4 -> 2 by assertStrideNesting() below and by the unit test. It only holds while
// the lattice origin stays 0 and each new stride divides the previous one, so halve - never rescale.
export const LATTICE = 0.025;
export const STRIDE = 8;

export const PAST_KEEP = 30;   // past days retained in the archive (model needs 26; 30 gives headroom)
export const FC = 8;           // forecast days, counting today
export const PAST_FULL = 26;   // past window when an anchor has no history yet
export const PAST_ROLL = 3;    // past window when an anchor already has history

const BATCH = 50;              // anchors per request
const GAP = 8000;              // ms between batches (stay under the per-minute limit)
const REQ_TIMEOUT = 45000;     // ms per attempt
const ATTEMPTS = 8;
const TZ = 'America/Los_Angeles';

const CELLS_FILE = process.env.CELLS_FILE || 'data/cells.json';
const WEATHER_FILE = process.env.WEATHER_FILE || 'data/weather.json';

export function latticeIndex(deg) { return Math.round(deg / LATTICE); }
export function isActive(i, j, stride = STRIDE) { return i % stride === 0 && j % stride === 0; }

// Nearest active anchor to a coordinate. Round straight to the active spacing (LATTICE*STRIDE) rather
// than rounding to the lattice index and then to STRIDE: that double rounding can land on a neighbour
// that is not the closest anchor (it disagreed for 5,844 of 48,032 cells), and index.html has to be
// able to derive the identical anchor from the same coordinate or the join misses.
export function anchorFor(lat, lon) {
  const sp = LATTICE * STRIDE;
  return [round4(Math.round(lat / sp) * sp), round4(Math.round(lon / sp) * sp)];
}
export const anchorKey = (lat, lon) => lat.toFixed(4) + ',' + lon.toFixed(4);
function round4(x) { return Math.round(x * 1e4) / 1e4; }

// Every anchor active at STRIDE must still be active at STRIDE/2, STRIDE/4, ... down to 2.
export function assertStrideNesting(stride = STRIDE, span = 400) {
  for (let s = stride; s >= 2; s = s / 2) {
    if (!Number.isInteger(s)) throw new Error(`STRIDE ${stride} does not halve cleanly to an integer`);
    for (let i = -span; i <= span; i++) {
      if (i % stride === 0 && i % s !== 0) throw new Error(`stride nesting broken: index ${i} active at ${stride} but not at ${s}`);
    }
  }
  return true;
}

/* ===================== daily variables ===================== */
// Billing charges variables/10, so ten variables cost the same as one. Fetching the extra four now
// means we never have to refetch history when a future species model wants them.
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
// An anchor is stored as parallel arrays aligned to one shared `time` axis. For merging we pivot to
// date -> {field: value} and back, so overlapping dates overwrite cleanly and new dates append.
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

/* ===================== main ===================== */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = (v, dp) => v == null ? null : (dp === 0 ? Math.round(v) : Math.round(v * 10 ** dp) / 10 ** dp);

async function fetchJSON(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(REQ_TIMEOUT) });
  if (!r.ok) { const e = new Error(`HTTP ${r.status} ${(await r.json().catch(() => ({}))).reason || ''}`); e.status = r.status; throw e; }
  return r.json();
}
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

  if (!fs.existsSync(CELLS_FILE)) {
    console.error(`${CELLS_FILE} not found — export it from the app first (info panel -> Export cells.json).`);
    process.exit(1);
  }
  let cells;
  try { cells = JSON.parse(fs.readFileSync(CELLS_FILE, 'utf8')); }
  catch (e) { console.error(`${CELLS_FILE} is not valid JSON:`, e.message); process.exit(1); }
  if (!cells.rows || !cells.rows.length) { console.error(`${CELLS_FILE} has no rows — re-export it after a complete load.`); process.exit(1); }

  // active anchors implied by the cells
  const anchors = new Map();
  for (const r of cells.rows) { const a = anchorFor(r[0], r[1]); anchors.set(anchorKey(a[0], a[1]), a); }
  const list = [...anchors.values()];
  console.log(`${list.length} active anchors (LATTICE ${LATTICE}, STRIDE ${STRIDE} => ${round4(LATTICE * STRIDE)}deg spacing)`);

  const today = todayISO();
  const axisWanted = dateRange(addDays(today, -PAST_KEEP), addDays(today, FC - 1));

  // ---- load the existing archive ----
  let store = new Map();            // anchorKey -> {lat, lon, elev, series: Map<date,row>, u}
  let rebuilt = false;
  if (fs.existsSync(WEATHER_FILE)) {
    try {
      const prev = JSON.parse(fs.readFileSync(WEATHER_FILE, 'utf8'));
      if (prev.LATTICE !== LATTICE || prev.STRIDE !== STRIDE) {
        console.log(`archive lattice ${prev.LATTICE}/${prev.STRIDE} != ${LATTICE}/${STRIDE} — discarding and rebuilding in full`);
        rebuilt = true;
      } else if (Array.isArray(prev.anchors) && Array.isArray(prev.time)) {
        for (const a of prev.anchors) {
          store.set(anchorKey(a.lat, a.lon), { lat: a.lat, lon: a.lon, elev: a.elev, u: a.u || null, series: toDateMap(prev.time, a) });
        }
        console.log(`archive: ${store.size} anchors, ${prev.time.length} days (${prev.time[0]} .. ${prev.time[prev.time.length - 1]})`);
      }
    } catch (e) { console.log(`archive unreadable (${e.message}) — rebuilding in full`); rebuilt = true; }
  } else console.log('no archive yet — first full build');

  // drop anchors that are no longer active
  for (const k of [...store.keys()]) if (!anchors.has(k)) store.delete(k);

  // resume: anything already refreshed in the last 5 hours stays as it is
  const freshCut = Date.now() - 5 * 3600e3;
  const isFresh = k => { const u = store.get(k)?.u; return u && Date.parse(u) > freshCut; };

  const probe = await probeVariables(list[0]);
  const vars = probe.ok;
  const activeFields = FIELDS.filter(f => vars.includes(f.api));
  if (!activeFields.some(f => f.key === 'p')) { console.error('precipitation_sum unavailable — refusing to write an archive without rain.'); process.exit(1); }

  // ---- split the work by window ----
  const full = [], roll = [];
  for (const a of list) {
    const k = anchorKey(a[0], a[1]);
    if (isFresh(k)) continue;                                   // already done this run
    (store.has(k) && store.get(k).series.size ? roll : full).push(a);
  }
  const resumed = list.length - full.length - roll.length;
  if (resumed) console.log(`resuming: ${resumed} anchors already refreshed within 5h`);
  console.log(`fetch plan: ${full.length} full (${PAST_FULL}+${FC}d), ${roll.length} rolling (${PAST_ROLL}+${FC}d)`);

  const runStamp = new Date().toISOString();
  let failed = 0;
  const counts = { full: 0, roll: 0, refetch: 0 };

  function writeOut(partial) {
    const { axis, anchors: rows } = materialize();
    fs.mkdirSync(path.dirname(WEATHER_FILE), { recursive: true });
    fs.writeFileSync(WEATHER_FILE, JSON.stringify({
      generated: new Date().toISOString(),
      LATTICE, STRIDE,
      past_days: axis.length ? Math.max(0, axis.indexOf(today)) : PAST_KEEP,
      forecast_days: axis.length ? axis.length - Math.max(0, axis.indexOf(today)) : FC,
      today_index: axis.indexOf(today),
      partial,
      time: axis,
      anchors: rows,
    }));
  }

  // Build the shared time axis and the aligned per-anchor arrays. All anchors must sit on one axis.
  function materialize() {
    const present = new Set();
    for (const a of store.values()) for (const d of a.series.keys()) present.add(d);
    const axis = axisWanted.filter(d => present.has(d));
    const rows = [];
    for (const a of store.values()) {
      const s = trimSeries(a.series, axis);
      rows.push({ lat: a.lat, lon: a.lon, elev: a.elev, u: a.u, ...fromDateMap(s, axis, activeFields) });
    }
    return { axis, anchors: rows };
  }

  async function fetchGroup(pts, past, label) {
    for (let i = 0; i < pts.length; i += BATCH) {
      const b = pts.slice(i, i + BATCH);
      let j = null, lastErr = '';
      for (let k = 0; k < ATTEMPTS; k++) {
        try { j = await fetchJSON(buildURL(b, vars, past, FC)); break; }
        catch (err) {
          lastErr = err.cause?.code || err.status || err.name || err.message;
          await sleep(err.status === 429 ? 25000 : Math.min(30000, 4000 * (k + 1)));
          console.log(`retry ${k + 1}/${ATTEMPTS} (${label}): ${lastErr}`);
        }
      }
      if (!j) {
        failed += b.length;
        console.log(`batch failed permanently (${lastErr}) — ${failed} anchors missing so far`);
        writeOut(true);
        if (failed > list.length * 0.25) { console.error('Too many anchors failed; keeping the archive as it stands.'); process.exit(1); }
        continue;
      }
      if (!Array.isArray(j)) j = [j];
      j.forEach((x, k) => {
        const [lat, lon] = b[k];
        const key = anchorKey(lat, lon);
        const d = x.daily;
        const freshMap = new Map();
        d.time.forEach((date, n) => {
          const row = {};
          for (const f of activeFields) { const arr = d[f.api]; if (arr) row[f.key] = rnd(arr[n], f.dp); }
          freshMap.set(date, row);
        });
        const prev = store.get(key);
        const merged = prev ? mergeSeries(prev.series, freshMap) : freshMap;
        store.set(key, { lat, lon, elev: x.elevation, u: runStamp, series: trimSeries(merged, axisWanted) });
      });
      counts[label === 'full' ? 'full' : label === 'refetch' ? 'refetch' : 'roll'] += b.length;
      console.log(`${label}: ${Math.min(i + BATCH, pts.length)}/${pts.length}`);
      writeOut(true);
      if (i + BATCH < pts.length) await sleep(GAP);
    }
  }

  if (full.length) await fetchGroup(full, PAST_FULL, 'full');
  if (roll.length) await fetchGroup(roll, PAST_ROLL, 'roll');

  // ---- ragged check: every anchor must cover the shared axis, else refetch it in full ----
  let axis = materialize().axis;
  const ragged = [];
  for (const [k, a] of store) if (axis.some(d => !a.series.has(d))) ragged.push(anchors.get(k) || [a.lat, a.lon]);
  if (ragged.length) {
    console.log(`${ragged.length} anchors diverge from the shared time axis — refetching them in full`);
    await fetchGroup(ragged, PAST_FULL, 'refetch');
    axis = materialize().axis;
    let stillRagged = 0;
    for (const a of store.values()) if (axis.some(d => !a.series.has(d))) stillRagged++;
    if (stillRagged) console.log(`warning: ${stillRagged} anchors still short after refetch — padded with nulls`);
  }

  if (!store.size) { console.error('No anchors in the archive.'); process.exit(1); }
  writeOut(false);

  const out = materialize();
  const nVars = vars.length;
  const fullDays = PAST_FULL + FC, rollDays = PAST_ROLL + FC;
  const costFull = counts.full * callCost(fullDays, nVars);
  const costRefetch = counts.refetch * callCost(fullDays, nVars);
  const costRoll = counts.roll * callCost(rollDays, nVars);
  const costProbe = probe.calls * callCost(2, nVars);
  const total = costFull + costRefetch + costRoll + costProbe;
  const allFull = list.length * callCost(fullDays, nVars);

  console.log(`\nwrote ${WEATHER_FILE} — ${out.anchors.length} anchors, ${out.axis.length} days ` +
    `(${out.axis[0]} .. ${out.axis[out.axis.length - 1]}), today_index ${out.axis.indexOf(today)}` +
    `${failed ? `, ${failed} anchors missing` : ''}${rebuilt ? ', archive rebuilt' : ''}`);
  console.log('--- cost ---');
  console.log(`variables: ${nVars}${probe.dropped.length ? ` (dropped: ${probe.dropped.join(', ')})` : ''}`);
  if (counts.full) console.log(`  full    ${String(counts.full).padStart(4)} anchors x ${fullDays}d = ${costFull.toFixed(1)} calls`);
  if (counts.roll) console.log(`  rolling ${String(counts.roll).padStart(4)} anchors x ${rollDays}d = ${costRoll.toFixed(1)} calls`);
  if (counts.refetch) console.log(`  refetch ${String(counts.refetch).padStart(4)} anchors x ${fullDays}d = ${costRefetch.toFixed(1)} calls`);
  console.log(`  probe   ${String(probe.calls).padStart(4)} requests            = ${costProbe.toFixed(1)} calls`);
  console.log(`  total   ${total.toFixed(1)} calls  (all-full would be ${allFull.toFixed(1)}, ${(allFull / total).toFixed(2)}x more)`);
  console.log(`  per day at 4 runs: ~${(total * 4).toFixed(0)} of Open-Meteo's 10,000 free calls`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
