/**
 * Servidor estático MÍNIMO para PROBAR el hot-swap en local (sin S3).
 * Sirve la carpeta _view-host (version.json + vista-*.tar.gz) en :8090.
 *   node _view-host-server.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '_view-host');
const PORT = 8090;
const TYPES = { '.json': 'application/json', '.gz': 'application/gzip', '.tar': 'application/x-tar' };

http.createServer((req, res) => {
  const name = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
  const file = path.join(ROOT, name || 'version.json');
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '0.0.0.0', () => console.log(`[VIEW-HOST] sirviendo ${ROOT} en http://0.0.0.0:${PORT}`));
