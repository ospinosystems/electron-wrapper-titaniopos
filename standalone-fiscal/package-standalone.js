/**
 * Empaqueta el servidor fiscal standalone en un ZIP listo para distribuir.
 *
 *   node standalone-fiscal/package-standalone.js
 *
 * Salida: dist-standalone/titaniopos-fiscal-server-vX.Y.Z.zip
 * Contenido:
 *   - python-embed/        (Python 3.11 + flask + pyserial)
 *   - fiscal-server/       (fiscal.py, hka_serial.py, etc)
 *   - Iniciar Servidor Fiscal.bat
 *   - LEEME.txt
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VERSION = require(path.join(ROOT, 'package.json')).version;
const OUT_DIR = path.join(ROOT, 'dist-standalone');
const STAGE_DIR = path.join(OUT_DIR, `titaniopos-fiscal-server-v${VERSION}`);
const ZIP_PATH = path.join(OUT_DIR, `titaniopos-fiscal-server-v${VERSION}.zip`);

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (filter && !filter(entry, src)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d, filter);
    else fs.copyFileSync(s, d);
  }
}

function main() {
  console.log(`[STANDALONE] Building v${VERSION}`);

  rmrf(OUT_DIR);
  fs.mkdirSync(STAGE_DIR, { recursive: true });

  console.log('[STANDALONE] Copiando python-embed/...');
  copyDir(path.join(ROOT, 'python-embed'), path.join(STAGE_DIR, 'python-embed'));

  console.log('[STANDALONE] Copiando fiscal-server/...');
  copyDir(
    path.join(ROOT, 'fiscal-server'),
    path.join(STAGE_DIR, 'fiscal-server'),
    (entry) => entry.name !== '__pycache__' && entry.name !== 'data',
  );

  console.log('[STANDALONE] Copiando .bat y LEEME...');
  fs.copyFileSync(
    path.join(__dirname, 'Iniciar Servidor Fiscal.bat'),
    path.join(STAGE_DIR, 'Iniciar Servidor Fiscal.bat'),
  );
  fs.copyFileSync(
    path.join(__dirname, 'LEEME.txt'),
    path.join(STAGE_DIR, 'LEEME.txt'),
  );

  console.log('[STANDALONE] Creando ZIP...');
  // PowerShell Compress-Archive funciona en Windows sin dependencias.
  const ps = `Compress-Archive -Path '${STAGE_DIR}\\*' -DestinationPath '${ZIP_PATH}' -Force`;
  execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: 'inherit' });

  const sizeMB = (fs.statSync(ZIP_PATH).size / 1024 / 1024).toFixed(1);
  console.log(`[STANDALONE] OK -> ${ZIP_PATH} (${sizeMB} MB)`);
}

main();
