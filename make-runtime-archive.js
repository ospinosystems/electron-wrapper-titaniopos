/**
 * make-runtime-archive.js
 *
 * Empaqueta el RUNTIME pesado (vpos-rest + python-embed) en UNA "caja sellada"
 * (runtime.7z) con una HUELLA de contenido (runtime.version). El instalador solo
 * re-extrae la caja cuando la huella cambia; en updates normales la salta, así el
 * update no re-escribe ~3000 archivos que nunca cambian.
 *
 * Salida (carpeta gitignoreada runtime-dist/):
 *   runtime.7z        -> vpos-rest/ + python-embed/ (sin __pycache__/*.pyc)
 *   runtime.version   -> sha256 (16 hex) del contenido incluido en el 7z
 *
 * Se corre ANTES de electron-builder (ver package.json "build"). Determinista:
 * la huella depende solo del contenido de los archivos incluidos, no de mtimes.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, 'runtime-dist');
const RUNTIME_DIRS = ['vpos-rest', 'python-embed'];

// 7za del paquete 7zip-bin, según la plataforma donde corre el BUILD.
function sevenZaPath() {
  const plat = process.platform; // 'linux' | 'win32' | 'darwin'
  const arch = process.arch; // 'x64' | 'arm64' | ...
  const map = {
    linux: path.join('linux', arch === 'arm64' ? 'arm64' : 'x64', '7za'),
    win32: path.join('win', arch === 'arm64' ? 'arm64' : 'x64', '7za.exe'),
    darwin: path.join('mac', arch === 'arm64' ? 'arm64' : 'x64', '7za'),
  };
  const rel = map[plat] || map.linux;
  return path.join(ROOT, 'node_modules', '7zip-bin', rel);
}

const EXCLUDE = (rel) =>
  rel.split(path.sep).includes('__pycache__') || rel.endsWith('.pyc');

function walk(dir, base, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);
    if (entry.isDirectory()) {
      walk(full, base, acc);
    } else if (entry.isFile() && !EXCLUDE(rel)) {
      acc.push(full);
    }
  }
}

function computeFingerprint() {
  // Hash sobre (ruta relativa + contenido) de cada archivo, en orden estable.
  // Cambia SOLO si cambia el contenido incluido — no depende de mtime/orden FS.
  const files = [];
  for (const d of RUNTIME_DIRS) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) {
      throw new Error(`No existe el directorio de runtime: ${d}`);
    }
    walk(abs, ROOT, files);
  }
  files.sort();
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(path.relative(ROOT, f).replace(/\\/g, '/'));
    h.update('\0');
    h.update(fs.readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

function main() {
  console.log('[runtime] calculando huella de vpos-rest + python-embed...');
  const version = computeFingerprint();
  console.log(`[runtime] huella = ${version}`);

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const archive = path.join(OUT_DIR, 'runtime.7z');
  const sevenZa = sevenZaPath();
  console.log(`[runtime] creando ${path.basename(archive)} con ${path.relative(ROOT, sevenZa)}...`);
  // -mx=5 (normal): la extracción SOLO ocurre cuando el runtime cambia (raro),
  // así que priorizamos un tamaño razonable sin sobre-comprimir. Excluye pyc.
  execFileSync(
    sevenZa,
    ['a', '-t7z', '-mx=5', '-xr!__pycache__', '-xr!*.pyc', archive, ...RUNTIME_DIRS],
    { cwd: ROOT, stdio: 'inherit' },
  );

  fs.writeFileSync(path.join(OUT_DIR, 'runtime.version'), version + '\n', 'utf8');

  const mb = (fs.statSync(archive).size / (1024 * 1024)).toFixed(1);
  console.log(`[runtime] listo: runtime.7z = ${mb} MB, version = ${version}`);
}

main();
