/**
 * Gestor del Servidor Fiscal Python
 * Maneja el inicio, monitoreo y detención del servidor fiscal
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');

// Log a archivo en producción para poder diagnosticar sin consola
const LOG_FILE = path.join(os.homedir(), 'titaniopos-fiscal-server.log');
const logToFile = (msg) => {
  try {
    const line = `${new Date().toISOString()} ${msg}\n`;
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch (_) { /* si falla el log, no bloquear */ }
};
const log = (...args) => { const m = args.join(' '); console.log(m); logToFile(m); };
const logErr = (...args) => { const m = args.join(' '); console.error(m); logToFile('[ERROR] ' + m); };

// Estado del servidor
let fiscalServerProcess = null;
let isServerRunning = false;
let serverPort = 3000;
let serverStartAttempts = 0;
const MAX_START_ATTEMPTS = 3;

// Obtener rutas
const getFiscalServerDir = () => {
  // En producción (empaquetado), resourcesPath apunta a la carpeta real fuera del .asar
  // Debe tener prioridad porque __dirname dentro de .asar no es accesible por Python
  if (process.resourcesPath) {
    const prodPath = path.join(process.resourcesPath, 'fiscal-server');
    if (fs.existsSync(prodPath)) {
      return prodPath;
    }
  }

  // En desarrollo, usar la carpeta del proyecto
  const devPath = path.join(__dirname, 'fiscal-server');
  return devPath;
};

const getFiscalScript = () => {
  return path.join(getFiscalServerDir(), 'fiscal.py');
};

/**
 * Devuelve la ruta al Python embebido empaquetado con la app.
 * Si no existe (modo dev sin embed), devuelve null y caemos al Python del sistema.
 */
// Diagnóstico del último intento de localización del Python embebido.
// Se incluye en la respuesta IPC cuando algo falla para mostrarlo en la UI.
let lastEmbeddedPythonDiagnostic = '';

const getEmbeddedPython = () => {
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'python-embed', 'python.exe'));
  }
  candidates.push(path.join(__dirname, 'python-embed', 'python.exe'));
  if (__dirname.includes('app.asar')) {
    const asarParent = __dirname.split('app.asar')[0];
    candidates.push(path.join(asarParent, 'python-embed', 'python.exe'));
  }
  const diag = [`[FISCAL SERVER] getEmbeddedPython probing candidates:`];
  for (const c of candidates) {
    const exists = fs.existsSync(c);
    diag.push(`  - ${c} -> ${exists ? 'FOUND' : 'missing'}`);
    if (exists) {
      lastEmbeddedPythonDiagnostic = diag.join('\n');
      log(lastEmbeddedPythonDiagnostic);
      return c;
    }
  }
  try {
    if (process.resourcesPath && fs.existsSync(process.resourcesPath)) {
      const entries = fs.readdirSync(process.resourcesPath);
      diag.push(`resourcesPath (${process.resourcesPath}) contains: ${entries.join(', ')}`);
    } else {
      diag.push(`resourcesPath inexistente o vacío: ${process.resourcesPath}`);
    }
  } catch (e) { diag.push(`No se pudo listar resourcesPath: ${e.message}`); }
  lastEmbeddedPythonDiagnostic = diag.join('\n');
  log(lastEmbeddedPythonDiagnostic);
  return null;
};

/**
 * Verifica si Python está instalado
 */
const checkPythonInstalled = async () => {
  return new Promise((resolve) => {
    const pythonCommands = ['python', 'python3', 'py'];
    let found = false;
    let checkedCount = 0;
    
    pythonCommands.forEach((cmd) => {
      const proc = spawn(cmd, ['--version'], { shell: true });
      
      proc.on('close', (code) => {
        checkedCount++;
        if (code === 0 && !found) {
          found = true;
          resolve({ installed: true, command: cmd });
        }
        if (checkedCount === pythonCommands.length && !found) {
          resolve({ installed: false, command: null });
        }
      });
      
      proc.on('error', () => {
        checkedCount++;
        if (checkedCount === pythonCommands.length && !found) {
          resolve({ installed: false, command: null });
        }
      });
    });
  });
};

/**
 * Ejecuta `<python> --version` y devuelve la cadena de versión (ej. "Python 3.11.9").
 */
const getPythonVersion = (exec, useShell) => {
  return new Promise((resolve) => {
    try {
      const proc = spawn(exec, ['--version'], { shell: useShell });
      let out = '';
      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.stderr.on('data', (d) => { out += d.toString(); }); // Python <3.4 imprime en stderr
      proc.on('close', () => resolve(out.trim() || null));
      proc.on('error', () => resolve(null));
    } catch (_) {
      resolve(null);
    }
  });
};

