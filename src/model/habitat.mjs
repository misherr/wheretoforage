/* Where and when king boletes can grow: the four regions of Washington, each with its own
   season window and an elevation band that drifts downslope through the fall.

   This is terrain and calendar only — no weather, no vegetation. habitat() answers "could this place
   produce on this day of year", and everything else in the model multiplies that answer down. */
import { interp, trap, bell, lerp, ft } from './util.mjs';

export const CREST = [[45.5,-121.6],[46.2,-121.5],[46.9,-121.5],[47.4,-121.4],[47.9,-121.1],[48.5,-120.85],[49.0,-120.9]];
export const crestLon=lat=>interp(CREST,lat);
export function habitat(lat,lon,elev,doy){
  const H={score:0,zone:'',hosts:'',elevNote:'',season:0,seasonNote:''};
  if(elev==null||isNaN(elev)){H.zone='No terrain data';H.seasonNote='Elevation could not be read here';return H;}
  if(elev<3){H.zone='Water';return H;}
  const east = lon > crestLon(lat);
  const basin = lat>45.9&&lat<47.9&&lon>-120.6&&lon<-117.8&&elev<800;
  if(elev>2100){H.zone='Alpine / subalpine parkland';H.hosts='Above productive forest; sparse whitebark pine, subalpine fir krummholz';H.score=0.05;H.season=0.3;H.seasonNote='Too high and cold for reliable flushes';return H;}
  if(east && (elev<500 || basin)){H.zone='Shrub-steppe / farmland';H.hosts='No ectomycorrhizal conifer hosts';H.season=0;H.seasonNote='Not king bolete country';return H;}
  if(!east && elev<400 && (lon<-123.8 || (lat>48.0&&lon<-123.2))){
    H.zone='Coastal Sitka spruce belt';H.hosts='Sitka spruce, shore pine, western hemlock — dune forests, spruce fringe, campground edges';
    const s=trap(doy,255,278,330,355); H.season=s; H.seasonNote=s>=.9?'Coastal peak (Oct–Nov)':s>0?'Coastal season shoulder':'Coastal season is Oct–Nov';
    H.score=(elev<150?1:lerp(1,.55,(elev-150)/250))*Math.max(s,.08); H.elevNote='Best low, within a few miles of salt water'; return H;
  }
  if(!east && elev<350){
    H.zone='Puget / Chehalis lowland';H.hosts='Mostly Douglas-fir (weak host). Look for planted Sitka spruce, pines and true firs in parks, campuses, shelterbelts';
    const s=trap(doy,272,290,330,342); H.season=s; H.seasonNote=s>0?'Lowland season (Oct–Nov)':'Lowland flushes run Oct–Nov';
    H.score=0.3*Math.max(s,.08); H.elevNote='Spotty; habitat matters more than weather here'; return H;
  }
  if(!east){
    H.zone= (lon<-123.0&&lat>47.3)?'Olympic montane forest':'West Cascades montane forest';
    H.hosts='Pacific silver fir, noble fir, grand fir, western/mountain hemlock, western white pine; Engelmann spruce near the crest. Openings, road cuts, campgrounds under true fir are classic';
    const s=trap(doy,220,237,288,306); const c=interp([[220,1450],[258,1150],[288,800],[319,450]],doy);
    const e=0.3+0.7*bell(elev,c,350)*(elev>1800?0.6:1); H.season=s; H.score=Math.max(s,.06)*e;
    H.seasonNote=s>=.9?'Fall montane peak (late Aug–mid Oct)':s>0?'Fall season shoulder':'Fall season Aug–Oct';
    H.elevNote=`Sweet spot today ≈ ${ft(c-350)}–${ft(c+350)} ft, drifting downslope as fall goes on`; return H;
  }
  // east side
  const hi=elev>=750;
  H.zone= lat<46.8&&lon>-118.6?'Blue Mountains':(lat>47.5&&lon>-119.2?'Okanogan / Selkirk highlands':'East Cascades');
  H.hosts= hi?'Grand fir, subalpine fir, Engelmann spruce, lodgepole & western white pine, Douglas-fir, larch mixes. Spring kings (B. rex-veris) under true fir/pine near snowmelt; fall B. edulis under spruce/fir':'Ponderosa pine / Douglas-fir transition — spring kings possible, fall spotty';
  const fs=trap(doy,236,250,293,306); const fc=interp([[236,1500],[262,1300],[290,1000],[306,750]],doy);
  const fe=0.3+0.7*bell(elev,fc,350);
  const ss=trap(doy,128,140,176,192); const scn=interp([[128,800],[160,1250],[192,1650]],doy);
  const se=0.3+0.7*bell(elev,scn,300);
  const fall=fs*fe, spring=ss*se;
  H.season=Math.max(fs,ss);
  H.score=(hi?1:0.35)*Math.max(fall,spring,.06);
  if(ss>0&&spring>=fall){H.seasonNote=ss>=.9?'Spring king peak (late May–June)':'Spring king shoulder';H.elevNote=`Spring kings follow the snowline; ≈ ${ft(scn-300)}–${ft(scn+300)} ft now`;}
  else {H.seasonNote=fs>=.9?'Fall east-side peak (Sept–mid Oct)':fs>0?'Fall season shoulder':'Fall season Sept–Oct; spring kings May–June';H.elevNote=`Sweet spot today ≈ ${ft(fc-350)}–${ft(fc+350)} ft`;}
  return H;
}
/* does this spot ever hold king boletes? (season-independent gate, so the cell set is stable year-round) */
export function everHabitat(lat,lon,elev,doy){ return Math.max(habitat(lat,lon,elev,doy).score,habitat(lat,lon,elev,160).score,habitat(lat,lon,elev,275).score,habitat(lat,lon,elev,300).score); }
