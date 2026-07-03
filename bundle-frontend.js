/**
 * bundle-frontend.js
 *
 * Copia el build "standalone" del frontend Next.js dentro del repo Electron,
 * en ./frontend-server, para que electron-builder lo empaquete (extraResources)
 * y la app sirva la UI localmente (abre sin internet).
 *
 * El output `standalone` de Next NO incluye .next/static ni public: hay que
 * copiarlos a mano junto al server.js. Eso hace este script.
 *
 * Uso:
 *   node bundle-frontend.js
 *
 * Variables:
 *   FRONTEND_DIR   Ruta al repo frontend (default: ../titaniopos-frontend)
 *   BUNDLE_STATIC  Si =1, empaqueta el EXPORT ESTÁTICO (out/ de `npm run
 *                  build:caja`) en vez del standalone: sin servidor Node en la
 *                  caja (el proxy sirve los archivos). Requiere haber corrido
 *                  build:caja con CAJA_STORES.
 *   BUNDLE_BUILD   Si =1, corre el build en el frontend antes de copiar
 *                  (build:caja si BUNDLE_STATIC=1; npm run build si no).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execSync, execFileSync } = require('child_process');

const ELECTRON_DIR = __dirname;
const FRONTEND_DIR = path.resolve(
  process.env.FRONTEND_DIR || path.join(ELECTRON_DIR, '..', 'titaniopos-frontend')
);
const OUT_DIR = path.join(ELECTRON_DIR, 'frontend-server');

function log(msg) {
  console.log(`[BUNDLE-FRONTEND] ${msg}`);
}
function fail(msg) {
  console.error(`[BUNDLE-FRONTEND] ERROR: ${msg}`);
  process.exit(1);
}

const IS_STATIC = process.env.BUNDLE_STATIC === '1';

// ── Modo FEED (CI del release: runner sin el repo frontend al lado) ──────────
// Baja el ÚLTIMO bundle publicado (latest.json + zip, validado por sha256) y lo
// usa como vista horneada. Es exactamente el mismo zip que consumen las cajas.
// Va ANTES del check de FRONTEND_DIR: en este modo el repo frontend no se usa.
if (process.env.BUNDLE_FROM_FEED === '1') {
  bundleFromFeed()
    .then(() => log('Listo (vista horneada desde el feed).'))
    .catch((e) => fail(`feed: ${e && e.message}`));
  return;
}

if (!fs.existsSync(FRONTEND_DIR)) {
  fail(`No existe FRONTEND_DIR: ${FRONTEND_DIR}`);
}

if (process.env.BUNDLE_BUILD === '1') {
  log(`Corriendo build del frontend en ${FRONTEND_DIR} ...`);
  // DISABLE_PWA: en la caja el offline lo da el server local, no el service
  // worker. Igual que el job `bundle` del CI del frontend.
  execSync(IS_STATIC ? 'npm run build:caja' : 'npm run build', {
    cwd: FRONTEND_DIR,
    stdio: 'inherit',
    env: { ...process.env, DISABLE_PWA: '1' },
  });
}

const STANDALONE = path.join(FRONTEND_DIR, '.next', 'standalone');
const STATIC = path.join(FRONTEND_DIR, '.next', 'static');
const PUBLIC = path.join(FRONTEND_DIR, 'public');
const EXPORT_OUT = path.join(FRONTEND_DIR, 'out');

// Excluye sw.js/workbox-*.js: artefactos de builds locales con la PWA activa
// (gitignorados pero quedan en disco). Si se empaquetan, la caja registra un
// service worker con caches de 1 año que sirve assets de builds viejos.
const NO_SW_FILTER = (src) => !/(^|[\\/])(sw\.js|workbox-[^\\/]*\.js)$/i.test(src);

if (IS_STATIC) {
  if (!fs.existsSync(path.join(EXPORT_OUT, 'index.html'))) {
    fail(
      `No se encontró ${path.join(EXPORT_OUT, 'index.html')}.\n` +
        `Corré primero "npm run build:caja" en el frontend (con CAJA_STORES), o usá BUNDLE_BUILD=1.`
    );
  }
} else if (!fs.existsSync(path.join(STANDALONE, 'server.js'))) {
  fail(
    `No se encontró ${path.join(STANDALONE, 'server.js')}.\n` +
      `Corré primero "npm run build" en el frontend (o usá BUNDLE_BUILD=1).`
  );
}

// Limpiar destino previo
if (fs.existsSync(OUT_DIR)) {
  log(`Limpiando ${OUT_DIR} ...`);
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
}
fs.mkdirSync(OUT_DIR, { recursive: true });

if (IS_STATIC) {
  // Export estático: out/ plano es TODO el bundle (html + _next/static + assets
  // de public ya incluidos por Next). Sin server.js, sin node_modules, sin shim.
  log('Copiando export estático (out/)...');
  fs.cpSync(EXPORT_OUT, OUT_DIR, { recursive: true, filter: NO_SW_FILTER });
} else {
  // 1) standalone completo (server.js + node_modules minimo + .next/server)
  log('Copiando standalone...');
  fs.cpSync(STANDALONE, OUT_DIR, { recursive: true });

  // 2) .next/static -> frontend-server/.next/static
  log('Copiando .next/static...');
  fs.cpSync(STATIC, path.join(OUT_DIR, '.next', 'static'), { recursive: true });

  // 3) public -> frontend-server/public
  if (fs.existsSync(PUBLIC)) {
    log('Copiando public (sin sw.js/workbox-*.js)...');
    fs.cpSync(PUBLIC, path.join(OUT_DIR, 'public'), {
      recursive: true,
      filter: NO_SW_FILTER,
    });
  }
}

// 3.5) Identidad intrínseca de la horneada (misma semántica de buildNumber que
// el CI: nº de commits). Permite a view-updater saber qué build corre aunque
// state.json se pierda; sin esto la horneada "vale 0" y el updater re-descarga
// una build igual o más vieja que la que ya corre.
try {
  const count = parseInt(
    execSync('git rev-list --count HEAD', { cwd: FRONTEND_DIR, encoding: 'utf8' }).trim(), 10
  );
  const sha = execSync('git rev-parse --short HEAD', { cwd: FRONTEND_DIR, encoding: 'utf8' }).trim();
  const base = JSON.parse(
    fs.readFileSync(path.join(FRONTEND_DIR, 'package.json'), 'utf8')
  ).version.split('.').slice(0, 2).join('.');
  fs.writeFileSync(
    path.join(OUT_DIR, 'view-version.json'),
    JSON.stringify({ buildNumber: count, version: `${base}.${count}+${sha}` })
  );
  log(`view-version.json → build ${count} (${sha})`);
} catch (e) {
  log(`AVISO: no se pudo escribir view-version.json (${e && e.message}); la horneada queda sin identidad`);
}

// 4) Parche Windows (red de seguridad de resolución): en Windows + Node 24, la
// resolución CJS de Next falla con MODULE_NOT_FOUND para rutas que SÍ existen
// (requires internos como '../build/output/log' al arrancar, y el page.js de
// rutas con [ ] ( )). Inyectamos un shim al inicio de server.js que, SOLO si la
// resolución falla, intenta resolver el request RELATIVO AL MÓDULO PADRE (o
// absoluto) y devuelve el archivo si existe en disco. Es estricto: nunca cambia
// una resolución exitosa; solo recupera archivos existentes que Node no encontró.
// Solo bundles standalone: el estático no tiene server.js que parchear.
if (!IS_STATIC) patchServerShimForWindows();

const size = execSyncSafe(`du -sh "${OUT_DIR}"`) || '';
log(`Listo. Bundle en ${OUT_DIR} ${size.trim()}`);

function patchServerShimForWindows() {
  const serverJs = path.join(OUT_DIR, 'server.js');
  const MARKER = '/* titaniopos-win-resolve-shim */';
  const src = fs.readFileSync(serverJs, 'utf8');
  if (src.includes(MARKER)) return;
  const shim = `${MARKER}
(() => {
  const Module = require('module');
  const path = require('path');
  const fs = require('fs');
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    try {
      return orig.call(this, request, parent, isMain, options);
    } catch (err) {
      // Solo recuperamos requests de RUTA (relativos/absolutos) cuyo archivo
      // existe: nunca tocamos specifiers de paquete (react, etc.).
      if (err && err.code === 'MODULE_NOT_FOUND' && typeof request === 'string'
          && (request[0] === '.' || path.isAbsolute(request))) {
        const base = parent && parent.filename ? path.dirname(parent.filename) : process.cwd();
        const abs = path.resolve(base, request);
        const cands = [abs, abs + '.js', abs + '.json', abs + '.node',
                       path.join(abs, 'index.js'), path.join(abs, 'index.json')];
        for (const c of cands) {
          try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch (_) {}
        }
      }
      throw err;
    }
  };
})();
`;
  fs.writeFileSync(serverJs, shim + src);
  log('Parche Windows (resolve shim) aplicado a server.js');
}

