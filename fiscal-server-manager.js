/**
 * Gestor del Servidor Fiscal Python
 * Maneja el inicio, monitoreo y detención del servidor fiscal
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

// Estado del servidor
let fiscalServerProcess = null;
let isServerRunning = false;
let serverPort = 3000;
let serverStartAttempts = 0;
const MAX_START_ATTEMPTS = 3;

// Obtener rutas
const getFiscalServerDir = () => {
  // En desarrollo, usar la carpeta del proyecto
  // En producción, usar la carpeta de recursos de la app
  const devPath = path.join(__dirname, 'fiscal-server');
  if (fs.existsSync(devPath)) {
    return devPath;
  }
  
  // En producción (empaquetado)
  const prodPath = path.join(process.resourcesPath, 'fiscal-server');
  if (fs.existsSync(prodPath)) {
    return prodPath;
  }
  
  return devPath;
};

const getFiscalScript = () => {
  return path.join(getFiscalServerDir(), 'fiscal.py');
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
    console.log('[FISCAL SERVER] Server already running');
    return { success: true, message: 'Server already running', port: serverPort };
  }
  
  // Verificar si el script existe
  const scriptPath = getFiscalScript();
  if (!fs.existsSync(scriptPath)) {
    console.error('[FISCAL SERVER] Script not found:', scriptPath);
    return { success: false, error: 'Fiscal server script not found' };
  }
  
  // Verificar Python
  const pythonCheck = await checkPythonInstalled();
  if (!pythonCheck.installed) {
    console.error('[FISCAL SERVER] Python not installed');
    return { success: false, error: 'Python is not installed on this system' };
  }
  
  console.log('[FISCAL SERVER] Starting fiscal server...');
  console.log('[FISCAL SERVER] Script:', scriptPath);
  console.log('[FISCAL SERVER] Python:', pythonCheck.command);
  console.log('[FISCAL SERVER] Port:', port);
  
  // Configurar variables de entorno
  const env = { ...process.env };
  env.FISCAL_SERVER_PORT = port.toString();
  if (intfhkaPath) {
    env.INTFHKA_PATH = intfhkaPath;
  }
  
  return new Promise((resolve) => {
    try {
      fiscalServerProcess = spawn(pythonCheck.command, [scriptPath], {
        cwd: getFiscalServerDir(),
        env: env,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      
      fiscalServerProcess.stdout.on('data', (data) => {
        console.log('[FISCAL SERVER]', data.toString().trim());
      });
      
      fiscalServerProcess.stderr.on('data', (data) => {
        console.error('[FISCAL SERVER ERROR]', data.toString().trim());
      });
      
      fiscalServerProcess.on('error', (error) => {
        console.error('[FISCAL SERVER] Process error:', error);
        isServerRunning = false;
        fiscalServerProcess = null;
      });
      
      fiscalServerProcess.on('close', (code) => {
        console.log('[FISCAL SERVER] Process closed with code:', code);
        isServerRunning = false;
        fiscalServerProcess = null;
        
        // Intentar reiniciar si se cerró inesperadamente
        if (serverStartAttempts < MAX_START_ATTEMPTS) {
          serverStartAttempts++;
          console.log(`[FISCAL SERVER] Attempting restart (${serverStartAttempts}/${MAX_START_ATTEMPTS})...`);
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
          console.log('[FISCAL SERVER] Server is ready!');
          resolve({ success: true, message: 'Server started successfully', port: port });
        } else if (checkCount >= maxChecks) {
          clearInterval(checkReady);
          console.error('[FISCAL SERVER] Server failed to start in time');
          stopFiscalServer();
          resolve({ success: false, error: 'Server failed to start in time' });
        }
      }, 500);
      
    } catch (error) {
      console.error('[FISCAL SERVER] Failed to start:', error);
      resolve({ success: false, error: error.message });
    }
  });
};

/**
 * Detiene el servidor fiscal
 */
const stopFiscalServer = () => {
  if (fiscalServerProcess) {
    console.log('[FISCAL SERVER] Stopping server...');
    
    // En Windows, necesitamos matar el proceso de forma diferente
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', fiscalServerProcess.pid, '/f', '/t'], { shell: true });
    } else {
      fiscalServerProcess.kill('SIGTERM');
    }
    
    fiscalServerProcess = null;
    isServerRunning = false;
    console.log('[FISCAL SERVER] Server stopped');
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
  getFiscalServerDir,
};
