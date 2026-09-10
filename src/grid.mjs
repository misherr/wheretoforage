/* The cell lattice, the state outline, and slope/aspect from an elevation grid.

   This is the geometry that the app and the bake script must agree on exactly. It lived in
   index.html while data/cells.json was produced by a button inside the app, so there was only one
   copy by construction. scripts/build-cells.mjs now produces that file, and a second copy of these
   constants is precisely the failure this repo has already paid for twice: anchorFor() vs
   snapLattice() disagreed for 5,844 of 48,032 cells, and snapping cells straight to 0.2 degrees
   instead of chaining through the dense anchor orphaned another 74. A lattice defined in two places
   drifts, and the symptom is a blank map rather than an error.

   Not part of src/model/: this is where cells are, not what grows in them. The model takes
   lat/lon/elev/doy and does not care how they were chosen. */

// 1 sq mi cells at 47.5 degrees N, grouped in 4x4 blocks
export const DLAT = 0.0145, DLON = 0.0214, BLK = 4;
export const BLAT = DLAT * BLK, BLON = DLON * BLK;

/* Washington, coarsely — [lon, lat] pairs, deliberately generous offshore so the coastal spruce
   fringe is not clipped. It is a rendering/enumeration bound, not a legal boundary. */
export const WA = [[-123.32,49.0],[-117.03,49.0],[-117.04,46.0],[-116.92,45.99],[-118.98,45.99],[-119.5,45.92],[-120.4,45.7],[-121.2,45.7],[-121.9,45.68],[-122.4,45.57],[-122.8,45.63],[-123.1,46.17],[-123.6,46.25],[-124.1,46.28],[-124.15,46.9],[-124.25,47.3],[-124.45,47.8],[-124.75,48.4],[-123.6,48.2],[-123.1,48.18],[-122.75,48.15],[-122.9,48.45],[-123.2,48.6],[-123.32,48.8]];
export function inWA(lat,lon){ let ins=false; for(let i=0,j=WA.length-1;i<WA.length;j=i++){ const [xi,yi]=WA[i],[xj,yj]=WA[j]; if((yi>lat)!==(yj>lat) && lon<(xj-xi)*(lat-yi)/(yj-yi)+xi) ins=!ins;} return ins; }

/* The lattice. Cell (i,j) is centred at ((i+0.5)*DLAT, (j+0.5)*DLON), fixed to 5 decimal places so
   that the same cell always produces the same key and the same string in cells.json. cellKey uses
   floor with an epsilon because a centre coordinate divided back by its own spacing lands a hair
   under the integer often enough to matter. */
export const cellCenter = (i,j) => [+((i+0.5)*DLAT).toFixed(5), +((j+0.5)*DLON).toFixed(5)];
export const cellKey = (la,lo) => Math.floor(la/DLAT+1e-9)+':'+Math.floor(lo/DLON+1e-9);
export const cellIndex = (la,lo) => [Math.floor(la/DLAT+1e-9), Math.floor(lo/DLON+1e-9)];
// The block centre is a lattice *corner*, not a cell centre — 4x4 cells have no middle cell.
export const blockCentre = (I,J) => [+((I*BLK+2)*DLAT).toFixed(5), +((J*BLK+2)*DLON).toFixed(5)];

/* The statewide enumeration bound. The app walks these same ranges to build its block list, so a
   change here changes both sides at once, which is the point. */
export const STATE = { lat0: 45.5, lat1: 49.0, lon0: -124.8, lon1: -116.9 };
export function blockRange(b = STATE){
  return { I0: Math.floor(b.lat0/BLAT), I1: Math.ceil(b.lat1/BLAT),
           J0: Math.floor(b.lon0/BLON), J1: Math.ceil(b.lon1/BLON) };
}

/* terrain: slope & aspect from an elevation grid.

   getE(lat,lon) looks up an elevation that has already been read; it returns null/undefined for a
   point that was never sampled, and the one-sided fallbacks below are what handle that. A cell on
   the edge of the sampled area therefore gets a one-sided gradient rather than nothing — which also
   means slope and aspect depend on how much of the neighbourhood was sampled, not just on the
   terrain. The bake script samples every in-state cell of every retained block before computing any
   terrain, so the answer does not depend on the order cells are visited. */
export function terrainAt(getE,lat,lon,d,dl){
  dl=dl??d;
  const eN=getE(lat+d,lon),eS=getE(lat-d,lon),eE=getE(lat,lon+dl),eW=getE(lat,lon-dl),e0=getE(lat,lon);
  if(e0==null) return {slope:0,aspect:null};
  const my=d*111320, mx=dl*111320*Math.cos(lat*Math.PI/180);
  const dzdy=(eN!=null&&eS!=null)?(eN-eS)/(2*my):(eN!=null?(eN-e0)/my:(eS!=null?(e0-eS)/my:0));
  const dzdx=(eE!=null&&eW!=null)?(eE-eW)/(2*mx):(eE!=null?(eE-e0)/mx:(eW!=null?(e0-eW)/mx:0));
  const slope=Math.atan(Math.hypot(dzdx,dzdy))*180/Math.PI;
  let aspect=slope<1.5?null:(Math.atan2(-dzdx,-dzdy)*180/Math.PI+360)%360; // direction the slope faces
  return {slope,aspect};
}

/* The elevation/weather cache key, shared by the app and the bake script.

   Five decimal places, matching what cellCenter() returns. It used to truncate to four, and that
   was a bug rather than a rounding nicety: terrainAt() looks up its neighbour as `lat + DLAT`, and
   that sum lands a hair *below* the neighbour's own 5dp value often enough that the two rounded to
   different strings — 77 of every 300 cells in latitude, 0 in longitude. Those cells silently took a
   one-sided north-south gradient with the neighbour's elevation already sitting in the cache.

   At five decimals the neighbour lookup hits 300 of 300, and distinct cells still never collide
   (verified across the state at both 4 and 5 dp). Weather anchors are unaffected: snapLattice()
   already rounds them to 4 dp, and a 4dp value formatted to 5 is stable. */
export const pointKey = (lat,lon) => lat.toFixed(5)+','+lon.toFixed(5);
