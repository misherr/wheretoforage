/* What is actually standing in the woods right now: which rain events have produced cohorts,
   how old each is, and what proportion of them is emerging, button, prime, past or rotten.

   Separate from weather-score.mjs because it answers a different question. analyze() asks "are
   conditions good"; this asks "given the rain that already fell, what would you find today". */
import { clamp, trap } from './util.mjs';
import { analyze } from './weather-score.mjs';

export function stageMix(age){
  return {
    emerging: trap(age,-1,0,3,5),
    buttons:  trap(age,3,5,7,9),
    prime:    trap(age,7,9,15,19),
    past:     trap(age,15,19,22,26),
    rotten:   trap(age,22,26,32,40)
  };
}
export const STAGE_KEYS=['emerging','buttons','prime','past','rotten'];
export const STAGE_LABELS={emerging:'Emerging',buttons:'Buttons',prime:'Prime',past:'Past prime',rotten:'Rotten'};
export function stageBreakdown(p,i){
  const mix={emerging:0,buttons:0,prime:0,past:0,rotten:0}; let tot=0; const events=[];
  for(let d=2; d<=i; d++){
    const P3=(p[d]||0)+(p[d-1]||0)+(p[d-2]||0);
    if(P3<10) continue;
    const P3n=(p[d+1]||0)+(p[d]||0)+(p[d-1]||0);
    if(d<i && P3n>P3) continue;
    const mass=clamp((P3-10)/30,0,1); if(mass<=0) continue;
    const age=i-d, m=stageMix(age);
    let s=0; for(const k of STAGE_KEYS) s+=m[k];
    if(s>0.001){ for(const k of STAGE_KEYS) mix[k]+=mass*m[k]; tot+=mass*s; events.push({age,mm:P3,mass}); }
    d+=2;
  }
  if(tot<=0.001) return null;
  const pct={}; for(const k of STAGE_KEYS) pct[k]=mix[k]/tot;
  let top=STAGE_KEYS[0]; for(const k of STAGE_KEYS) if(pct[k]>pct[top]) top=k;
  return {pct,top,standing:tot,events};
}
export function stageOf(w,i,hab){
  if(hab.score===0||hab.season<0.15) return null;
  const kill=analyze(w,i,hab).kill;
  if(kill==='frost'||kill==='snow') return null;
  const b=stageBreakdown(w.p,i);
  if(!b) return null;
  const pct=b.pct;
  const notes={
    emerging:Math.round(pct.emerging*100)+'% of what is out there is still underground, just emerging',
    buttons:Math.round(pct.buttons*100)+'% of what is out there is in the button stage',
    prime:Math.round(pct.prime*100)+'% of what is out there is at peak',
    past:Math.round(pct.past*100)+'% of what is out there is past prime',
    rotten:Math.round(pct.rotten*100)+'% of what is out there has rotted'
  };
  return {...b, key:b.top, label:STAGE_LABELS[b.top], note:notes[b.top]};
}
