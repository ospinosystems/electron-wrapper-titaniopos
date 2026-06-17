/**
 * Gestor del componente Megasoft VPOS RESTService (Smart POS).
 *
 * Arranca/detiene el servicio Java que expone http://localhost:8085/vpos/...
 * usando el JRE embebido que viene en la distribución de Megasoft.
 *
 * La distribución se empaqueta como recurso externo (extraResources `vpos-rest/`,
 * ver package.json). En producción ese recurso vive en `resourcesPath` (Program
 * Files, SOLO LECTURA), por eso se copia UNA VEZ a una carpeta escribible en
 * userData y se ejecuta desde allí — así podemos reescribir conf/vposconf.ini
 * con los parámetros por tienda (Merchant Server host/port, vtid/afiliación)
 * antes de arrancar. Mismo principio de "runtime dir" que el servidor fiscal.
 *
 * Toda la operación es desde Electron: no hay .bat ni instalación manual.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');

const { readSettings, normalizeSmartPos } = require('./titaniopos-settings-file');

const LOG_FILE = path.join(os.homedir(), 'titaniopos-smart-pos.log');
const logToFile = (msg) => {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`, 'utf8');
  } catch (_) { /* noop */ }
};
const log = (...a) => { const m = a.join(' '); console.log(m); logToFile(m); };
const logErr = (...a) => { const m = a.join(' '); console.error(m); logToFile('[ERROR] ' + m); };

const VPOS_PORT = 8085;
const MAIN_CLASS = 've.com.megasoft.vpos.service.VposWebService';

let vposProcess = null;
let isRunning = false;

/** Carpeta origen (empaquetada, posiblemente solo-lectura). */
const getVposSourceDir = () => {
  if (process.resourcesPath) {
    const prod = path.join(process.resourcesPath, 'vpos-rest');
    if (fs.existsSync(prod)) return prod;
  }
  return path.join(__dirname, 'vpos-rest');
};

/** Carpeta de ejecución escribible (userData) — desde aquí corre el VPOS. */
const getVposRuntimeDir = (app) => {
  const base = app && app.getPath ? app.getPath('userData') : path.join(os.homedir(), 'TitanioPOS');
  return path.join(base, 'vpos-rest');
};

/**
 * Copia la distribución a la carpeta escribible si falta o si la versión de la
 * app cambió (upgrade). Copia única de ~279MB en la primera ejecución.
 */
const ensureRuntimeCopy = (app) => {
  const source = getVposSourceDir();
  const runtime = getVposRuntimeDir(app);
  const version = (app && app.getVersion && app.getVersion()) || '0';
  const marker = path.join(runtime, '.installed-version');

  if (!fs.existsSync(source)) {
    throw new Error(`Distribución VPOS no encontrada en ${source}`);
  }

  let upToDate = false;
  try {
    upToDate =
      fs.existsSync(path.join(runtime, 'lib_rest', 'vposrestservice.jar')) &&
      fs.existsSync(marker) &&
      fs.readFileSync(marker, 'utf8').trim() === version;
  } catch (_) { upToDate = false; }

  if (!upToDate) {
    log(`[SMART_POS] Copiando distribución VPOS a ${runtime} (una vez)...`);
    fs.mkdirSync(runtime, { recursive: true });
    fs.cpSync(source, runtime, { recursive: true });
    try { fs.writeFileSync(marker, version, 'utf8'); } catch (_) {}
    log('[SMART_POS] Copia completa.');
  }
  return runtime;
};

