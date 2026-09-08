// Minimal static file server for local development. No dependencies.
//
//   node scripts/serve.mjs [port]        # defaults to 8080
//
// The app is a static page, but it is no longer openable over file:// — index.html imports
// src/model/*.mjs, and ES module imports are fetched, so the file:// origin fails CORS. A server is
// mandatory now rather than convenient. `npx serve` works too; this exists so that a machine with
// Node but no network (or no npx on PATH) can still run the app, and so the .mjs MIME type is
// guaranteed correct — a wrong Content-Type there makes the browser refuse the module with an error
// that looks nothing like the cause.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel);
  // never serve outside the repo, whatever the request path claims
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found: ' + rel); return; }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',   // so an edit is visible on reload, always
    }).end(buf);
  });
}).listen(PORT, () => console.log(`serving ${ROOT} at http://localhost:${PORT}`));
