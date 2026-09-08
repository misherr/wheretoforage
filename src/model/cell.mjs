/* One scored cell: habitat x weather x vegetation, multiplied together.

   This is the composition root of the model — the only place the three halves meet, and the place
   where a cell that is out of season, out of range or not forest is short-circuited to zero. The app
   calls makeEntry() once per baked cell and applyVeg() again when LANDFIRE data arrives for it, so
   these two functions are the shipped scoring path; the model regression suite drives them directly
   for exactly that reason. */
import { habitat, everHabitat } from './habitat.mjs';
import { adjustWeather, fullAnalysis } from './weather-score.mjs';

export function makeEntry(lat,lon,size,elev,terr,w,doy){
  const hab=habitat(lat,lon,elev,doy);
  const e={lat,lon,size,elev,terr,hab,veg:null,w:null,A:null,failed:false};
  if(hab.score<=0.08&&everHabitat(lat,lon,elev,doy)<=0.08){ e.A={now:{score:0},fut:[],best:{score:0},fRain:0,hab}; return e; }
  if(!w){ e.failed=true; return e; }
  e.w=adjustWeather(w,elev,terr); e.A=hab.score<=0.08?{now:{score:0},fut:[],best:{score:0},fRain:0,hab}:fullAnalysis(e.w,hab); return e;
}
export function applyVeg(e,doy){
  const base=habitat(e.lat,e.lon,e.elev,doy); const v=e.veg; base.score*=v.mult;
  if(v.mult===0){ base.zone+=' — no forest'; base.seasonNote=v.treeFrac===0?'LANDFIRE maps no tree cover here':'Vegetation unsuitable'; }
  else if(v.height<8){ base.elevNote=(base.elevNote?base.elevNote+' · ':'')+'Young regenerating stand ('+Math.round(v.height)+' m) — low odds until it matures'; }
  else if(v.host!=null&&v.host<0.5){ base.elevNote=(base.elevNote?base.elevNote+' · ':'')+'Weak host forest type here — look for pockets of true fir, spruce or pine'; }
  e.hab=base; if(e.w) e.A=fullAnalysis(e.w,base); else if(base.score<=0.08) e.A={now:{score:0},fut:[],best:{score:0},fRain:0,hab:base};
}