const getJavaExe = (dir) => {
  const candidates = [
    path.join(dir, 'jre', 'bin', 'java.exe'),
    path.join(dir, 'jre', 'bin', 'javaw.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
};

const buildClasspath = (dir) => {
  const fromFile = path.join(dir, 'classpathRest.txt');
  if (fs.existsSync(fromFile)) {
    try {
      const raw = fs.readFileSync(fromFile, 'utf8').trim();
      return raw
        .split(';')
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => path.resolve(dir, p.replace(/^\.[\\/]/, '')))
        .join(path.delimiter);
    } catch (e) {
      logErr('[SMART_POS] No se pudo leer classpathRest.txt:', e.message);
    }
  }
  const jars = [];
  for (const sub of ['lib', 'lib_rest']) {
    const d = path.join(dir, sub);
    if (fs.existsSync(d)) {
      for (const f of fs.readdirSync(d)) {
        if (f.endsWith('.jar')) jars.push(path.join(d, f));
      }
    }
  }
  return jars.join(path.delimiter);
};

/**
 * Reescribe vposconf.ini con la config por tienda. Reemplaza SOLO las claves
 * dentro de su sección correcta:
 *   [server] host/port  y  [vtid] vtid/id
 * Conserva el resto del archivo intacto. Si no hay config, no toca nada.
 */
const applyConfigToIni = (runtimeDir, cfg) => {
  if (!cfg || (!cfg.serverHost && !cfg.serverPort && !cfg.vtid && !cfg.id)) {
    log('[SMART_POS] Sin config smartPos; se usa vposconf.ini tal cual.');
    return;
  }
  const iniPath = path.join(runtimeDir, 'conf', 'vposconf.ini');
  if (!fs.existsSync(iniPath)) {
    logErr('[SMART_POS] vposconf.ini no encontrado en', iniPath);
    return;
  }

  const overrides = {
    server: { host: cfg.serverHost, port: cfg.serverPort },
    vtid: { vtid: cfg.vtid, id: cfg.id },
  };

  const lines = fs.readFileSync(iniPath, 'utf8').split(/\r?\n/);
  let section = null;
  const out = lines.map((line) => {
    const sec = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sec) { section = sec[1].trim().toLowerCase(); return line; }
    if (section && overrides[section]) {
      const kv = line.match(/^(\s*)([A-Za-z0-9_]+)\s*=.*$/);
      if (kv) {
        const key = kv[2];
        if (key in overrides[section]) {
          const val = overrides[section][key];
          // Solo sobreescribimos si tenemos un valor; vacío = no tocar.
          if (val !== undefined && val !== null && String(val) !== '') {
            return `${kv[1]}${key}=${val}`;
          }
        }
      }
    }
    return line;
  });

  fs.writeFileSync(iniPath, out.join('\n'), 'utf8');
  log('[SMART_POS] vposconf.ini actualizado con config de la tienda.');
};

/**
 * Activa [COMPRA_MEDIOS_PAGO] activo=1 en vposuniversal.ini (requerido por Megasoft
 * para el ambiente de certificación: "activar con valor 1"). Idempotente: solo
 * toca la clave `activo` dentro de esa sección.
 */
const applyVposUniversalActivation = (runtimeDir) => {
  const iniPath = path.join(runtimeDir, 'conf', 'vposuniversal.ini');
  if (!fs.existsSync(iniPath)) return;
  try {
    const lines = fs.readFileSync(iniPath, 'utf8').split(/\r?\n/);
    let section = null, changed = false;
    const out = lines.map((line) => {
      const sec = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (sec) { section = sec[1].trim().toUpperCase(); return line; }
      if (section === 'COMPRA_MEDIOS_PAGO') {
        const kv = line.match(/^(\s*)activo\s*=\s*(.*)$/);
        if (kv && kv[2].trim() !== '1') { changed = true; return `${kv[1]}activo=1`; }
      }
      return line;
    });
    if (changed) {
      fs.writeFileSync(iniPath, out.join('\n'), 'utf8');
      log('[SMART_POS] vposuniversal.ini: [COMPRA_MEDIOS_PAGO] activo=1');
    }
  } catch (e) {
    logErr('[SMART_POS] No se pudo activar vposuniversal.ini:', e.message);
  }
};

/**
 * Asegura la sección [pinpad-verifone] en vposconf.ini con la config del P200
 * (ENGAGE por USB) que exige el ambiente de certificación de Megasoft.
 * Claves verificadas contra el jar del VPOS. Idempotente: actualiza las claves
 * si la sección existe, o la agrega completa si falta.
 */
const PINPAD_VERIFONE = {
  modelo: 'ENGAGE',
  puerto: 'USB',
  comandosNuevos: '1',
  tipoPinblock: 'DUKPT',
  dataSensibleEncriptada: '1',
};
const applyPinpadVerifone = (runtimeDir) => {
  const iniPath = path.join(runtimeDir, 'conf', 'vposconf.ini');
  if (!fs.existsSync(iniPath)) return;
  try {
    const lines = fs.readFileSync(iniPath, 'utf8').split(/\r?\n/);
    // Localizar [pinpad-verifone] y el final de su bloque.
    let start = -1, end = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*\[pinpad-verifone\]\s*$/i.test(lines[i])) { start = i;
        for (let j = i + 1; j < lines.length; j++) { if (/^\s*\[[^\]]+\]\s*$/.test(lines[j])) { end = j; break; } }
        break;
      }
    }
    if (start === -1) {
      // No existe: la agregamos al final.
      const block = ['', '[pinpad-verifone]', ...Object.entries(PINPAD_VERIFONE).map(([k, v]) => `${k}=${v}`)];
      fs.writeFileSync(iniPath, lines.concat(block).join('\n'), 'utf8');
      log('[SMART_POS] vposconf.ini: agregada sección [pinpad-verifone] (P200 ENGAGE/USB)');
      return;
    }
    // Existe: actualizar/insertar cada clave dentro del bloque [start+1, end).
    const pending = { ...PINPAD_VERIFONE };
    for (let i = start + 1; i < end; i++) {
      const kv = lines[i].match(/^(\s*)([A-Za-z0-9_]+)\s*=.*$/);
      if (kv && kv[2] in pending) { lines[i] = `${kv[1]}${kv[2]}=${pending[kv[2]]}`; delete pending[kv[2]]; }
    }
    const insert = Object.entries(pending).map(([k, v]) => `${k}=${v}`);
    if (insert.length) lines.splice(end, 0, ...insert);
    fs.writeFileSync(iniPath, lines.join('\n'), 'utf8');
    log('[SMART_POS] vposconf.ini: [pinpad-verifone] actualizado (P200 ENGAGE/USB)');
  } catch (e) {
    logErr('[SMART_POS] No se pudo aplicar [pinpad-verifone]:', e.message);
  }
};