/**
 * Resuelve qué Python se usará y su versión.
 * Prioriza el embebido empaquetado; cae al del sistema solo si no hay embebido.
 */
const getPythonInfo = async () => {
  const embedded = getEmbeddedPython();
  if (embedded) {
    const version = await getPythonVersion(embedded, false);
    return { installed: true, source: 'embedded', command: embedded, version };
  }
  const check = await checkPythonInstalled();
  if (check.installed) {
    const version = await getPythonVersion(check.command, true);
    return { installed: true, source: 'system', command: check.command, version };
  }
  return { installed: false, source: null, command: null, version: null };
};

/**
 * Verifica si el servidor fiscal está respondiendo
 */
const checkServerHealth = async (port = 3000) => {
  return new Promise((resolve) => {
    const options = {
      hostname: '127.0.0.1',
      port: port,
      path: '/health',
      method: 'GET',
      timeout: 5000,
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
          try {
            const json = JSON.parse(data);
            resolve({ healthy: true, data: json });
          } catch (e) {
            // Si responde algo pero no es JSON válido, igual consideramos que está vivo
            resolve({ healthy: true, data: data, warning: 'Invalid JSON health response' });
          }
        } else {
          resolve({ healthy: false, error: `Status ${res.statusCode}`, data });
        }
      });
    });
    
    req.on('error', (e) => {
      resolve({ healthy: false, error: e.message });
    });
    
    req.on('timeout', () => {
      req.destroy();
      resolve({ healthy: false, error: 'Timeout' });
    });
    
    req.end();
  });
};

/**
 * Inicia el servidor fiscal Python
 */
