// Fetches Open-Meteo weather for every anchor implied by data/cells.json and writes data/weather.json.
// Run on a schedule by .github/workflows/weather.yml. Node 20+, no dependencies.
import fs from 'node:fs';

const ANCHOR = 0.2, PAST = 26, FC = 8;
const BATCH = 50;               // anchors per request
const GAP = 8000;               // ms between batches (stay under the per-minute limit)
const REQ_TIMEOUT = 45000;      // ms per attempt
const ATTEMPTS = 8;

if (!fs.existsSync('data/cells.json')) {
  console.error("data/cells.json not found — export it from the app first (info panel -> Export cells.json).");
  process.exit(1);
}
let cells;
try { cells = JSON.parse(fs.readFileSync('data/cells.json', 'utf8')); }
catch (e) { console.error('data/cells.json is not valid JSON:', e.message); process.exit(1); }
if (!cells.rows || !cells.rows.length) { console.error('data/cells.json has no rows — re-export it after a complete load.'); process.exit(1); }

const snap = (lat, lon) => [Math.floor(lat / ANCHOR) * ANCHOR + ANCHOR / 2, Math.floor(lon / ANCHOR) * ANCHOR + ANCHOR / 2];
const anchors = new Map();
for (const r of cells.rows) { const a = snap(r[0], r[1]); anchors.set(a[0].toFixed(4) + ',' + a[1].toFixed(4), a); }
const list = [...anchors.values()];
console.log(`${list.length} anchors`);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const VARS = ['precipitation_sum', 'temperature_2m_max', 'temperature_2m_min', 'et0_fao_evapotranspiration', 'snowfall_sum'];
let useRH = true, time = null;

// resume: keep anchors already fetched today from a previous (possibly failed) run
const out = [];
const have = new Set();
if (fs.existsSync('data/weather.json')) {
  try {
    const prev = JSON.parse(fs.readFileSync('data/weather.json', 'utf8'));
    const fresh = prev.generated && (Date.now() - new Date(prev.generated)) < 5 * 3600e3;
    if (fresh && prev.partial && prev.time) {
      time = prev.time;
      for (const a of prev.anchors) { out.push(a); have.add(a.lat.toFixed(4) + ',' + a.lon.toFixed(4)); }
      console.log(`resuming: ${out.length} anchors already fetched`);
    }
  } catch (_) { }
}

function writeOut(partial) {
  fs.writeFileSync('data/weather.json', JSON.stringify({
    generated: new Date().toISOString(), past_days: PAST, forecast_days: FC, partial, time, anchors: out
  }));
}

async function fetchBatch(b) {
  let lastErr = '';
  for (let k = 0; k < ATTEMPTS; k++) {
    try {
      const url = v => `https://api.open-meteo.com/v1/forecast?latitude=${b.map(a => a[0].toFixed(3)).join(',')}&longitude=${b.map(a => a[1].toFixed(3)).join(',')}&daily=${v.join(',')}&past_days=${PAST}&forecast_days=${FC}&timezone=America%2FLos_Angeles`;
      const r = await fetch(url(useRH ? [...VARS, 'relative_humidity_2m_mean'] : VARS), { signal: AbortSignal.timeout(REQ_TIMEOUT) });
      if (r.ok) return r.json();
      const reason = (await r.json().catch(() => ({}))).reason || '';
      if (r.status === 400 && useRH) { console.log('humidity unavailable, continuing without it'); useRH = false; continue; }
      lastErr = `HTTP ${r.status} ${reason}`;
      await sleep(r.status === 429 ? 25000 : 6000);
    } catch (err) {                       // connect timeout, DNS, socket reset
      lastErr = err.cause?.code || err.name || err.message;
      await sleep(Math.min(30000, 4000 * (k + 1)));
    }
    console.log(`retry ${k + 1}/${ATTEMPTS}: ${lastErr}`);
  }
  const e = new Error(lastErr); e.exhausted = true; throw e;
}

let failed = 0;
for (let i = 0; i < list.length; i += BATCH) {
  const b = list.slice(i, i + BATCH).filter(a => !have.has(a[0].toFixed(4) + ',' + a[1].toFixed(4)));
  if (!b.length) continue;
  let j;
  try { j = await fetchBatch(b); }
  catch (err) {
    failed += b.length;
    console.log(`batch failed permanently (${err.message}) — ${failed} anchors missing so far`);
    writeOut(true);                      // checkpoint so a rerun resumes here
    if (failed > list.length * 0.25) { console.error('Too many anchors failed; leaving the previous weather file in place.'); process.exit(1); }
    continue;
  }
  if (!Array.isArray(j)) j = [j];
  const r1 = arr => (arr || []).map(v => v == null ? null : Math.round(v * 10) / 10);
  j.forEach((x, k) => {
    const d = x.daily; time = time || d.time;
    out.push({
      lat: +b[k][0].toFixed(4), lon: +b[k][1].toFixed(4), elev: x.elevation,
      p: r1(d.precipitation_sum), tmax: r1(d.temperature_2m_max), tmin: r1(d.temperature_2m_min),
      et0: r1(d.et0_fao_evapotranspiration), snow: r1(d.snowfall_sum),
      rh: d.relative_humidity_2m_mean ? d.relative_humidity_2m_mean.map(v => v == null ? null : Math.round(v)) : null
    });
  });
  console.log(`${out.length}/${list.length}`);
  writeOut(true);
  if (i + BATCH < list.length) await sleep(GAP);
}

if (!out.length) { console.error('No anchors fetched.'); process.exit(1); }
writeOut(false);
console.log(`wrote data/weather.json — ${out.length} anchors${failed ? `, ${failed} missing` : ''}`);