const pingVpos = () =>
  new Promise((resolve) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: VPOS_PORT, path: '/vpos/ping', method: 'GET' },
      (res) => {
        res.resume();
        resolve((res.statusCode || 500) >= 200 && (res.statusCode || 500) < 300);
      }
    );
    req.setTimeout(2000, () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });

const startSmartPosServer = async (app) => {
  if (isRunning && vposProcess) {
    return { success: true, message: 'VPOS ya está corriendo' };
  }

  // Si ya hay un VPOS levantado, lo reusamos.
  if (await pingVpos()) {
    isRunning = true;
    log('[SMART_POS] VPOS ya respondía en :8085, se reusa.');
    return { success: true, message: 'VPOS ya estaba activo', external: true };
  }

  let runtimeDir;
  try {
    runtimeDir = ensureRuntimeCopy(app);
    const cfg = normalizeSmartPos(readSettings(app).smartPos);
    applyConfigToIni(runtimeDir, cfg);
    applyVposUniversalActivation(runtimeDir);
    applyPinpadVerifone(runtimeDir);
  } catch (e) {
    logErr('[SMART_POS] Preparación falló:', e.message);
    return { success: false, error: e.message };
  }

  const javaExe = getJavaExe(runtimeDir);
  const classpath = buildClasspath(runtimeDir);
  log('[SMART_POS] javaExe:', javaExe, '| cwd:', runtimeDir);

  return new Promise((resolve) => {
    try {
      vposProcess = spawn(javaExe, ['-classpath', classpath, MAIN_CLASS], {
        cwd: runtimeDir, // crítico: el VPOS resuelve conf/ relativo al cwd
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      vposProcess.stdout.on('data', (d) => log('[VPOS]', d.toString().trim()));
      vposProcess.stderr.on('data', (d) => logErr('[VPOS]', d.toString().trim()));

      vposProcess.on('error', (err) => {
        logErr('[SMART_POS] Process error:', err);
        isRunning = false;
        vposProcess = null;
      });
      vposProcess.on('close', (code) => {
        log('[SMART_POS] VPOS cerrado con código', code);
        isRunning = false;
        vposProcess = null;
      });

      let checks = 0;
      const maxChecks = 60; // ~30s
      const timer = setInterval(async () => {
        checks++;
        if (await pingVpos()) {
          clearInterval(timer);
          isRunning = true;
          log('[SMART_POS] VPOS RESTService listo en :8085');
          resolve({ success: true, message: 'VPOS iniciado' });
        } else if (checks >= maxChecks) {
          clearInterval(timer);
          logErr('[SMART_POS] VPOS no respondió a tiempo');
          resolve({ success: false, error: 'VPOS no respondió a tiempo' });
        }
      }, 500);
    } catch (error) {
      logErr('[SMART_POS] Falló el arranque:', error);
      resolve({ success: false, error: error.message });
    }
  });
};

const stopSmartPosServer = () => {
  if (!vposProcess) return;
  log('[SMART_POS] Deteniendo VPOS...');
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', vposProcess.pid, '/f', '/t'], { shell: true });
    } else {
      vposProcess.kill('SIGTERM');
    }
  } catch (e) {
    logErr('[SMART_POS] Error al detener:', e.message);
  }
  vposProcess = null;
  isRunning = false;
};

/** Reaplica config y reinicia el servicio (tras guardar config en la UI). */
const restartSmartPosServer = async (app) => {
  stopSmartPosServer();
  // pequeño respiro para que el puerto libere
  await new Promise((r) => setTimeout(r, 800));
  return startSmartPosServer(app);
};

module.exports = {
  startSmartPosServer,
  stopSmartPosServer,
  restartSmartPosServer,
  pingVpos,
  getVposRuntimeDir,
};
