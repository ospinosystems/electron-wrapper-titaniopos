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
const { URL } = require('url');

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
  // Evitar compresiones raras al re-emitir; dejamos pasar tal cual el cuerpo.
  delete headers['accept-encoding'];

  const options = {
    protocol: base.protocol,
    hostname: base.hostname,
    port: base.port || (isHttps ? 443 : 80),
    method: req.method,
    path: targetPath,
    headers,
  };

  const upReq = agent.request(options, (upRes) => {
    const outHeaders = { ...upRes.headers };
    if (outHeaders['set-cookie']) {
      outHeaders['set-cookie'] = rewriteSetCookie(outHeaders['set-cookie']);
    }
    res.writeHead(upRes.statusCode || 502, outHeaders);
    upRes.pipe(res);
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

  req.pipe(upReq);
}

/**
 * Arranca el proxy en `localPort`.
 *  - /__backend, /__electric → backend/electric reales.
 *  - resto (UI): si `uiUpstream` está set (ONLINE) → la web remota; si no
 *    (OFFLINE) → Next standalone local (`nextPort`, el bundle empaquetado).
 */
function startProxy(localPort, nextPort, host = '127.0.0.1', uiUpstream = null) {
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
        // UI: online → web remota; offline → bundle local.
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
    server = null;
  }
}

module.exports = { startProxy, stopProxy };
