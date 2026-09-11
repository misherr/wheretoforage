/* A viewport-driven tile loader.

   Deliberately generic: it knows about a manifest, z/x/y addressing, a bake stamp, a fetch budget
   and an eviction cap, and nothing about roads, trails or elevation. The trails layer is its first
   consumer; the 30 m rebuild is meant to be its second, and the whole reason this is a module rather
   than forty lines inside index.html is that the last thing to go wrong in this app was one lookup
   living in one of four paths instead of a shared seam.

   THE STAMP IS LOAD-BEARING, AND THE MANIFEST OWNS IT
   Tiles are fetched with `force-cache` — "use the cached copy whatever its age" — because a tile at
   a given URL never changes. That is right until the data is re-baked, at which point a returning
   viewer keeps the old tiles forever. It has already happened once here, to access-geom.json: the
   server had v4 and the browser kept serving v3 from disk, 53,200 entries against 50,614.

   So the MANIFEST is fetched `no-cache` — it is small and always revalidated — and the stamp it
   carries busts every tile URL beneath it. The caller passes no stamp at all. An earlier version
   took the stamp from the app's loaded access.json, which coupled a map layer to the cell-access
   data and is the same conflation that produced a layer of disconnected stubs. A tile set describes
   itself.

   WHAT IT DOES NOT DO
   No rendering, no styling, no L.Layer. The caller asks which tiles a bounds needs, awaits them, and
   draws whatever it likes. Keeping the fetching and the drawing apart is what lets both be tested:
   this file runs under node with an injected fetch. */

import { tileXY } from './grid.mjs';

export const DEFAULT_MAX_TILES = 96;      // ~1 MB of parsed geometry at z10; a phone pans, it does not teleport
export const DEFAULT_CONCURRENCY = 6;

/* Which z/x/y tiles a lat/lon bounds covers, as "x/y" strings. */
export function tilesForBounds(bounds, z) {
  const a = tileXY(bounds.north, bounds.west, z), b = tileXY(bounds.south, bounds.east, z);
  const out = [];
  for (let x = Math.floor(a.x); x <= Math.floor(b.x); x++)
    for (let y = Math.floor(a.y); y <= Math.floor(b.y); y++) out.push(x + '/' + y);
  return out;
}

export function tileSource({ base, manifestUrl, fetchImpl, max = DEFAULT_MAX_TILES,
                             concurrency = DEFAULT_CONCURRENCY, expectVersion = null,
                             onWarn = (m) => console.warn(m) }) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const loaded = new Map();          // "x/y" -> tile payload, in insertion order for the LRU
  const inflight = new Map();        // "x/y" -> promise
  const missing = new Set();         // tiles the manifest does not list, or that 404'd
  let manifest = null, manifestPromise = null, broken = false;
  const q = s => s ? '?g=' + encodeURIComponent(s) : '';

  async function ensureManifest() {
    if (manifest || broken) return manifest;
    if (!manifestPromise) manifestPromise = (async () => {
      try {
        const r = await doFetch(manifestUrl, { cache: 'no-cache' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (expectVersion != null && j.version !== expectVersion) {
          onWarn(`tile manifest is format v${j.version}, this build reads v${expectVersion} — not loading tiles`);
          broken = true; return null;
        }
        if (!j.z || !Array.isArray(j.tiles)) {
          onWarn('tile manifest has no tile list — not loading tiles');
          broken = true; return null;
        }
        manifest = { z: j.z, tiles: new Set(j.tiles), generated: j.generated || null, meta: j };
        return manifest;
      } catch (err) {
        onWarn('tile manifest unavailable (' + (err.message || err) + ') — the layer will draw nothing');
        broken = true; return null;
      }
    })();
    return manifestPromise;
  }

  function evict() {
    while (loaded.size > max) {
      const oldest = loaded.keys().next().value;
      loaded.delete(oldest);
    }
  }

  async function fetchTile(key) {
    if (loaded.has(key)) { const v = loaded.get(key); loaded.delete(key); loaded.set(key, v); return v; }
    if (missing.has(key)) return null;
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      const [x, y] = key.split('/');
      try {
        const r = await doFetch(`${base}/${manifest.z}/${x}/${y}.json` + q(manifest.generated), { cache: 'force-cache' });
        if (!r.ok) { missing.add(key); return null; }
        const j = await r.json();
        loaded.set(key, j); evict();
        return j;
      } catch (err) {
        /* A failed tile is not remembered as missing: a dropped connection on one pan should not
           blank that ground for the rest of the session. */
        onWarn('tile ' + key + ' failed: ' + (err.message || err));
        return null;
      } finally { inflight.delete(key); }
    })();
    inflight.set(key, p);
    return p;
  }

  return {
    /* Load whatever the bounds needs and return the tiles that are ready. Callers redraw when this
       resolves; a partial result is fine and normal while panning. */
    async ensure(bounds) {
      const m = await ensureManifest();
      if (!m) return [];
      const want = tilesForBounds(bounds, m.z).filter(k => m.tiles.has(k));
      const queue = want.filter(k => !loaded.has(k) && !missing.has(k));
      const worker = async () => { while (queue.length) await fetchTile(queue.shift()); };
      await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, worker));
      return want.map(k => loaded.get(k)).filter(Boolean);
    },
    /* What is already in memory for these bounds, with no fetching — for a synchronous redraw on a
       zoom or a layer toggle, so the map never blanks while tiles are in flight. */
    ready(bounds) {
      if (!manifest) return [];
      return tilesForBounds(bounds, manifest.z).map(k => loaded.get(k)).filter(Boolean);
    },
    get z() { return manifest ? manifest.z : null; },
    /* The manifest itself, for a layer that wants to say what the tiles contain — the network set
       leaves the urban street grid out, and the legend has to be able to say so from the data
       rather than from a constant that could drift away from it. */
    get meta() { return manifest ? manifest.meta : null; },
    get size() { return loaded.size; },
    get failed() { return broken; },
    _debug: { loaded, missing },
  };
}
