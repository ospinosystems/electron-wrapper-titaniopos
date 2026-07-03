/**
 * frontend-server-manager.js
 *
 * Arranca el servidor "standalone" de Next.js (el frontend de TitanioPOS)
 * COMO PROCESO HIJO dentro de Electron, en un puerto local fijo.
 *
 * Por qué: si Electron carga la UI desde la URL remota (https://...), sin
 * internet la ventana queda en blanco. Sirviendo el build local en
 * http://127.0.0.1:<puerto> la UI SIEMPRE abre, haya o no internet.
 *
 * Origen ÚNICO y FIJO: el puerto NO debe cambiar entre reinicios, porque el
 * origen (scheme+host+port) define la sesión, el IndexedDB y la base local
 * (Electric SQL / PGlite / Dexie). Si el puerto cambia, se pierden esos datos.
 *
 * El proceso hijo corre con el Node embebido de Electron (ELECTRON_RUN_AS_NODE),
 * así no hace falta instalar Node aparte en la caja.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { fork } = require('child_process');
const { app } = require('electron');
const { startProxy, stopProxy } = require('./local-proxy');

// Puerto local fijo = ORIGEN de la app (lo que ve el navegador). NO cambiar en
// una caja instalada: define sesión/IndexedDB/datos. El proxy escucha acá.
const DEFAULT_PORT = parseInt(process.env.TITANIOPOS_LOCAL_PORT, 10) || 3010;
const HOST = '127.0.0.1';

// El Next interno corre en un puerto LIBRE asignado por el SO (no uno fijo),
// para que NUNCA choque con un Next huérfano de un cierre forzado anterior ni
// con otro proceso. El proxy (origen 3010) reenvía a ese puerto interno.
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, HOST, () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// ¿La "web remota" (TITANIOPOS_URL) está alcanzable? Define online/offline.
function checkReachable(url, timeoutMs = 3500) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const mod = u.protocol === 'https:' ? require('https') : http;
      const req = mod.get(
        { host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: '/', timeout: timeoutMs },
        (res) => { res.resume(); resolve(true); }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    } catch { resolve(false); }
  });
}

let child = null;
let resolvedUrl = null;
// Fuente de la UI activa: 'web' (online, desde TITANIOPOS_URL) | 'local' (bundle offline).
let uiSource = 'local';

// Log a archivo (además de consola) para diagnosticar en la caja empaquetada,
// donde la consola no se ve. Ruta: <userData>/frontend-local.log
let LOG_FILE = null;
function logPath() {
  if (LOG_FILE) return LOG_FILE;
  try { LOG_FILE = path.join(app.getPath('userData'), 'frontend-local.log'); }
  catch { LOG_FILE = path.join(__dirname, 'frontend-local.log'); }
  return LOG_FILE;
}
function flog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(logPath(), line + '\n'); } catch (_) {}
}
function flogReset() {
  // No borramos el log (así queda el rastro de un intento fallido aunque el
  // reintento arranque otro). Solo lo truncamos si crece demasiado.
  try {
    if (fs.existsSync(logPath()) && fs.statSync(logPath()).size > 200 * 1024) {
      fs.writeFileSync(logPath(), '');
    }
  } catch (_) {}
  flog('───────── nuevo intento de arranque ─────────');
}

/**
 * Resuelve la carpeta del server standalone empaquetado.
 * - Packaged: process.resourcesPath/frontend-server (copiado por extraResources).
 * - Dev: override por env TITANIOPOS_FRONTEND_SERVER_DIR, o ./frontend-server
 *   dentro del repo Electron si existe (para probar el bundle localmente).
 */
function resolveServerDir() {
  const override = (process.env.TITANIOPOS_FRONTEND_SERVER_DIR || '').trim();
  if (override) return override;

  // Hot-swap: si hay una build DESCARGADA activa (<userData>/views/<n>) la
  // preferimos sobre la horneada. La descarga/promoción la maneja view-updater.js.
  try {
    const dl = require('./view-updater').activeServerDir();
    if (dl) return dl;
  } catch (_) { /* sin view-updater → horneada */ }

  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'frontend-server');
  }
  return path.join(__dirname, 'frontend-server');
}

