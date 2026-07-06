/**
 * local-proxy.js
 *
 * Proxy HTTP local (sin dependencias) que se pone DELANTE del Next standalone
 * para que el login funcione con las vistas empaquetadas localmente.
 *
 * Problema que resuelve: las vistas corren en http://127.0.0.1:<port> (origen
 * local) pero la cookie de sesión la emite el backend para titanio-pos.com.
 * El navegador no comparte esa cookie entre orígenes distintos.
 *
 * Solución: el frontend hace sus llamadas al MISMO origen local con prefijos
 *   /__backend/...  -> https://www.titanio-pos.com/...
 *   /__electric/... -> https://electric.titanio-pos.com/...
 * El proxy las reenvía al backend real haciéndose pasar por el frontend de prod
 * (Origin/Referer/Host spoofeados, que ya están en SANCTUM_STATEFUL_DOMAINS), y
 * REESCRIBE las cookies de respuesta para que queden en el origen local
 * (quita Domain y Secure). Así la sesión se persiste localmente y el login
 * funciona "como siempre", sin tocar el backend.
 *
 * Todo lo que no empieza con esos prefijos va al Next standalone (la UI).
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// Agentes con KEEP-ALIVE: reusan las conexiones (y el handshake TLS) al backend
// real. Sin esto, CADA llamada a /__backend abría una conexión nueva con
// handshake TLS completo a www.titanio-pos.com → con varias llamadas por vista
// (ej. Ajustes) la app se siente MUY lenta. El navegador, al cargar la web
// directo, ya hace keep-alive; el proxy debe igualarlo.
const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 15000 });
const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 15000 });

const BACKEND_URL = (process.env.TITANIOPOS_BACKEND_URL || 'https://www.titanio-pos.com').replace(/\/$/, '');
const ELECTRIC_URL = (process.env.TITANIOPOS_ELECTRIC_URL || 'https://electric.titanio-pos.com').replace(/\/$/, '');
// Origen que el backend reconoce como "stateful" (SANCTUM_STATEFUL_DOMAINS).
const SPOOF_ORIGIN = (process.env.TITANIOPOS_SPOOF_ORIGIN || 'https://frontend.titanio-pos.com').replace(/\/$/, '');

const BACKEND_PREFIX = '/__backend';
const ELECTRIC_PREFIX = '/__electric';

let server = null;

// Reescribe los Set-Cookie del backend para que valgan en el origen local http:
// quita Domain (host-only -> 127.0.0.1), quita Secure (estamos en http local),
// y normaliza SameSite=None -> Lax (ya es todo mismo origen).
function rewriteSetCookie(values) {
  if (!values) return values;
  const arr = Array.isArray(values) ? values : [values];
  return arr.map((c) =>
    c
      .replace(/;\s*Domain=[^;]+/gi, '')
      .replace(/;\s*Secure/gi, '')
      .replace(/;\s*SameSite=None/gi, '; SameSite=Lax')
  );
}

function proxyToUpstream(req, res, upstreamBase, stripPrefix, spoof) {
  const base = new URL(upstreamBase);
  const isHttps = base.protocol === 'https:';
  const agent = isHttps ? https : http;

  const targetPath = req.url.slice(stripPrefix.length) || '/';
  const headers = { ...req.headers };

  // Apuntar al host real y hacernos pasar por el frontend de prod (stateful).
  headers.host = base.host;
  if (spoof) {
    headers.origin = SPOOF_ORIGIN;
    headers.referer = SPOOF_ORIGIN + '/';
  }
  // accept-encoding pasa TAL CUAL: el cuerpo se pipea intacto y content-encoding
  // se copia en la respuesta, así que gzip/br viajan de punta a punta (backend y
  // Electric comprimen → mucho menos tráfico en el sync con enlaces lentos).
  // Antes se borraba "por las dudas" y todo viajaba sin comprimir.

  const options = {
    protocol: base.protocol,
    hostname: base.hostname,
    port: base.port || (isHttps ? 443 : 80),
    method: req.method,
    path: targetPath,
    headers,
    agent: isHttps ? keepAliveHttps : keepAliveHttp, // reusa conexión (sin TLS por request)
  };

  const upReq = agent.request(options, (upRes) => {
    const outHeaders = { ...upRes.headers };
    if (outHeaders['set-cookie']) {
      outHeaders['set-cookie'] = rewriteSetCookie(outHeaders['set-cookie']);
    }
    res.writeHead(upRes.statusCode || 502, outHeaders);
    upRes.pipe(res);
    // Si la respuesta upstream falla a mitad, cortamos el cliente (y NO dejamos
    // el socket keep-alive en un estado raro).
    upRes.on('error', () => { try { res.destroy(); } catch (_) {} });
  });

  upReq.on('error', (err) => {
    // Backend inalcanzable (típicamente sin internet). CLAVE: no devolver un 502
    // (el frontend lo tomaría como "respuesta del backend" y destruiría la sesión).
    // Cortamos la conexión para que el navegador lo vea como ERROR DE RED → el
    // frontend conserva la sesión persistida y opera offline con datos cacheados.
    console.warn('[PROXY] Backend inalcanzable', stripPrefix, err && err.code);
    try { res.destroy(err); } catch (_) {}
    try { req.destroy(); } catch (_) {}
  });

  // CRÍTICO con keep-alive: si el cliente ABORTA (la navegación cancela las
  // requests en vuelo), DESTRUIR el upstream. Si no, un socket a medio consumir
  // vuelve al pool keep-alive "envenenado" y la próxima request sobre él se
  // cuelga → la barra de navegación se traba y la vista no cambia.
  res.on('close', () => {
    if (!res.writableFinished) { try { upReq.destroy(); } catch (_) {} }
  });

  req.pipe(upReq);
}

// ── UI estática (export de Next: out/ plano, sin servidor Node) ─────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', // payloads RSC del router de Next
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

function sendFile(req, res, filePath, status = 200) {
  const ext = path.extname(filePath).toLowerCase();
  const headers = { 'content-type': MIME[ext] || 'application/octet-stream' };
  // Assets con hash → cache larga; html/rsc → siempre frescos (hot-swap).
  headers['cache-control'] = filePath.includes(`${path.sep}_next${path.sep}static${path.sep}`)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
  try { headers['content-length'] = fs.statSync(filePath).size; } catch (_) {}
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => { try { res.destroy(); } catch (_) {} });
  stream.pipe(res);
}

/**
 * Sirve la SPA exportada con la semántica de rutas de Next export:
 *   /login → login.html · / → index.html · /checkout/elorza → checkout/elorza.html
 *   /checkout/elorza.txt (RSC del client router) → archivo exacto
 *   desconocida → 404.html (la app solo navega a rutas del build).
 */
