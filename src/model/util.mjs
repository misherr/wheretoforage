/* Numeric curves, unit conversions and the score-band vocabulary — the primitives every other
   model module is written in.

   These are shared on purpose: interp/trap/bell are the shapes the whole model is tuned in, so a
   change to one of them moves habitat, weather and phenology together. They are not general-purpose
   utilities looking for a home. */
export const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
export const lerp=(a,b,t)=>a+(b-a)*t;
export function interp(tbl,x){ if(x<=tbl[0][0])return tbl[0][1]; for(let i=1;i<tbl.length;i++){ if(x<=tbl[i][0]){const [x0,y0]=tbl[i-1],[x1,y1]=tbl[i];return lerp(y0,y1,(x-x0)/(x1-x0));}} return tbl[tbl.length-1][1]; }
export function trap(x,a,b,c,d){ if(x<=a||x>=d)return 0; if(x<b)return (x-a)/(b-a); if(x<=c)return 1; return (d-x)/(d-c); }
export const bell=(x,c,sd)=>Math.exp(-0.5*((x-c)/sd)**2);
export const ft=m=>Math.round(m*3.28084);
export const f=c=>Math.round(c*9/5+32);
export const inch=mm=>(mm/25.4).toFixed(2);
export const fmtDay=iso=>{const d=new Date(iso+'T12:00:00');return d.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});};
export const BANDS = [[25,'Medium','#e2c452'],[45,'Good','#e58a2b'],[65,'High','#d6432c'],[80,'Very high','#8a1a30']];
export function bandOf(s){ let b=null; for(const x of BANDS) if(s>=x[0]) b=x; return b; }
export function labelOf(s){ const b=bandOf(s); return b?b[1]:'Low'; }