/** ¿Hay un bundle local válido para servir? */
function hasLocalBundle() {
  try {
    const dir = resolveServerDir();
    return fs.existsSync(path.join(dir, 'server.js'));
  } catch {
    return false;
  }
}

/** Hace polling hasta que el server responde (cualquier status HTTP) o expira.
 *  `alive()` permite abortar antes si el proceso hijo murió. */
function waitUntilUp(port, { timeoutMs = 60000, intervalMs = 400, alive = null } = {}) {
  const start = Date.now();
  let attempts = 0;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      attempts++;
      if (alive && !alive()) {
        return reject(new Error('El proceso Next terminó antes de responder'));
      }
      const req = http.get(
        { host: HOST, port, path: '/', timeout: 2500 },
        (res) => { res.resume(); flog(`waitUntilUp(${port}): OK tras ${attempts} intentos (${Date.now() - start}ms)`); resolve(true); }
      );
      req.on('error', (e) => retryOrFail(e && e.code));
      req.on('timeout', () => { req.destroy(); retryOrFail('TIMEOUT'); });
    };
    const retryOrFail = (code) => {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Next no respondió en ${timeoutMs}ms (último: ${code}, ${attempts} intentos)`));
      }
      setTimeout(tryOnce, intervalMs);
    };
    tryOnce();
  });
}

/**
 * Arranca el server local (idempotente). Devuelve { url, port } o lanza si
 * no hay bundle / no levanta a tiempo.
 */
async function startFrontendServer() {
  if (child && resolvedUrl) {
    return { url: resolvedUrl, port: DEFAULT_PORT };
  }

  flogReset();

  // Hot-swap: aplicar una build PENDIENTE (state.next, descargada o switcheada en
  // un arranque anterior) ANTES de cualquier corto-circuito → si no, `next` queda
  // staged para siempre y el prompt de reinicio no muere nunca. Con Next aún sin
  // levantar → sin locks.
  try { require('./view-updater').applyPendingView(flog); } catch (_) {}

  // MODO DEV (solo testing): si TITANIOPOS_DEV_UI_URL apunta a un `next dev`,
  // la UI sale de ahí (HMR) y NO levantamos Next local (la caja de dev no
  // necesita el bundle). El proxy igual maneja /__backend y /__electric.
  const devUI = (process.env.TITANIOPOS_DEV_UI_URL || '').trim();
  if (devUI) {
    await startProxy(DEFAULT_PORT, 0, HOST, devUI);
    resolvedUrl = `http://${HOST}:${DEFAULT_PORT}`;
    uiSource = 'local';
    flog(`MODO DEV: UI desde ${devUI}, /__backend por el proxy`);
    return { url: resolvedUrl, port: DEFAULT_PORT };
  }

  const serverDir = resolveServerDir();
  const serverJs = path.join(serverDir, 'server.js');

  // Registrar qué dir se sirve en ESTA sesión: el updater compara la remota
  // contra la identidad intrínseca de lo que corre (view-version.json), no solo
  // contra state.json (que puede perderse y provocar re-stageos espurios).
  try { require('./view-updater').noteRunningServerDir(serverDir); } catch (_) {}

  flog(`startFrontendServer: packaged=${app.isPackaged} execPath=${process.execPath}`);
  flog(`serverDir=${serverDir}`);

  if (!fs.existsSync(serverJs)) {
    throw new Error(`No se encontró el frontend empaquetado: ${serverJs}`);
  }

  // Puerto interno LIBRE (no fijo) → nunca choca con huérfanos u otros procesos.
  const nextPort = await getFreePort();
  flog(`serverJs existe=true | next(libre)=${nextPort} proxy=${DEFAULT_PORT}`);

  let exited = false;
  let exitInfo = '';

  child = fork(serverJs, [], {
    cwd: serverDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      PORT: String(nextPort),
      HOSTNAME: HOST,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  flog(`fork Next pid=${child.pid} en puerto ${nextPort}`);

  if (child.stdout) child.stdout.on('data', (d) => flog(`[next] ${String(d).trimEnd()}`));
  if (child.stderr) child.stderr.on('data', (d) => flog(`[next:err] ${String(d).trimEnd()}`));
  child.on('error', (e) => flog(`[next] error de proceso: ${e && e.message}`));
  child.on('exit', (code, signal) => {
    exited = true;
    exitInfo = `code=${code} signal=${signal}`;
    flog(`[next] terminó (${exitInfo})`);
    child = null;
    resolvedUrl = null;
  });

  try {
    // Esperar a que Next levante (interno); abortar si el proceso muere.
    await waitUntilUp(nextPort, { alive: () => !exited });
    // Prod/local: la UI SIEMPRE sale del bundle local (login por /__backend, sin
    // CORS). El modo dev ya se manejó arriba con corto-circuito.
    uiSource = 'local';
    await startProxy(DEFAULT_PORT, nextPort, HOST, null);
    flog(`proxy levantado en ${DEFAULT_PORT} → next ${nextPort} (UI=bundle local)`);
  } catch (e) {
    flog(`ERROR al levantar UI local: ${e && e.message}${exited ? ` (Next exit: ${exitInfo})` : ''}`);
    throw e;
  }

  resolvedUrl = `http://${HOST}:${DEFAULT_PORT}`;
  flog(`UI local lista (con proxy de sesión) en ${resolvedUrl}`);

  // Hot-swap en BACKGROUND: con la app ya arrancando, chequeamos si hay una build
  // más nueva y la dejamos PENDIENTE para el próximo arranque. NO bloquea el boot.
  scheduleViewUpdateCheck();

  return { url: resolvedUrl, port: DEFAULT_PORT };
}

/**
 * Programa el chequeo de actualización de la vista en BACKGROUND (no bloquea el
 * boot). Solo en la app instalada. El host por defecto es prod
 * (updates.titanio-pos.com); se puede apuntar a uno de prueba con
 * TITANIOPOS_VIEW_UPDATE_URL.
 */
function scheduleViewUpdateCheck() {
  if (!app.isPackaged) return; // solo la caja instalada se auto-actualiza
  const url = (process.env.TITANIOPOS_VIEW_UPDATE_URL || '').trim();
  setTimeout(() => {
    try {
      const { checkAndStageUpdate, DEFAULT_UPDATE_URL } = require('./view-updater');
      checkAndStageUpdate(url || DEFAULT_UPDATE_URL, flog)
        .catch((e) => flog(`[VIEW] check falló: ${e && e.message}`));
    } catch (e) { flog(`[VIEW] no se pudo iniciar el check: ${e && e.message}`); }
  }, 20000); // 20s tras el boot: no compite con la carga inicial
}

/** Mata el proxy + el server local. CLAVE: en Windows usa taskkill /F /T para
 *  matar el Next y su árbol; con solo child.kill() a veces queda vivo y mantiene
 *  el proceso principal como ZOMBI (se queda con el lock de instancia única →
 *  "la app no abre"). */
function stopFrontendServer() {
  try { stopProxy(); } catch (_) {}
  if (!child) return;
  const pid = child.pid;
  try {
    console.log('[FRONTEND] Cerrando Next standalone (pid ' + pid + ')...');
    if (process.platform === 'win32' && pid) {
      try {
        require('child_process').execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
      } catch (_) {
        try { child.kill(); } catch (__) {}
      }
    } else {
      child.kill();
    }
  } catch (e) {
    console.warn('[FRONTEND] Error al cerrar server local:', e && e.message);
  }
  child = null;
  resolvedUrl = null;
}

function getFrontendUrl() {
  return resolvedUrl;
}

module.exports = {
  startFrontendServer,
  stopFrontendServer,
  getFrontendUrl,
  hasLocalBundle,
  resolveServerDir,
  getUiSource: () => uiSource,
  LOCAL_PORT: DEFAULT_PORT,
};
