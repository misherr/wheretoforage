/* How good the host trees are, from LANDFIRE cover, height and vegetation type.

   This is the model's species discrimination: a Sitka spruce stand and a logged Douglas-fir
   plantation get the same weather and the same terrain, and this is the only thing that separates
   them. It was inert statewide for a while and nothing looked wrong — see HOST_UNKNOWN below. */
import { clamp } from './util.mjs';

export function fCanopy(c){ return c<10?0.15:c<25?0.15+0.85*(c-10)/15:c<=75?1:0.85; }
export function fHeight(h){ return h<3?0.05:h<8?0.05+0.45*(h-3)/5:h<15?0.5+0.5*(h-8)/7:1; }
// host quality of a LANDFIRE vegetation type for king boletes, by name
export const HOST_RULES=[
  [/sitka spruce|coastal.*spruce/i,1.0,'Sitka spruce (coastal king country)'],
  [/silver fir|mountain hemlock|subalpine|spruce-fir|engelmann|noble fir|red fir/i,1.0,'true fir / mountain hemlock / spruce'],
  [/grand fir|white fir|mixed conifer|western white pine|lodgepole|mesic.*conifer/i,0.8,'mixed conifer'],
  [/western hemlock|douglas-fir.*hemlock|hemlock.*douglas-fir/i,0.6,'Douglas-fir – western hemlock'],
  [/ponderosa|larch|dry.*douglas-fir|douglas-fir.*dry|douglas-fir woodland/i,0.4,'dry pine / Douglas-fir'],
  [/douglas-fir/i,0.45,'Douglas-fir'],
  [/harvest|regenerat|plantation|managed tree/i,0.25,'recently logged / young plantation'],
  [/krummholz|parkland|woodland/i,0.3,'open subalpine woodland'],
  [/hardwood|oak|aspen|alder|cottonwood|maple|riparian|deciduous|broadleaf/i,0.1,'hardwood / riparian'],
  [/shrub|grass|meadow|steppe|prairie|sparse|barren|snow|ice|water|develop|urban|agricultur|crop|pasture|orchard|vineyard|marsh|wetland|bog|fen|quarr|mine|road|burn|rock|talus|scree|dune|beach|salt|alpine/i,0,'not forest'],
  [/forest|conifer|pine|fir|spruce|hemlock|cedar/i,0.5,'conifer forest']
];
export function hostOf(name){ if(!name) return null; for(const [re,sc,lab] of HOST_RULES) if(re.test(name)) return {sc,lab}; return {sc:0.3,lab:'other vegetation'}; }
/* Host quality when the vegetation type is unknown. This used to be 1.0, i.e. a cell with no EVT was
   scored as though its host trees were ideal — so while EVT was broken, a logged Douglas-fir
   plantation ranked identically to a Sitka spruce stand, and every forested cell in the state was
   optimistic. 0.4 sits below Douglas-fir (0.45) and dry pine (0.4 is the same, deliberately): unknown
   must never outrank known-mediocre. It is a penalty for absent data, not an estimate of anything. */
export const HOST_UNKNOWN=0.4;
export function vegMult(v){ return v.treeFrac===0?0:clamp(v.treeFrac*fCanopy(v.canopy)*fHeight(v.height)*(v.host==null?HOST_UNKNOWN:Math.max(v.host,0.02)),0,1); }
export function vegSummary(evt,evc,evh,evtNames){
  let n=0,tree=0,canopy=0,ht=0,host=0,hn=0; const names={};
  for(let k=0;k<evc.length;k++){ n++; const c=evc[k], h=evh[k], t=evt[k];
    const isTree=c!=null&&c>=101&&c<=199; if(isTree){ tree++; canopy+=c-100; ht+=(h!=null&&h>=101&&h<=199)?h-100:(h!=null&&h>=1&&h<=100?h:10); }
    const name=evtNames&&t!=null?evtNames.get(t):null; if(name){ names[name]=(names[name]||0)+1; const hs=hostOf(name); if(isTree||hs.sc===0){ host+=hs.sc; hn++; } } }
  if(!n) return null;
  const treeFrac=tree/n, cv=tree?canopy/tree:0, hh=tree?ht/tree:0, hs=hn?host/hn:null;
  const top=Object.entries(names).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,v])=>({name:k,share:v/n,host:hostOf(k)}));
  const v={treeFrac,canopy:cv,height:hh,host:hs,top}; v.mult=vegMult(v); return v;
}
