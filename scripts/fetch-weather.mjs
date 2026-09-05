// Fetches Open-Meteo weather for every anchor implied by data/cells.json and writes data/weather.json.
// Run daily by .github/workflows/weather.yml. Node 20+, no dependencies.
import fs from 'node:fs';
const ANCHOR=0.2, PAST=26, FC=8;
const cells=JSON.parse(fs.readFileSync('data/cells.json','utf8'));
const snap=(lat,lon)=>[Math.floor(lat/ANCHOR)*ANCHOR+ANCHOR/2, Math.floor(lon/ANCHOR)*ANCHOR+ANCHOR/2];
const anchors=new Map();
for(const r of cells.rows){ const a=snap(r[0],r[1]); anchors.set(a[0].toFixed(4)+','+a[1].toFixed(4),a); }
const list=[...anchors.values()];
console.log(`${list.length} anchors`);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const VARS=['precipitation_sum','temperature_2m_max','temperature_2m_min','et0_fao_evapotranspiration','snowfall_sum'];
let useRH=true, time=null; const out=[];
async function fetchBatch(b){
  const url=v=>`https://api.open-meteo.com/v1/forecast?latitude=${b.map(a=>a[0].toFixed(3)).join(',')}&longitude=${b.map(a=>a[1].toFixed(3)).join(',')}&daily=${v.join(',')}&past_days=${PAST}&forecast_days=${FC}&timezone=America%2FLos_Angeles`;
  for(let k=0;k<10;k++){
    const r=await fetch(url(useRH?[...VARS,'relative_humidity_2m_mean']:VARS));
    if(r.ok) return r.json();
    const reason=(await r.json().catch(()=>({}))).reason||'';
    if(r.status===400&&useRH){ useRH=false; continue; }
    console.log(`retry ${r.status} ${reason}`);
    await sleep(r.status===429?25000:6000);
  }
  throw new Error('weather fetch failed after retries');
}
for(let i=0;i<list.length;i+=50){
  const b=list.slice(i,i+50); let j=await fetchBatch(b); if(!Array.isArray(j)) j=[j];
  const r1=arr=>(arr||[]).map(v=>v==null?null:Math.round(v*10)/10);
  j.forEach((x,k)=>{ const d=x.daily; time=time||d.time;
    out.push({lat:+b[k][0].toFixed(4),lon:+b[k][1].toFixed(4),elev:x.elevation,p:r1(d.precipitation_sum),tmax:r1(d.temperature_2m_max),tmin:r1(d.temperature_2m_min),et0:r1(d.et0_fao_evapotranspiration),snow:r1(d.snowfall_sum),rh:d.relative_humidity_2m_mean?d.relative_humidity_2m_mean.map(v=>v==null?null:Math.round(v)):null}); });
  console.log(`${out.length}/${list.length}`);
  if(i+50<list.length) await sleep(8000); // stay well under the per-minute limit
}
fs.writeFileSync('data/weather.json',JSON.stringify({generated:new Date().toISOString(),past_days:PAST,forecast_days:FC,time,anchors:out}));
console.log('wrote data/weather.json');
