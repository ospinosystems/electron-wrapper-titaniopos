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
 *   BUNDLE_BUILD   Si =1, corre `npm run build` en el frontend antes de copiar.
 *                  IMPORTANTE: ese build debe usar los NEXT_PUBLIC_* de PROD
 *                  (API/Electric apuntando a producción), porque quedan
 *                  "horneados" en el bundle.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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

if (!fs.existsSync(FRONTEND_DIR)) {
  fail(`No existe FRONTEND_DIR: ${FRONTEND_DIR}`);
}

if (process.env.BUNDLE_BUILD === '1') {
  log(`Corriendo build del frontend en ${FRONTEND_DIR} ...`);
  log('Asegurate de que los NEXT_PUBLIC_* apuntan a PRODUCCIÓN.');
  execSync('npm run build', { cwd: FRONTEND_DIR, stdio: 'inherit' });
}

const STANDALONE = path.join(FRONTEND_DIR, '.next', 'standalone');
const STATIC = path.join(FRONTEND_DIR, '.next', 'static');
const PUBLIC = path.join(FRONTEND_DIR, 'public');

if (!fs.existsSync(path.join(STANDALONE, 'server.js'))) {
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

// 1) standalone completo (server.js + node_modules minimo + .next/server)
log('Copiando standalone...');
fs.cpSync(STANDALONE, OUT_DIR, { recursive: true });

// 2) .next/static -> frontend-server/.next/static
log('Copiando .next/static...');
fs.cpSync(STATIC, path.join(OUT_DIR, '.next', 'static'), { recursive: true });

// 3) public -> frontend-server/public
if (fs.existsSync(PUBLIC)) {
  log('Copiando public...');
  fs.cpSync(PUBLIC, path.join(OUT_DIR, 'public'), { recursive: true });
}

// 4) Parche Windows (red de seguridad de resolución): en Windows + Node 24, la
// resolución CJS de Next falla con MODULE_NOT_FOUND para rutas que SÍ existen
// (requires internos como '../build/output/log' al arrancar, y el page.js de
// rutas con [ ] ( )). Inyectamos un shim al inicio de server.js que, SOLO si la
// resolución falla, intenta resolver el request RELATIVO AL MÓDULO PADRE (o
// absoluto) y devuelve el archivo si existe en disco. Es estricto: nunca cambia
// una resolución exitosa; solo recupera archivos existentes que Node no encontró.
patchServerShimForWindows();

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