function serveStatic(req, res, rootDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    return res.end();
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch (_) { res.writeHead(400); return res.end(); }
  pathname = pathname.replace(/\/+$/, '') || '/';

  // Anti path-traversal: el resultado debe quedar DENTRO de rootDir.
  const safe = (p) => {
    const abs = path.resolve(rootDir, '.' + p);
    return abs.startsWith(path.resolve(rootDir) + path.sep) || abs === path.resolve(rootDir) ? abs : null;
  };
  const isFile = (p) => { try { return !!p && fs.statSync(p).isFile(); } catch (_) { return false; } };

  const exact = safe(pathname);
  if (isFile(exact)) return sendFile(req, res, exact);
  const asHtml = safe(pathname === '/' ? '/index.html' : pathname + '.html');
  if (isFile(asHtml)) return sendFile(req, res, asHtml);
  const asIndex = safe(pathname + '/index.html');
  if (isFile(asIndex)) return sendFile(req, res, asIndex);

  const notFound = safe('/404.html');
  if (isFile(notFound)) return sendFile(req, res, notFound, 404);
  res.writeHead(404);
  res.end('Not found');
}

/**
 * Arranca el proxy en `localPort`.
 *  - /__backend, /__electric → backend/electric reales.
 *  - resto (UI): si `uiUpstream` está set (ONLINE) → la web remota; si no,
 *    `staticDir` (export estático) o el Next standalone local (`nextPort`,
 *    bundles legacy).
 */
function startProxy(localPort, nextPort, host = '127.0.0.1', uiUpstream = null, staticDir = null) {
  const localUI = `http://${host}:${nextPort}`;
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      try {
        if (req.url.startsWith(BACKEND_PREFIX)) {
          return proxyToUpstream(req, res, BACKEND_URL, BACKEND_PREFIX, true);
        }
        if (req.url.startsWith(ELECTRIC_PREFIX)) {
          return proxyToUpstream(req, res, ELECTRIC_URL, ELECTRIC_PREFIX, true);
        }
        // UI: online → web remota; offline → estático o bundle standalone local.
        if (!uiUpstream && staticDir) return serveStatic(req, res, staticDir);
        return proxyToUpstream(req, res, uiUpstream || localUI, '', false);
      } catch (e) {
        console.error('[PROXY] Error manejando request:', e && e.message);
        if (!res.headersSent) res.writeHead(500);
        res.end('Proxy error');
      }
    });

    // WebSocket (HMR del dev server en modo testing): pasar el upgrade al upstream.
    server.on('upgrade', (req, clientSocket, head) => {
      try {
        const base = new URL(uiUpstream || localUI);
        const upReq = http.request({
          host: base.hostname,
          port: base.port || (base.protocol === 'https:' ? 443 : 80),
          path: req.url,
          headers: { ...req.headers, host: base.host },
        });
        upReq.on('upgrade', (upRes, upSocket, upHead) => {
          clientSocket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
            Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
            '\r\n\r\n'
          );
          if (upHead && upHead.length) upSocket.unshift(upHead);
          upSocket.pipe(clientSocket);
          clientSocket.pipe(upSocket);
        });
        upReq.on('error', () => { try { clientSocket.destroy(); } catch (_) {} });
        upReq.end();
      } catch (_) { try { clientSocket.destroy(); } catch (_) {} }
    });

    server.on('error', reject);
    server.listen(localPort, host, () => {
      console.log(`[PROXY] Escuchando en http://${host}:${localPort}`);
      console.log(`[PROXY]   ${BACKEND_PREFIX}  -> ${BACKEND_URL} (origin spoof: ${SPOOF_ORIGIN})`);
      console.log(`[PROXY]   ${ELECTRIC_PREFIX} -> ${ELECTRIC_URL}`);
      console.log(`[PROXY]   UI                -> ${uiUpstream ? uiUpstream + ' (web ONLINE)' : localUI + ' (bundle OFFLINE)'}`);
      resolve();
    });
  });
}

function stopProxy() {
  if (server) {
    try { server.close(); } catch (_) {}
    // server.close() solo deja de aceptar conexiones nuevas; con keep-alive del
    // navegador las viejas sobreviven y el puerto queda tomado para un restart
    // en caliente (camino "Reintentar").
    try { server.closeAllConnections(); } catch (_) {}
    server = null;
  }
}

module.exports = { startProxy, stopProxy };
