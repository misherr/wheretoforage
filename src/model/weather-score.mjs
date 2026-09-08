/* How favourable a cell's weather is: the flush trigger, the soil bucket, the temperature
   window, humidity, and the frost/snow/heat kill switches.

   adjustWeather() lives here too because it is what makes the score per-cell rather than per-anchor:
   it moves an anchor's series to a cell's own elevation and aspect before anything reads it. */
import { clamp, f, inch, fmtDay, labelOf } from './util.mjs';

/* Standard atmosphere lapse rate, °C per metre. Used to move an anchor's temperature to a cell's
   own elevation; the archive's dense past grid exists so that this is a short extrapolation. */
export const LAPSE=0.0065;
/* adjust anchor weather to a specific elevation + aspect */
export function adjustWeather(w,elev,terr){
  const dz=elev-(w.elev??elev); const dT=-LAPSE*dz;
  const sw=terr?clamp(terr.slope/15,0,1):0; const north=terr&&terr.aspect!=null?Math.cos(terr.aspect*Math.PI/180):0; // +1 north, -1 south
  const tAsp= -1.0*north*sw;              // south faces run warmer, north cooler (°C)
  const etMul= 1-0.18*north*sw;           // north slopes lose less water, south more
  return {time:w.time,today:w.today,p:w.p,snow:w.snow,rh:w.rh,elev:elev,
    tmax:w.tmax.map(t=>t==null?t:t+dT+tAsp*1.4), tmin:w.tmin.map(t=>t==null?t:t+dT+tAsp*0.6),
    et0:w.et0.map(v=>(v??3)*etMul), meta:{dz,dT,tAsp,etMul,anchorElev:w.elev}};
}
export function kernel(a){ if(a<3)return 0; if(a<9)return (a-3)/6; if(a<=15)return 1; if(a<24)return (24-a)/9; return 0; }
export function tmaxSuit(t){ if(t<=2)return 0; if(t<10)return (t-2)/8; if(t<=22)return 1; if(t<30)return (30-t)/8; return 0; }
export function tminSuit(t){ if(t<=-2)return 0; if(t<3)return (t+2)/5; if(t<=13)return 1; if(t<19)return (19-t)/6; return 0; }
export function analyze(w,i,hab){
  const {p,tmax,tmin,et0,snow,rh}=w; const n=p.length;
  const at=(arr,k)=>arr[clamp(k,0,n-1)]??0;
  // flush trigger: best rain event 3–24 days before i
  let F=0,ev=null;
  for(let d=Math.max(2,i-24);d<=i-3;d++){ const P3=at(p,d)+at(p,d-1)+at(p,d-2); const m=clamp((P3-10)/30,0,1); const v=m*kernel(i-d); if(v>F){F=v;ev={age:i-d,mm:P3,date:w.time[d]};} }
  // most recent meaningful rain (any age)
  let last=null; for(let d=i;d>=Math.max(2,i-30);d--){ const P3=at(p,d)+at(p,d-1)+at(p,d-2); if(P3>=10){last={age:i-d,mm:P3,date:w.time[d]};break;} }
  // soil bucket
  let S=20; for(let d=Math.max(0,i-30);d<=i;d++){ S=clamp(S+at(p,d)-0.7*(et0[d]??3),0,80); } const M=clamp(S/40,0,1);
  let dry=0; for(let d=i;d>=0&&at(p,d)<1;d--)dry++;
  // temperature (last 5 days)
  let X=0,c=0; for(let d=i-4;d<=i;d++){ if(d<0)continue; X+=tmaxSuit(at(tmax,d))*tminSuit(at(tmin,d)); c++; } X=c?X/c:0.5;
  let K=1,kill=null; let mn=99,sn=0,mx=-99;
  for(let d=i-6;d<=i;d++){ if(d<0)continue; mn=Math.min(mn,at(tmin,d)); sn+=snow[d]??0; }
  for(let d=i-2;d<=i;d++){ if(d<0)continue; mx=Math.max(mx,at(tmax,d)); }
  if(sn>=3){K=0.05;kill='snow';} else if(mn<=-3){K=0.15;kill='frost';} else if(mx>=30){K=0.5;kill='heat';}
  let rhm=null,rc=0,rs=0; for(let d=i-2;d<=i;d++){ if(d<0)continue; if(rh&&rh[d]!=null){rs+=rh[d];rc++;} } if(rc){rhm=rs/rc;}
  const Hu= rhm==null?0.75:0.2+0.8*clamp((rhm-40)/30,0,1);
  let tm1=0,tm2=0,c1=0,c2=0; for(let d=i-3;d<=i;d++){if(d>=0){tm1+=(at(tmax,d)+at(tmin,d))/2;c1++;}} for(let d=i-9;d<=i-4;d++){if(d>=0){tm2+=(at(tmax,d)+at(tmin,d))/2;c2++;}}
  const drop=(c1&&c2)?(tm2/c2-tm1/c1):0; const C= drop>=2?0.1:0;
  const score=clamp(100*hab.score*Math.pow(F,0.6)*Math.pow(M,0.4)*X*Math.sqrt(Hu)*K*(1+C),0,100);
  return {score,F,M,X,Hu,K,C,kill,ev,last,dry,bucket:S,rh:rhm,mn,mx,drop};
}
export function fullAnalysis(w,hab){
  const i=w.today; const now=analyze(w,i,hab);
  const fut=[]; for(let t=0;t<=7&&i+t<w.time.length;t++){ const r=analyze(w,i+t,hab); let r7=0; for(let d=i+t-6;d<=i+t;d++) if(d>=0) r7+=w.p[d]||0; fut.push({date:w.time[i+t],score:r.score,rain:w.p[i+t],rain7:r7,M:r.M,F:r.F}); }
  let best=fut[0]; for(const x of fut) if(x.score>best.score+0.5) best=x;
  const fRain=fut.slice(1).reduce((a,x)=>a+(x.rain||0),0);
  return {now,fut,best,fRain,hab};
}
export function verdict(A){
  const {now,fut,best,fRain,hab}=A; const s=Math.round(now.score); const bs=Math.round(best.score);
  const lab=labelOf(s).toLowerCase();
  if(hab.score===0) return `Not king bolete habitat — ${hab.zone.toLowerCase()}.`;
  if(hab.season<0.15) return `Out of season here. ${hab.seasonNote}.`;
  if(now.kill==='snow') return `Snow on the ground. Fall flush is over at this elevation.`;
  if(now.kill==='frost') return `Hard frost in the last week (${f(now.mn)}°F). The fall flush is over here — look lower or on the coast.`;
  const evTxt=now.ev?`${inch(now.ev.mm)}" of rain ${now.ev.age} days ago`:null;
  if(s>=65) return `<b>Prime right now.</b> ${evTxt?evTxt+' is producing':'Steady moisture is producing'}; temps ${f(now.mn)}–${f(now.mx)}°F. Go.`;
  if(bs>=s+10 && bs>=30){
    const lastTxt=now.last&&now.last.age<=6?`It rained ${inch(now.last.mm)}" ${now.last.age===0?'today':now.last.age+' days ago'}.`:(fRain>8?`${inch(fRain)}" of rain is forecast.`:'');
    return `${lastTxt} Chances are <b>${lab}</b> today (${s}) but should climb to <b>${labelOf(bs).toLowerCase()}</b> (${bs}) around ${fmtDay(best.date)} as the flush comes up.`;
  }
  if(now.ev&&now.ev.age>15&&s<45) return `<b>Past prime.</b> The flush from ${inch(now.ev.mm)}" on ${fmtDay(now.ev.date)} is ${now.ev.age} days old and fading — you may find older, buggy caps. Needs new rain.`;
  if(now.F===0&&now.dry>=10) return `<b>Dry.</b> No trigger rain (≥1") in the last ${now.dry} days and soil moisture is ${Math.round(now.M*100)}%. Not worth the drive.`;
  if(now.F===0) return `No flush trigger yet — the last real soak was too recent or too light. Watch the forecast; a 1" storm followed by 7–12 cool days is what you want.`;
  if(now.kill==='heat') return `Rain history is fine but highs near ${f(now.mx)}°F are shutting fruiting down. Wait for the cool-down.`;
  if(now.X<0.4) return `Moisture is there, but temperatures (${f(now.mn)}–${f(now.mx)}°F) are outside the fruiting window. Marginal.`;
  return `<b>${labelOf(s)}</b> chance. ${evTxt?evTxt+', soil moisture '+Math.round(now.M*100)+'%.':''} ${bs>s?`Slightly better around ${fmtDay(best.date)}.`:'Trend is flat to declining.'}`;
}