const startFiscalServer = async (options = {}) => {
  const { port = 3000, intfhkaPath = null } = options;
  serverPort = port;
  
  if (isServerRunning && fiscalServerProcess) {
    log('[FISCAL SERVER] Server already running');
    return { success: true, message: 'Server already running', port: serverPort };
  }

  // Verificar si el script existe
  const scriptPath = getFiscalScript();
  log('[FISCAL SERVER] resourcesPath:', process.resourcesPath);
  log('[FISCAL SERVER] fiscalServerDir:', getFiscalServerDir());
  log('[FISCAL SERVER] scriptPath:', scriptPath, '| exists:', fs.existsSync(scriptPath));
  if (!fs.existsSync(scriptPath)) {
    logErr('[FISCAL SERVER] Script not found:', scriptPath);
    return { success: false, error: `Fiscal server script not found at: ${scriptPath}` };
  }

  // Resolver Python: preferimos el embebido empaquetado con la app
  const embeddedPython = getEmbeddedPython();
  let pythonExec;
  let useShell;
  if (embeddedPython) {
    pythonExec = embeddedPython;
    useShell = false;
    log('[FISCAL SERVER] Using embedded Python:', embeddedPython);
  } else {
    const pythonCheck = await checkPythonInstalled();
    if (!pythonCheck.installed) {
      logErr('[FISCAL SERVER] Python not installed and no embedded Python found');
      return { success: false, error: 'Python is not installed on this system' };
    }
    pythonExec = pythonCheck.command;
    useShell = true;
    log('[FISCAL SERVER] Using system Python:', pythonCheck.command);
  }

  log('[FISCAL SERVER] Starting fiscal server...');
  log('[FISCAL SERVER] Script:', scriptPath);
  log('[FISCAL SERVER] Port:', port);

  // Configurar variables de entorno
  const env = { ...process.env };
  env.FISCAL_SERVER_PORT = port.toString();
  env.PYTHONUNBUFFERED = '1'; // Forzar flush inmediato de stdout/stderr
  // Desactivar hka_serial: solo IntTFHKA.exe maneja la impresora fiscal.
  // hka_serial no puede cerrar documentos (NAK en pago) y compite por el
  // puerto COM con IntTFHKA.exe causando Error 128.
  env.USE_HKA_SERIAL = '0';
  if (intfhkaPath) {
    env.INTFHKA_PATH = intfhkaPath;
  }

  // Directorio escribible para Factura.txt, Puerto.dat, data/, etc.
  // En producción BASE_DIR vive en Program Files y NO es escribible.
  const runtimeDir = path.join(
    process.env.APPDATA || os.homedir(),
    'TitanioPOS',
    'fiscal'
  );
  try { fs.mkdirSync(runtimeDir, { recursive: true }); } catch (_) {}
  env.FISCAL_RUNTIME_DIR = runtimeDir;
  log('[FISCAL SERVER] FISCAL_RUNTIME_DIR:', runtimeDir);

  // Buffer circular para devolver al frontend si arranque falla
  const recentStderr = [];
  const recentStdout = [];
  const pushBounded = (arr, line) => { arr.push(line); if (arr.length > 30) arr.shift(); };

  return new Promise((resolve) => {
    try {
      fiscalServerProcess = spawn(pythonExec, [scriptPath], {
        cwd: getFiscalServerDir(),
        env: env,
        shell: useShell,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      fiscalServerProcess.stdout.on('data', (data) => {
        const s = data.toString().trim();
        pushBounded(recentStdout, s);
        log('[FISCAL SERVER]', s);
      });

      fiscalServerProcess.stderr.on('data', (data) => {
        const s = data.toString().trim();
        pushBounded(recentStderr, s);
        logErr('[FISCAL SERVER ERROR]', s);
      });

      fiscalServerProcess.on('error', (error) => {
        logErr('[FISCAL SERVER] Process error:', error);
        isServerRunning = false;
        fiscalServerProcess = null;
      });

      fiscalServerProcess.on('close', (code) => {
        log('[FISCAL SERVER] Process closed with code:', code);
        isServerRunning = false;
        fiscalServerProcess = null;

        // Intentar reiniciar si se cerró inesperadamente
        if (serverStartAttempts < MAX_START_ATTEMPTS) {
          serverStartAttempts++;
          log(`[FISCAL SERVER] Attempting restart (${serverStartAttempts}/${MAX_START_ATTEMPTS})...`);
          setTimeout(() => startFiscalServer(options), 2000);
        }
      });

      // Esperar a que el servidor esté listo
      let checkCount = 0;
      const maxChecks = 60; // 30 segundos para darle más tiempo a Flask

      const checkReady = setInterval(async () => {
        checkCount++;
        const health = await checkServerHealth(port);

        if (health.healthy) {
          clearInterval(checkReady);
          isServerRunning = true;
          serverStartAttempts = 0;
          log('[FISCAL SERVER] Server is ready!');
          resolve({ success: true, message: 'Server started successfully', port: port });
        } else if (checkCount >= maxChecks) {
          clearInterval(checkReady);
          const stderrTail = recentStderr.slice(-10).join('\n');
          const stdoutTail = recentStdout.slice(-10).join('\n');
          const detail = stderrTail || stdoutTail || 'sin salida del proceso Python';
          const fullError =
            `Server failed to start in time.\n` +
            `Python usado: ${pythonExec}\n` +
            `--- Localización Python embebido ---\n${lastEmbeddedPythonDiagnostic || '(no se intentó)'}\n` +
            `--- Salida del proceso ---\n${detail}`;
          logErr('[FISCAL SERVER] ' + fullError);
          stopFiscalServer();
          resolve({
            success: false,
            error: fullError,
            stderr: recentStderr,
            stdout: recentStdout,
            pythonExec,
            scriptPath,
            embeddedPythonDiagnostic: lastEmbeddedPythonDiagnostic,
          });
        }
      }, 500);

    } catch (error) {
      logErr('[FISCAL SERVER] Failed to start:', error);
      resolve({ success: false, error: error.message });
    }
  });
};

/**
 * Detiene el servidor fiscal
 */
const stopFiscalServer = () => {
  if (fiscalServerProcess) {
    log('[FISCAL SERVER] Stopping server...');
    
    // En Windows, necesitamos matar el proceso de forma diferente
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', fiscalServerProcess.pid, '/f', '/t'], { shell: true });
    } else {
      fiscalServerProcess.kill('SIGTERM');
    }
    
    fiscalServerProcess = null;
    isServerRunning = false;
    log('[FISCAL SERVER] Server stopped');
  }
};

/**
 * Obtiene el estado del servidor
 */
const getServerStatus = async () => {
  const health = await checkServerHealth(serverPort);
  
  // Asegurar que todo sea serializable (evitar 'An object could not be cloned')
  let healthData = null;
  try {
    healthData = health.data ? JSON.parse(JSON.stringify(health.data)) : null;
  } catch (e) {
    healthData = null;
  }
  
  return {
    running: isServerRunning,
    healthy: health.healthy,
    port: serverPort,
    pid: fiscalServerProcess ? fiscalServerProcess.pid : null,
    serverDir: getFiscalServerDir(),
    scriptPath: getFiscalScript(),
    healthData: healthData,
  };
};

/**
 * Reinicia el servidor fiscal
 */
const restartFiscalServer = async (options = {}) => {
  console.log('[FISCAL SERVER] Restarting server...');
  stopFiscalServer();
  
  // Esperar a que el proceso se cierre
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  return startFiscalServer(options);
};

module.exports = {
  startFiscalServer,
  stopFiscalServer,
  getServerStatus,
  restartFiscalServer,
  checkServerHealth,
  checkPythonInstalled,
  getEmbeddedPython,
  getPythonInfo,
  getFiscalServerDir,
};
