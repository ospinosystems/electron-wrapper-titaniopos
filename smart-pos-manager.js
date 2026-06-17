/**
 * Gestor del componente Megasoft VPOS RESTService (Smart POS).
 *
 * Arranca/detiene el servicio Java que expone http://localhost:8085/vpos/...
 * usando el JRE embebido que viene en la distribución de Megasoft.
 *
 * La distribución completa (VposUniversal_x.y.z) se empaqueta como recurso
 * externo bajo `vpos-rest/` (ver extraResources en package.json). En desarrollo
 * se busca en `<repo>/vpos-rest`.
 *
 * Equivalente a fiscal-server-manager.js pero para el servicio VPOS.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');

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

/** Carpeta raíz de la distribución del VPOS RESTService. */
const getVposDir = () => {
  if (process.resourcesPath) {
    const prod = path.join(process.resourcesPath, 'vpos-rest');
    if (fs.existsSync(prod)) return prod;
  }
  return path.join(__dirname, 'vpos-rest');
};

const getJavaExe = () => {
  const dir = getVposDir();
  // El bat usa javaw (sin consola); en empaquetado preferimos java.exe para
  // poder capturar stdout/stderr al log.
  const candidates = [
    path.join(dir, 'jre', 'bin', 'java.exe'),
    path.join(dir, 'jre', 'bin', 'javaw.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
};

/**
 * Construye el classpath leyendo classpathRest.txt si existe, o cayendo a un
 * glob de lib/ + lib_rest/. classpathRest.txt es generado por Megasoft con el
 * orden correcto de jars.
 */
const buildClasspath = (dir) => {
  const fromFile = path.join(dir, 'classpathRest.txt');
  if (fs.existsSync(fromFile)) {
    try {
      const raw = fs.readFileSync(fromFile, 'utf8').trim();
      // El archivo trae rutas relativas (.\lib\...) separadas por ; — las
      // resolvemos contra `dir` para que funcionen con cwd absoluto.
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
  // Fallback: todos los jars de lib y lib_rest.
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

const startSmartPosServer = async () => {
  if (isRunning && vposProcess) {
    return { success: true, message: 'VPOS ya está corriendo' };
  }

  // Si ya hay un VPOS levantado (instalado manualmente / autostart de Windows),
  // no arrancamos otro: solo lo usamos.
  if (await pingVpos()) {
    isRunning = true;
    log('[SMART_POS] VPOS ya respondía en :8085, no se arranca otra instancia');
    return { success: true, message: 'VPOS ya estaba activo', external: true };
  }

  const dir = getVposDir();
  if (!fs.existsSync(dir)) {
    const msg = `Distribución VPOS no encontrada en ${dir}`;
    logErr('[SMART_POS] ' + msg);
    return { success: false, error: msg };
  }

  const javaExe = getJavaExe();
  const classpath = buildClasspath(dir);
  log('[SMART_POS] javaExe:', javaExe);
  log('[SMART_POS] cwd:', dir);

  return new Promise((resolve) => {
    try {
      vposProcess = spawn(javaExe, ['-classpath', classpath, MAIN_CLASS], {
        cwd: dir, // crítico: el VPOS resuelve conf/ relativo al cwd
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

module.exports = {
  startSmartPosServer,
  stopSmartPosServer,
  pingVpos,
  getVposDir,
};