function execSyncSafe(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8' });
  } catch {
    return null;
  }
}

// ── Helpers del modo FEED ─────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 400) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} en ${url}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

function extractZipTo(zipPath, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  try { execFileSync('tar', ['-xf', zipPath, '-C', targetDir], { stdio: 'ignore' }); return; }
  catch (_) { /* sin bsdtar → fallback */ }
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${targetDir}" -Force`], { stdio: 'ignore' });
  } else {
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', targetDir], { stdio: 'ignore' });
  }
}

async function bundleFromFeed() {
  const base = (process.env.TITANIOPOS_VIEW_UPDATE_URL || 'https://updates.titanio-pos.com').replace(/\/$/, '');
  log(`Bajando latest.json de ${base} ...`);
  const meta = JSON.parse((await httpGet(base + '/latest.json')).toString('utf8'));
  if (!meta.url) fail('latest.json sin url');
  log(`Bajando bundle ${meta.version} (build ${meta.buildNumber}) ...`);
  const zipBuf = await httpGet(meta.url);
  if (meta.sha256) {
    const got = crypto.createHash('sha256').update(zipBuf).digest('hex');
    if (got.toLowerCase() !== String(meta.sha256).toLowerCase()) {
      fail(`sha256 no coincide (esperado ${meta.sha256}, got ${got})`);
    }
    log('sha256 OK');
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tpos-feed-'));
  const zipPath = path.join(tmp, 'bundle.zip');
  fs.writeFileSync(zipPath, zipBuf);
  if (fs.existsSync(OUT_DIR)) fs.rmSync(OUT_DIR, { recursive: true, force: true });
  extractZipTo(zipPath, OUT_DIR);
  fs.rmSync(tmp, { recursive: true, force: true });
  // Identidad intrínseca (igual que hace view-updater al descargar en la caja).
  fs.writeFileSync(
    path.join(OUT_DIR, 'view-version.json'),
    JSON.stringify({ buildNumber: parseInt(meta.buildNumber, 10) || 0, version: meta.version || '' })
  );
  // Si el bundle del feed fuera standalone (legacy), aplicar el shim de Windows.
  if (fs.existsSync(path.join(OUT_DIR, 'server.js'))) patchServerShimForWindows();
  log(`view-version.json → build ${meta.buildNumber} (${meta.version})`);
}
