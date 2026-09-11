/* Coordinates in and out.

   Out: one canonical decimal-degrees string, because that is what onX, Gaia, CalTopo, AllTrails and
   Google Maps all accept in their search boxes. Five decimal places is about a metre, matches
   pointKey, and is more precision than a square-mile cell deserves — but the point of the readout is
   to paste a spot into another app, and the spot is a coordinate rather than a cell.

   In: whatever the user has in the clipboard. That is mostly decimal degrees, and sometimes the
   degree/minute/second form the iPhone Compass app shows, which is what you get when someone reads a
   position off their phone in the field and types it in later. Both are accepted, in either order of
   hemisphere marker, with any of the symbols people and apps actually use.

   Parsing is deliberately strict about what it ACCEPTS and never guesses at what it cannot read:
   a string that does not yield two coordinates returns null and the UI says so, rather than dropping
   a marker somewhere plausible. A pin in the wrong drainage is worse than an error message. */

/* Unicode makes this messier than it looks: primes (U+2032/2033), curly quotes, the masculine
   ordinal that some apps emit instead of a degree sign, and non-breaking spaces all show up in
   pasted text. Normalise first so the grammar below only has to know about ' and ". */
export function normalizeCoordText(s) {
  return String(s == null ? '' : s)
    .replace(/[º˚⁰]/g, '°')             // º ˚ ⁰ -> °
    .replace(/[′’ʼ´`]/g, "'")           // ′ ’ ʼ ´ ` -> '
    .replace(/[″”“ˮ]/g, '"')            // ″ ” “ -> "
    .replace(/[−–—]/g, '-')                  // − – — -> -
    .replace(/[   \s]+/g, ' ')
    .trim();
}

/* One coordinate: an optional sign, an optional leading hemisphere letter, degrees, then optional
   minutes and seconds, then an optional trailing hemisphere letter. Degrees may be decimal (plain
   DD) or whole with minutes after it (DMS / degrees-decimal-minutes). */
const PART = new RegExp(
  '(-)?\\s*([NSEW])?\\s*' +
  '(\\d+(?:\\.\\d+)?)\\s*\\u00B0?\\s*' +
  "(?:(\\d+(?:\\.\\d+)?)\\s*'\\s*)?" +
  '(?:(\\d+(?:\\.\\d+)?)\\s*"\\s*)?' +
  '\\s*([NSEW])?', 'gi');

function parts(text) {
  const out = [];
  PART.lastIndex = 0;
  let m;
  while ((m = PART.exec(text)) !== null) {
    if (!m[0].trim()) { PART.lastIndex++; continue; }        // a zero-width match cannot advance
    const [, sign, pre, deg, min, sec, post] = m;
    let v = Number(deg) + (min ? Number(min) / 60 : 0) + (sec ? Number(sec) / 3600 : 0);
    if (!Number.isFinite(v)) continue;
    /* A leading letter means the trailing one belongs to the NEXT coordinate, not this one:
       "N47.45125 W119.93630" would otherwise swallow the W and leave the longitude positive, which
       is the Indian Ocean. Hand the letter back by rewinding to it. */
    if (pre && post) PART.lastIndex = m.index + m[0].lastIndexOf(post);
    const hemi = (pre || post || '').toUpperCase();
    if (sign === '-' || hemi === 'S' || hemi === 'W') v = -v;
    out.push({ v, hemi, dms: !!(min || sec) });
    if (out.length > 2) break;                 // three is already too many; see parseCoords
  }
  return out;
}

/* Accepts, among others:
     47.45125, -119.93630            decimal degrees, the Google Maps / onX paste
     47.45125 -119.9363              whitespace separated
     N 47.45125, W 119.93630         hemisphere first
     47.45125 N, 119.93630 W         hemisphere last
     47°27'04" N  119°56'11" W       iPhone Compass
     47° 27.07' N, 119° 56.18' W     degrees and decimal minutes
   Returns {lat, lon, dms} or null. */
export function parseCoords(input) {
  const text = normalizeCoordText(input);
  if (!text) return null;
  const p = parts(text);
  /* Exactly two, and not two-of-several. "47 27.07 N 119 56.18 W" is degrees and decimal minutes
     written without symbols, and it is genuinely ambiguous with the pair (47, 27.07) — so it is
     refused rather than read as one of them. Symbols are what make a minutes form unambiguous, and
     every app that emits one includes them. */
  if (p.length !== 2) return null;

  const ns = p.filter(x => x.hemi === 'N' || x.hemi === 'S');
  const ew = p.filter(x => x.hemi === 'E' || x.hemi === 'W');
  let lat, lon;
  if (ns.length === 1 && ew.length === 1) {
    /* Hemisphere letters are an explicit statement of which is which, so honour them even when the
       numbers are in the other order — "W119.9363 N47.45125" is unambiguous. */
    lat = ns[0].v; lon = ew[0].v;
  } else if (ns.length === 1) {
    lat = ns[0].v; lon = p[p.indexOf(ns[0]) === 0 ? 1 : 0].v;
  } else if (ew.length === 1) {
    lon = ew[0].v; lat = p[p.indexOf(ew[0]) === 0 ? 1 : 0].v;
  } else {
    /* No letters: latitude first, which is the universal convention for a bare pair. The one repair
       worth making is an unambiguous one — a first value beyond 90 cannot be a latitude, and if the
       second can be, the pair was written lon,lat. Anything less clear-cut returns null rather than
       being guessed at. */
    lat = p[0].v; lon = p[1].v;
    if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) { const t = lat; lat = lon; lon = t; }
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon, dms: p.some(x => x.dms) };
}

/* The readout. Plain, unpunctuated except for the comma every other app expects, and with the
   negative sign rather than a W — "-119.93630" pastes correctly everywhere, "119.93630 W" does not. */
export const formatCoords = (lat, lon) => lat.toFixed(5) + ', ' + lon.toFixed(5);
