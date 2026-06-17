const { app, BrowserWindow, ipcMain, Menu, dialog, nativeImage, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');

function readBuildAppId() {
  try {
    const pkgPath = path.join(__dirname, 'package.json');
    if (!fs.existsSync(pkgPath)) return 'com.titaniopos.desktop';
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return (pkg.build && pkg.build.appId) || 'com.titaniopos.desktop';
  } catch {
    return 'com.titaniopos.desktop';
  }
}

const APP_ID = readBuildAppId();
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID);
}

// ───── DEBUG: log env vars que controlan flags A/B test ─────
// Pegado al arranque para verificar que el env var efectivamente llega al
// proceso de Electron. Si decís "set FOO=1" en una shell y acá `FOO` sigue
// undefined, es que el env var no se propagó al spawn de Electron.
console.log('[A/B-TEST] Env vars al arranque:');
console.log('  TITANIOPOS_SKIP_GPU_FLAGS =', process.env.TITANIOPOS_SKIP_GPU_FLAGS ?? '(not set)');
console.log('  TITANIOPOS_SKIP_PRIORITY  =', process.env.TITANIOPOS_SKIP_PRIORITY ?? '(not set)');
console.log('  TITANIOPOS_SKIP_FISCAL    =', process.env.TITANIOPOS_SKIP_FISCAL ?? '(not set)');

// Apply low-end PC optimizations BEFORE anything else (must run before app.ready)
const {
  applyElectronOptimizations,
  applyRuntimeOptimizations,
  raiseRendererPriority,
} = require('./electron-optimization');

// (Diagnóstico de GPU removido — confirmado que GPU process arranca correctamente
//  con gl=egl-angle, angle=d3d11, inProcessGpu=false, directComposition=true.)
// ───── TOGGLE HARDCODED: cambiá `APPLY_OPTIMIZATIONS` para A/B test ─────
//
//   true  = aplicamos nuestros flags custom (perfil Celeron 4GB)
//   false = NADA, defaults puros de Chromium (lo más cerca posible al navegador)
//
// Ahora mismo en `false` para descartar definitivamente que alguno de nuestros
// flags esté causando el lag de animación que el navegador no tiene. Si con
// false va fluido = uno de nuestros flags es el culpable, lo bisectamos.
// Si con false sigue igual = es algo intrínseco a Electron.
const APPLY_OPTIMIZATIONS = false;
if (!APPLY_OPTIMIZATIONS || process.env.TITANIOPOS_SKIP_GPU_FLAGS === '1') {
  console.log('[PERF] *** SKIPPING all custom Chromium flags ***');
} else {
  applyElectronOptimizations();
}

// CRÍTICO — flags de background, fuera del condicional APPLY_OPTIMIZATIONS.
// Estos NO tocan animaciones ni rendering, solo previenen que Chromium
// ralentice/congele el renderer cuando la ventana se minimiza. Sin esto, el
// sync inicial de Electric SQL se paraliza al minimizar y los live updates
// de otras cajas tardan en aplicarse hasta que la ventana vuelve al frente.
//
// `webPreferences.backgroundThrottling: false` no es suficiente porque solo
// cubre animations + timers a nivel de página, no el process backgrounding
// completo. Estos 3 flags atacan los 3 mecanismos distintos:
//   - background-timer-throttling: timers (setTimeout/setInterval) se ejecutan
//     a velocidad normal en background en vez de cada ~1 min.
//   - renderer-backgrounding: el renderer process mantiene prioridad normal
//     de CPU/IO en lugar de bajar a "background".
//   - backgrounding-occluded-windows: ventanas ocultas/minimizadas no entran
//     en estado "occluded" que también throttea.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
console.log('[PERF] Background throttling disabled (sync sigue corriendo minimized)');

const crypto = require('crypto');
const { autoUpdater } = require('electron-updater');
const jwt = require('jsonwebtoken');
const { registerPrinterHandlers } = require('./printer-handlers');
const { registerFiscalHandlers } = require('./fiscal-handlers');
const { registerPinpadHandlers } = require('./pinpad-handlers');
const { registerSmartPosHandlers } = require('./smart-pos-handlers');
const { startSmartPosServer, stopSmartPosServer, restartSmartPosServer, stopSimulator, setSmartPosTestMode } = require('./smart-pos-manager');
const { registerCajaConfigHandlers } = require('./caja-config-handlers');
const { registerRemoteSupportHandlers, startRemoteSupportIfEnabled } = require('./remote-support-handlers');
const { registerPrinterDriverHandlers } = require('./printer-driver-handlers');
const {
  migrateToUnifiedSettings,
  splitFiscalResponsesFromUnifiedIfPresent,
} = require('./titaniopos-settings-file');
const {
  startFiscalServer,
  stopFiscalServer,
  getServerStatus,
  checkPythonInstalled
} = require('./fiscal-server-manager');

// Cargar .env de la raíz del proyecto antes de leer process.env (Electron no lo hace solo).
const loadEnvFile = (envPath, logTag) => {
  try {
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, 'utf-8');
    content.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const idx = trimmed.indexOf('=');
      if (idx === -1) return;
      const key = trimmed.slice(0, idx).trim();
      let val = trimmed.slice(idx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key && !(key in process.env)) {
        process.env[key] = val;
      }
    });
    if (logTag) console.log('[ENV] Loaded', logTag);
  } catch (error) {
    console.warn('[ENV] Could not load', envPath, error.message);
  }
};

const ROOT_ENV_PATH = path.join(__dirname, '.env');
loadEnvFile(ROOT_ENV_PATH, ROOT_ENV_PATH);

// Secret key para JWT (legado) y HMAC (nuevo formato) — en producción debe venir por env.
const JWT_SECRET = process.env.TITANIOPOS_JWT_SECRET || 'titaniopos-secure-key-2024-change-in-production';
const BACKUP_HMAC_SECRET = process.env.TITANIOPOS_BACKUP_SECRET || JWT_SECRET;
const BACKUP_FORMAT_VERSION = 2;

// Firma HMAC-SHA256 sobre el JSON canónico de `data`. ~1ms para 50KB en Celeron — ~10x más
// barato que JWT y el archivo queda legible: el JSON de las órdenes va plano y la firma es un
// campo aparte. Si alguien edita el archivo a mano, la verificación falla al leer.
const computeBackupSignature = (data) => {
  const canonical = JSON.stringify(data);
  return crypto.createHmac('sha256', BACKUP_HMAC_SECRET).update(canonical).digest('hex');
};

const verifyBackupSignature = (data, signature) => {
  if (typeof signature !== 'string' || !signature) return false;
  const expected = computeBackupSignature(data);
  // timingSafeEqual exige buffers de la misma longitud — si difieren, no coinciden.
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

const getBackupDir = () => {
  const documentsPath = app.getPath('documents');
  const backupDir = path.join(documentsPath, 'TitanioPOS-Backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  return backupDir;
};
const loadFiscalEnv = () => {
  loadEnvFile(
    path.join(__dirname, 'fiscal-server', '.env'),
    'fiscal-server/.env'
  );
};

// Codificar datos como JWT (sin expiración para mantener respaldo indefinidamente)
const encodeToJWT = (data) => {
  try {
    return jwt.sign({ data }, JWT_SECRET);
  } catch (error) {
    console.error('❌ [JWT] Error codificando:', error);
    throw error;
  }
};

// Decodificar JWT a datos
const decodeFromJWT = (token) => {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded.data;
  } catch (error) {
    console.error('❌ [JWT] Error decodificando:', error);
    throw error;
  }
};

// Decodificar backup con tolerancia:
// 1) JWT verificado (modo normal)
// 2) JWT sin verificación de firma (modo temporal)
// 3) JSON plano serializado dentro de "token"
const decodeBackupTokenSafely = (token) => {
  if (typeof token !== 'string' || !token.trim()) return null;

  try {
    return decodeFromJWT(token);
  } catch (verifiedError) {
    if (BACKUP_STRICT_JWT) throw verifiedError;
    console.warn('⚠️ [BACKUP] JWT no verificable, usando lectura tolerante temporal.');
  }

  try {
    const unverified = jwt.decode(token);
    if (unverified && typeof unverified === 'object') {
      if (unverified.data && typeof unverified.data === 'object') return unverified.data;
      if (unverified.orders && Array.isArray(unverified.orders)) return unverified;
    }
  } catch (decodeError) {
    console.warn('⚠️ [BACKUP] No se pudo decodificar JWT sin verificar:', decodeError.message);
  }

  try {
    const parsed = JSON.parse(token);
    if (parsed && typeof parsed === 'object') {
      if (parsed.data && typeof parsed.data === 'object') return parsed.data;
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
};

// URL de la PWA: si no hay .env o TITANIOPOS_URL vacía → local (así ves claro si se leyó la config)
const DEFAULT_APP_URL = "http://localhost:3001";
const rootEnvExists = fs.existsSync(ROOT_ENV_PATH);
const rawAppUrl = (process.env.TITANIOPOS_URL || '').trim();
const APP_URL = rawAppUrl || DEFAULT_APP_URL;

if (!rootEnvExists) {
  console.warn(
    `[ENV] Sin archivo .env (${ROOT_ENV_PATH}) → TITANIOPOS_URL = ${APP_URL}. ` +
      'En producción debe existir .env empaquetado o variable de entorno del sistema.'
  );
} else if (!rawAppUrl) {
  console.warn(
    `[ENV] .env leído pero TITANIOPOS_URL vacía o ausente → usando local: ${APP_URL}`
  );
} else {
  console.log('[ENV] TITANIOPOS_URL:', APP_URL);
}

function envFlagTrue(name) {
  const v = String(process.env[name] || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** Solo si está en .env: abre DevTools al arrancar (sin pedir contraseña). */
const OPEN_DEVTOOLS_ON_START = envFlagTrue('TITANIOPOS_OPEN_DEVTOOLS_ON_START');
// Temporal: por defecto no bloquea backups con JWT inválido; activa true para volver a modo estricto.
const BACKUP_STRICT_JWT = envFlagTrue('TITANIOPOS_BACKUP_STRICT_JWT');
// Temporal: por defecto escribe backups en JSON plano. Mantiene lectura retrocompatible JWT.
const BACKUP_WRITE_JWT = envFlagTrue('TITANIOPOS_BACKUP_WRITE_JWT');

let mainWindow;
let devtoolsPasswordPromptWindow = null;

// Una sola instancia de la app (Windows/Linux: evita dos TitanioPOS en paralelo).
// Si el usuario abre el .exe de nuevo, esta instancia sale y la primera recibe 'second-instance'.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

function setupNativeContextMenu(window) {
  if (!window) return;

  window.webContents.on('context-menu', (event, params) => {
    const { editFlags } = params || {};
    const hasSelection = Boolean(params && params.selectionText && params.selectionText.trim());
    const isEditable = Boolean(params && params.isEditable);

    const template = [];

    if (isEditable) {
      template.push(
        {
          label: 'Cortar',
          enabled: Boolean(editFlags && editFlags.canCut),
          click: () => window.webContents.cut(),
        },
        {
          label: 'Copiar',
          enabled: Boolean(editFlags && editFlags.canCopy),
          click: () => window.webContents.copy(),
        },
        {
          label: 'Pegar',
          enabled: Boolean(editFlags && editFlags.canPaste),
          click: () => window.webContents.paste(),
        },
        { type: 'separator' },
        {
          label: 'Seleccionar todo',
          enabled: Boolean(editFlags && editFlags.canSelectAll),
          click: () => window.webContents.selectAll(),
        }
      );
    } else if (hasSelection) {
      template.push(
        {
          label: 'Copiar',
          enabled: true,
          click: () => window.webContents.copy(),
        },
        { type: 'separator' },
        {
          label: 'Seleccionar todo',
          enabled: Boolean(editFlags && editFlags.canSelectAll),
          click: () => window.webContents.selectAll(),
        }
      );
    } else {
      template.push({
        label: 'Seleccionar todo',
        enabled: Boolean(editFlags && editFlags.canSelectAll),
        click: () => window.webContents.selectAll(),
      });
    }

    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window });
  });
}

// Cierra una BrowserWindow efímera de impresión y dispara GC manual en el main
// process. Las print windows acumulan buffers de PDF/imagen que V8 sólo libera
// cuando le da la gana — en Celeron 4 GB ese delay hace que la siguiente venta
// arranque ya en presión de memoria. El delay de 500 ms da tiempo a que
// Chromium destruya el renderer antes de pedir el GC.
function closeAndGcPrintWindow(printWindow) {
  try {
    if (printWindow && !printWindow.isDestroyed()) printWindow.close();
  } catch (_) {
    /* ignore */
  }
  if (global.gc) {
    setTimeout(() => {
      try { global.gc(); } catch (_) { /* ignore */ }
    }, 500);
  }
}

// icon.ico no puede cargarse con nativeImage desde dentro de app.asar en Windows.
// En package.json: asarUnpack de archivos .ico → app.asar.unpacked.
function getAppIconPath() {
  const candidates = [];
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'icon.ico'));
  }
  candidates.push(path.join(__dirname, 'icon.ico'));
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function resolveWindowIcon() {
  const icoPath = getAppIconPath();
  if (!icoPath) {
    console.warn('[APP] No se encontró icon.ico en disco (rutas comprobadas para empaquetado + dev).');
    return undefined;
  }
  try {
    const img = nativeImage.createFromPath(icoPath);
    if (img.isEmpty()) {
      console.warn('[APP] icon.ico no se pudo decodificar (archivo vacío o formato inválido).');
      return undefined;
    }
    return img;
  } catch (e) {
    console.warn('[APP] Error cargando icon.ico:', e.message);
    return undefined;
  }
}

const DEVTOOLS_PWD_SUBMIT = 'devtools-password-submit';
const DEVTOOLS_PWD_CANCEL = 'devtools-password-cancel';

function openDevToolsWithPasswordDialog(browserWindow) {
  const win = browserWindow && !browserWindow.isDestroyed() ? browserWindow : mainWindow;
  if (!win || win.isDestroyed()) return;

  if (win.webContents.isDevToolsOpened()) {
    try {
      const dc = win.webContents.devToolsWebContents;
      if (dc && !dc.isDestroyed()) dc.focus();
    } catch (_) {
      /* ignore */
    }
    return;
  }

  // Mismo flag que abre DevTools al arrancar: modo desarrollo/diagnóstico sin contraseña
  if (OPEN_DEVTOOLS_ON_START) {
    win.webContents.openDevTools();
    return;
  }

  const expected = (process.env.TITANIOPOS_DEVTOOLS_PASSWORD || '').trim();
  if (!expected) {
    dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Consola de desarrollo',
      message: 'La consola está protegida por contraseña, pero no hay ninguna definida.',
      detail:
        'Añada TITANIOPOS_DEVTOOLS_PASSWORD en el archivo .env junto a la app de TitanioPOS (o en variables de entorno del sistema).',
    });
    return;
  }

  if (devtoolsPasswordPromptWindow && !devtoolsPasswordPromptWindow.isDestroyed()) {
    devtoolsPasswordPromptWindow.focus();
    return;
  }

  const promptWin = new BrowserWindow({
    parent: win,
    modal: true,
    width: 440,
    height: 240,
    show: false,
    autoHideMenuBar: true,
    title: 'Consola de desarrollo',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  devtoolsPasswordPromptWindow = promptWin;

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    body{font-family:system-ui,sans-serif;margin:16px;background:#f5f5f5;}
    .box{background:#fff;padding:16px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.12);}
    label{display:block;margin-bottom:8px;font-size:13px;color:#333;}
    input{width:100%;box-sizing:border-box;padding:8px;margin-bottom:12px;border:1px solid #ccc;border-radius:4px;}
    .row{margin-top:8px;}
    button{padding:8px 16px;margin-right:8px;border-radius:4px;cursor:pointer;}
    #e{color:#c00;font-size:12px;margin-top:8px;min-height:16px;}
  </style></head><body><div class="box">
  <label>Contraseña</label>
  <input type="password" id="p" autofocus />
  <div class="row"><button type="button" id="ok">Abrir consola</button><button type="button" id="cancel">Cancelar</button></div>
  <div id="e"></div>
  <script>
    const { ipcRenderer } = require('electron');
    const submit = () => ipcRenderer.send('${DEVTOOLS_PWD_SUBMIT}', document.getElementById('p').value);
    document.getElementById('ok').onclick = submit;
    document.getElementById('cancel').onclick = () => ipcRenderer.send('${DEVTOOLS_PWD_CANCEL}');
    document.getElementById('p').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit(); });
  </script>
</div></body></html>`;

  const finish = () => {
    if (!promptWin.isDestroyed()) promptWin.close();
  };

  const onSubmit = (event, pwd) => {
    if (event.sender !== promptWin.webContents) return;
    if (String(pwd || '').trim() === expected) {
      if (!win.isDestroyed()) win.webContents.openDevTools();
      finish();
      return;
    }
    promptWin.webContents
      .executeJavaScript(`document.getElementById('e').textContent = 'Contraseña incorrecta';`)
      .catch(() => {});
  };

  const onCancel = (event) => {
    if (event.sender !== promptWin.webContents) return;
    finish();
  };

  promptWin.on('closed', () => {
    ipcMain.removeListener(DEVTOOLS_PWD_SUBMIT, onSubmit);
    ipcMain.removeListener(DEVTOOLS_PWD_CANCEL, onCancel);
    devtoolsPasswordPromptWindow = null;
  });

  ipcMain.on(DEVTOOLS_PWD_SUBMIT, onSubmit);
  ipcMain.on(DEVTOOLS_PWD_CANCEL, onCancel);

  promptWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  promptWin.once('ready-to-show', () => promptWin.show());
}

function createWindow() {
  if (process.platform === 'win32' && !app.isPackaged) {
    console.log(
      '[APP] Desarrollo (npm start): en la barra de tareas suele verse el icono de Electron porque el proceso es electron.exe. ' +
      'Para ver el icono de TitanioPOS, ejecuta el instalador o dist\\win-unpacked\\TitanioPOS.exe.'
    );
  }

  if (process.platform === 'win32') {
    app.setAppUserModelId(APP_ID);
  }

  const winIcon = resolveWindowIcon();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 600,
    // backgroundColor evita el flash blanco inicial sin afectar la carga.
    // No usamos show:false porque cuando la PWA tarda en responder, el
    // usuario se queda mirando una pantalla gris sin feedback.
    backgroundColor: '#111827',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
      spellcheck: false,
      enablePreferredSizeMode: false,
      offscreen: false,
    },
    icon: winIcon,
    autoHideMenuBar: true,
    title: 'TitanioPOS'
  });

  mainWindow.loadURL(APP_URL);

  if (process.platform === 'win32' && winIcon) {
    mainWindow.once('show', () => {
      try {
        mainWindow.setIcon(winIcon);
      } catch (_) {
        /* ignore */
      }
    });
  }

  // Renderer is spawned NORMAL even when main is HIGH — raise it once the
  // PID is real (did-finish-load is the first event with a valid OS PID).
  mainWindow.webContents.once('did-finish-load', () => {
    raiseRendererPriority(mainWindow.webContents);
  });

  setupNativeContextMenu(mainWindow);
  buildApplicationMenu();

  // ==================== KEYBOARD / ZOOM CUSTOMIZATIONS ====================

  // Ctrl+Scroll → browser-like zoom
  mainWindow.webContents.on('zoom-changed', (event, zoomDirection) => {
    const current = mainWindow.webContents.getZoomFactor();
    if (zoomDirection === 'in') {
      mainWindow.webContents.setZoomFactor(Math.min(current + 0.1, 3.0));
    } else {
      mainWindow.webContents.setZoomFactor(Math.max(current - 0.1, 0.3));
    }
  });

  // Intercept specific key combos via before-input-event
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    const isMac = process.platform === 'darwin';
    const mod = isMac ? input.meta : input.control;
    const keyLower = input.key.toLowerCase();

    // Atajos de DevTools de Chromium → pedir contraseña (no abrir consola directamente)
    const isDevtoolsShortcut =
      input.key === 'F12' ||
      (mod && input.shift && !input.alt && ['i', 'j', 'c'].includes(keyLower)) ||
      (isMac && mod && input.alt && ['i', 'j', 'c'].includes(keyLower));

    if (isDevtoolsShortcut) {
      event.preventDefault();
      openDevToolsWithPasswordDialog(mainWindow);
      return;
    }

    // Ctrl+M → completely disabled
    if (input.control && !input.shift && !input.alt && !input.meta && input.key.toLowerCase() === 'm') {
      event.preventDefault();
      return;
    }

    // Ctrl+Shift+G → abrir chrome://gpu en ventana aparte para diagnóstico
    // del pipeline GPU. Sólo accesible vía atajo (no toca menú ni UI).
    if (input.control && input.shift && !input.alt && !input.meta && keyLower === 'g') {
      event.preventDefault();
      const gpuWin = new BrowserWindow({
        width: 1100,
        height: 800,
        title: 'chrome://gpu',
        webPreferences: { sandbox: true, contextIsolation: true },
      });
      gpuWin.setMenuBarVisibility(false);
      gpuWin.loadURL('chrome://gpu');
      return;
    }

    // Ctrl+F5: handled in the renderer (toast) + ipcMain 'reload-ignoring-cache'
  });

  if (OPEN_DEVTOOLS_ON_START) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.executeJavaScript(`
      window._originalPrint = window.print;
      window.print = function() {
        window.postMessage({ type: 'TITANIO_PRINT' }, '*');
      };
    `);

    // ─── PERF DIAG: medir DPR + FPS real durante 5s ────────────────────────
    // Browser-vs-Electron paridad: si el navegador en la MISMA máquina con
    // el MISMO contenido va fluido y Electron lagguea, el culpable más
    // probable es DPR > 1 (Windows DPI scaling) o un frame scheduler
    // distinto. Medimos para tener evidencia dura.
    //
    // Salida vía console.log → Electron main process console (vemos los
    // logs incluso sin DevTools). El prefijo [PERF-DIAG] hace fácil grep.
    //
    // Cómo comparar: abrí el mismo URL en Chrome/Edge en la misma máquina,
    // abrí DevTools (F12), pegá el snippet de "browser side" más abajo en
    // la consola del navegador, y comparás los números.
    mainWindow.webContents.executeJavaScript(`
      (function() {
        const dpr = window.devicePixelRatio;
        const sw = window.screen.width;
        const sh = window.screen.height;
        const iw = window.innerWidth;
        const ih = window.innerHeight;
        const ow = window.outerWidth;
        const oh = window.outerHeight;
        console.log('[PERF-DIAG] DPR=' + dpr + ' screen=' + sw + 'x' + sh +
                    ' inner=' + iw + 'x' + ih + ' outer=' + ow + 'x' + oh);

        // FPS counter via rAF — 5 segundos de muestreo idle (sin animación).
        let frames = 0;
        let lastTs = performance.now();
        const buckets = [];
        function tick(ts) {
          frames++;
          const dt = ts - lastTs;
          if (dt >= 1000) {
            buckets.push(frames);
            console.log('[PERF-DIAG] FPS idle bucket #' + buckets.length + ' = ' + frames);
            frames = 0;
            lastTs = ts;
            if (buckets.length >= 5) {
              const avg = buckets.reduce((a,b)=>a+b,0) / buckets.length;
              console.log('[PERF-DIAG] FPS idle avg over 5s = ' + avg.toFixed(1));
              return;
            }
          }
          requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      })();
    `).catch(() => {});
  });

  mainWindow.webContents.on('console-message', (event, level, message) => {
    if (message === 'TITANIO_SILENT_PRINT') {
      silentPrint();
    }
    // Forward diagnostic logs to main-process stdout so the user sees them
    // in the `npm start` terminal without needing DevTools open.
    if (typeof message === 'string' && message.startsWith('[PERF-DIAG]')) {
      console.log(message);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC: versiones (app y runtime)
ipcMain.handle('app-versions', () => ({
  app: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
}));

// IPC: (re)crear el acceso directo de la app en el Escritorio. Útil si el
// usuario lo borró por error. Usa el exe real de la app (no electron.exe en dev).
ipcMain.handle('app:create-desktop-shortcut', () => {
  try {
    const desktop = app.getPath('desktop');
    const exePath = process.execPath;
    const shortcutPath = path.join(desktop, 'TitanioPOS.lnk');
    const ok = shell.writeShortcutLink(shortcutPath, 'replace', {
      target: exePath,
      icon: exePath,
      iconIndex: 0,
      description: 'TitanioPOS',
      appUserModelId: 'com.titaniopos.desktop',
    });
    return { success: ok, path: shortcutPath };
  } catch (error) {
    console.error('[SHORTCUT] No se pudo crear el acceso directo:', error.message);
    return { success: false, error: error.message };
  }
});

// IPC: estado de GPU para diagnóstico de perf. Resultado equivalente a
// chrome://gpu/ pero usable desde DevTools del renderer (donde chrome://gpu
// está bloqueado por seguridad). Llamar como:
//   await window.electronAPI.gpuStatus()  (si está expuesto en preload)
//   o directamente via require('electron').ipcRenderer.invoke('gpu-status')
ipcMain.handle('gpu-status', async () => {
  try {
    const features = app.getGPUFeatureStatus();
    // `complete` da MUCHO más detalle que `basic`. Si `basic` siempre devolvía
    // gl=none, puede ser que estuviéramos viendo un snapshot temprano. Con
    // `complete` Chromium fuerza GPU init si no terminó de arrancar.
    let info;
    let infoError = null;
    try {
      info = await app.getGPUInfo('complete');
    } catch (err) {
      infoError = err.message;
      info = await app.getGPUInfo('basic');
    }
    // Diagnóstico extra: switches en command-line y argv del proceso.
    // Si hay un `--disable-gpu` o `--in-process-gpu` que no controlamos
    // explícitamente, aparece acá.
    const knownGpuSwitches = [
      'disable-gpu', 'disable-gpu-compositing', 'disable-gpu-rasterization',
      'disable-gpu-sandbox', 'disable-software-rasterizer', 'in-process-gpu',
      'single-process', 'no-sandbox', 'use-gl', 'use-angle', 'use-cmd-decoder',
      'enable-gpu-rasterization', 'enable-zero-copy', 'disable-gpu-driver-bug-workarounds',
      'num-raster-threads', 'enable-features', 'disable-features',
    ];
    const cmdLineSwitches = {};
    for (const sw of knownGpuSwitches) {
      const has = app.commandLine.hasSwitch(sw);
      if (has) {
        cmdLineSwitches[sw] = app.commandLine.getSwitchValue(sw) || '(no-value)';
      }
    }
    return {
      success: true,
      infoError,
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      },
      // process.argv contiene TODOS los args con los que arrancó Electron.
      // Si hay un `--disable-gpu` u otro flag que no controlamos, aparece acá.
      argv: process.argv,
      cmdLineSwitches,
      features,
      gpu: info,
      criticalFlags: {
        '2d_canvas': features['2d_canvas'],
        gpu_compositing: features.gpu_compositing,
        opengl: features.opengl,
        rasterization: features.rasterization,
        skia_graphite: features.skia_graphite,
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('reload-ignoring-cache', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.reloadIgnoringCache();
  }
});

// Auto-actualización: descarga e instalación solo con confirmación (o al cerrar la app)
// Debe coincidir con build.publish en package.json (solo para mensajes de error)
const UPDATER_GITHUB_REPO = 'ospinosystems/electron-wrapper-titaniopos';

let updateCheckRequestedByUser = false;

function formatUpdaterErrorForUser(err) {
  const raw = err && err.message ? String(err.message) : String(err);
  console.error('[UPDATER] Detalle técnico:', err);
  if (/404|Not Found|releases\.atom|HtmlError/i.test(raw)) {
    return [
      'GitHub respondió “no encontrado” (404) al leer la lista de versiones.',
      '',
      'Causas habituales:',
      '• El repositorio es privado. La app instalada no envía token; los releases tienen que ser accesibles sin login (repo público o releases en un repo público).',
      '• Aún no hay ningún release publicado en GitHub.',
      '• El nombre del repo en package.json no coincide con el real.',
      '',
      `Repo configurado: ${UPDATER_GITHUB_REPO}`,
    ].join('\n');
  }
  return raw.length > 800 ? `${raw.slice(0, 800)}…` : raw;
}

function checkForUpdatesManual() {
  if (!app.isPackaged) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Actualizaciones',
      message: 'Las actualizaciones solo aplican a la aplicación instalada (no en modo desarrollo).',
    });
    return;
  }
  updateCheckRequestedByUser = true;
  autoUpdater.checkForUpdates().catch((err) => {
    updateCheckRequestedByUser = false;
    dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Error al buscar actualizaciones',
      message: formatUpdaterErrorForUser(err),
    });
  });
}

function buildApplicationMenu() {
  const isMac = process.platform === 'darwin';

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }],
    },
    { role: 'editMenu' },
    {
      label: 'Ver',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: 'Consola de desarrollo…',
          accelerator: process.platform === 'darwin' ? 'Cmd+Alt+I' : 'Ctrl+Shift+I',
          click: () => openDevToolsWithPasswordDialog(mainWindow),
        },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        ...(isMac
          ? [
              { role: 'zoom' },
              { type: 'separator' },
              { role: 'front' },
              { type: 'separator' },
              { role: 'window' },
            ]
          : [{ role: 'close' }]),
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Buscar actualizaciones…',
          enabled: app.isPackaged,
          click: () => checkForUpdatesManual(),
        },
        { type: 'separator' },
        {
          label: `Versión ${app.getVersion()}`,
          enabled: false,
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Estado del título original de la ventana para restaurarlo cuando termina la descarga.
let updaterOriginalTitle = null;
let updaterDownloading = false;

// Estado actual del updater — se actualiza en cada evento y se sirve al renderer
// vía IPC para que el banner pueda reconstruirse después de un reload del frontend.
// phase: 'idle' | 'checking' | 'downloading' | 'done' | 'error'
let updaterState = { phase: 'idle' };

// Intervalo de re-chequeo automático. POS abiertos 8+ horas no se enteraban de
// updates publicadas durante el día porque solo había un check al arranque.
const UPDATER_PERIODIC_CHECK_MS = 2 * 60 * 60 * 1000; // 2 horas
let updaterPeriodicTimer = null;

function getUpdaterWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function sendUpdaterEvent(type, payload = {}) {
  const win = getUpdaterWindow();
  if (!win) return;
  try {
    win.webContents.send('updater:event', { type, ...payload });
  } catch (err) {
    // Renderer puede no estar listo todavía durante el arranque — ok.
  }
}

/**
 * Actualiza el estado central y notifica al renderer. La fase es la fuente de
 * verdad — el banner del frontend lee este estado al montar (tras un reload F5)
 * para reconstruirse, y también recibe el evento push para updates en vivo.
 */
function updateUpdaterState(patch) {
  updaterState = { ...updaterState, ...patch };
}

function setUpdaterProgressUI(percent) {
  const win = getUpdaterWindow();
  if (!win) return;
  if (updaterOriginalTitle === null) {
    try { updaterOriginalTitle = win.getTitle(); } catch { updaterOriginalTitle = ''; }
  }
  // setProgressBar admite 0..1 (porcentaje), 2 (indeterminado), -1 (limpiar).
  if (percent === 'indeterminate') {
    try { win.setProgressBar(2); } catch { /* taskbar progress puede no estar soportado */ }
    try { win.setTitle(`Descargando actualización… — ${updaterOriginalTitle || 'TitanioPOS'}`); } catch { /* ignore */ }
  } else if (typeof percent === 'number') {
    const clamped = Math.max(0, Math.min(1, percent / 100));
    try { win.setProgressBar(clamped); } catch { /* ignore */ }
    try { win.setTitle(`Descargando actualización ${Math.round(percent)}% — ${updaterOriginalTitle || 'TitanioPOS'}`); } catch { /* ignore */ }
  }
}

function clearUpdaterProgressUI() {
  const win = getUpdaterWindow();
  if (!win) {
    updaterOriginalTitle = null;
    updaterDownloading = false;
    return;
  }
  try { win.setProgressBar(-1); } catch { /* ignore */ }
  if (updaterOriginalTitle !== null) {
    try { win.setTitle(updaterOriginalTitle); } catch { /* ignore */ }
    updaterOriginalTitle = null;
  }
  updaterDownloading = false;
}

function notifyUpdaterStart() {
  try {
    if (Notification.isSupported()) {
      new Notification({
        title: 'Actualizando TitanioPOS',
        body: 'La nueva versión se está descargando en segundo plano. Te avisaremos cuando esté lista.',
        silent: false,
      }).show();
    }
  } catch (err) {
    console.warn('[UPDATER] No se pudo mostrar notificación:', err.message);
  }
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    console.log('[UPDATER] Buscando actualizaciones...');
    // Solo notificamos al banner si el check fue manual — los checks automáticos
    // de fondo (arranque + cada 2h) no deben distraer al cajero con un banner
    // si al final no hay nada nuevo.
    if (updateCheckRequestedByUser) {
      updateUpdaterState({ phase: 'checking' });
      sendUpdaterEvent('checking');
    }
  });

  autoUpdater.on('update-available', async (info) => {
    console.log('[UPDATER] Actualización disponible:', info.version);
    const win = getUpdaterWindow();
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Actualización disponible',
      message: `Hay una nueva versión: ${info.version}.`,
      detail:
        '¿Descargar ahora? Puedes posponerlo; también desde el menú Help → Buscar actualizaciones… (Alt para ver la barra de menús).',
      buttons: ['Descargar', 'Ahora no'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      // Feedback inmediato: el primer evento download-progress puede tardar varios
      // segundos (handshake/redirect), así que arrancamos con barra indeterminada
      // y notificación para que el cajero sepa que SÍ está pasando algo.
      updaterDownloading = true;
      setUpdaterProgressUI('indeterminate');
      notifyUpdaterStart();
      updateUpdaterState({
        phase: 'downloading',
        version: info.version,
        percent: 0,
        bytesPerSecond: 0,
        transferred: 0,
        total: 0,
        error: undefined,
      });
      sendUpdaterEvent('start', { version: info.version });
      try {
        await autoUpdater.downloadUpdate();
      } catch (err) {
        console.error('[UPDATER] Error descargando actualización:', err);
        clearUpdaterProgressUI();
        const message = formatUpdaterErrorForUser(err);
        updateUpdaterState({ phase: 'error', error: message });
        sendUpdaterEvent('error', { message });
        dialog.showMessageBox(win, {
          type: 'error',
          title: 'Descarga fallida',
          message,
        });
      }
    } else {
      updateUpdaterState({ phase: 'idle' });
      sendUpdaterEvent('cancelled');
    }
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[UPDATER] No hay actualizaciones disponibles.');
    const wasManual = updateCheckRequestedByUser;
    if (wasManual) {
      updateCheckRequestedByUser = false;
      // Cierra el banner "Verificando…" que abrimos al iniciar el check manual.
      updateUpdaterState({ phase: 'idle' });
      sendUpdaterEvent('not-available');
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      dialog.showMessageBox(win, {
        type: 'info',
        title: 'Actualizaciones',
        message: 'Ya tienes la última versión.',
      });
    }
  });

  autoUpdater.on('error', (err) => {
    console.error('[UPDATER] Error:', err);
    const message = formatUpdaterErrorForUser(err);
    // Si estábamos descargando, limpiar el indicador de progreso del taskbar y título.
    if (updaterDownloading) {
      clearUpdaterProgressUI();
      updateUpdaterState({ phase: 'error', error: message });
      sendUpdaterEvent('error', { message });
    } else if (updaterState.phase === 'checking') {
      // Error durante un check manual — cerrar el banner "Verificando…".
      updateUpdaterState({ phase: 'idle' });
      sendUpdaterEvent('cancelled');
    }
    if (updateCheckRequestedByUser) {
      updateCheckRequestedByUser = false;
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      dialog.showMessageBox(win, {
        type: 'error',
        title: 'Error al buscar actualizaciones',
        message: formatUpdaterErrorForUser(err),
      });
    }
  });

  autoUpdater.on('download-progress', (progressObj) => {
    const percent = progressObj.percent || 0;
    const kbps = Math.round((progressObj.bytesPerSecond || 0) / 1024);
    console.log(`[UPDATER] Descargando: ${Math.round(percent)}% (vel: ${kbps} KB/s)`);
    setUpdaterProgressUI(percent);
    const payload = {
      percent,
      bytesPerSecond: progressObj.bytesPerSecond || 0,
      transferred: progressObj.transferred || 0,
      total: progressObj.total || 0,
    };
    updateUpdaterState({ phase: 'downloading', ...payload });
    sendUpdaterEvent('progress', payload);
  });

  autoUpdater.on('update-downloaded', async (info) => {
    console.log('[UPDATER] Actualización descargada.');
    clearUpdaterProgressUI();
    updateUpdaterState({
      phase: 'done',
      version: info?.version || updaterState.version,
      percent: 100,
    });
    sendUpdaterEvent('done', { version: info?.version });
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Actualización lista',
      message: 'La actualización se descargó correctamente.',
      detail:
        '¿Reiniciar ahora para instalar? Si eliges "Después", se instalará al cerrar TitanioPOS.',
      buttons: ['Reiniciar ahora', 'Después'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      autoUpdater.quitAndInstall(false, true);
    }
  });

  autoUpdater.checkForUpdates().catch((err) => {
    console.warn('[UPDATER] No se pudo comprobar actualizaciones al iniciar:', err.message);
  });

  // Re-chequeo cada 2 horas: POS abiertos toda la jornada no se enteraban de
  // releases publicados durante el día. Salteamos si ya hay una descarga en curso.
  if (updaterPeriodicTimer) clearInterval(updaterPeriodicTimer);
  updaterPeriodicTimer = setInterval(() => {
    if (updaterDownloading || updaterState.phase === 'done') return;
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn('[UPDATER] Re-chequeo periódico falló:', err.message);
    });
  }, UPDATER_PERIODIC_CHECK_MS);

  // Permite al renderer disparar el reinicio + instalación desde el banner UI.
  ipcMain.handle('updater:quit-and-install', () => {
    try {
      autoUpdater.quitAndInstall(false, true);
      return { success: true };
    } catch (err) {
      console.error('[UPDATER] quitAndInstall failed:', err);
      return { success: false, error: String(err?.message || err) };
    }
  });

  // Permite al banner reconstruirse después de un F5/reload del renderer.
  // El main mantiene la sesión completa de descarga aunque el renderer reset.
  ipcMain.handle('updater:get-state', () => updaterState);
}

// Impresión silenciosa
function silentPrint() {
  if (!mainWindow) return;

  mainWindow.webContents.print({
    silent: true,
    printBackground: true,
    margins: {
      marginType: 'none'
    }
  }, (success, failureReason) => {
    if (!success) {
      console.error('Print failed:', failureReason);
    } else {
      console.log('Print successful');
    }
  });
}

// Función para imprimir HTML en ventana oculta (método nativo simplificado)
function printHtmlInHiddenWindow(html, printerName = null, pageWidth = '80mm', options = {}) {
  return new Promise(async (resolve, reject) => {
    const debugPdf = options.debugPdf === true;
    const printWindow = new BrowserWindow({
      show: false,
      width: pageWidth === '58mm' ? 220 : 302,
      height: 800,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    const thermalCSS = `
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body {
          width: ${pageWidth};
          font-family: 'Courier New', monospace;
          font-size: 12px;
          line-height: 1.2;
          color: #000 !important;
          background: #fff !important;
        }
        .line { white-space: pre; line-height: 1.4; }
        .total {
          font-weight: bold;
          font-size: 14px;
          border-top: 1px dashed #000;
          padding-top: 4px;
          margin-top: 4px;
        }
        .uuid {
          font-size: 8px;
          text-align: center;
          margin-top: 8px;
          word-break: break-all;
        }
        @media print {
          @page { margin: 0; }
          * {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
            color: #000 !important;
          }
        }
      </style>
    `;

    const fullHtml = html.includes('<html')
      ? html
      : `<!DOCTYPE html><html><head><meta charset="UTF-8">${thermalCSS}</head><body>${html}</body></html>`;

    printWindow.webContents.on('did-finish-load', async () => {
      console.log('🖨️ [MAIN] Contenido cargado');

      try {
        // Wait for DOM ready instead of fixed 800ms delay
        await printWindow.webContents.executeJavaScript('document.readyState');
        await new Promise(r => setTimeout(r, 200));

        let targetPrinter = printerName;
        if (!targetPrinter) {
          const printers = await printWindow.webContents.getPrintersAsync();
          const defaultPrinter = printers.find(p => p.isDefault);
          targetPrinter = defaultPrinter?.name;
        }
        console.log('🖨️ [MAIN] Impresora:', targetPrinter);

        const backupDir = getBackupDir();
        let pdfPath = null;

        if (debugPdf) {
          // Generate PDF only when explicitly debugging
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          pdfPath = path.join(backupDir, `print_${stamp}.pdf`);

          const pdfBuffer = await printWindow.webContents.printToPDF({
            printBackground: true,
            marginsType: 1,
            pageSize: { width: pageWidth === '58mm' ? 58000 : 80000, height: 297000 }
          });

          fs.writeFileSync(pdfPath, pdfBuffer);
          console.log('📄 [MAIN] Debug PDF generado:', pdfPath);
        }

        // If not debugging PDF, print directly via Electron's native API (faster)
        if (!debugPdf) {
          const printOptions = {
            silent: true,
            deviceName: targetPrinter,
            printBackground: true,
            color: false,
            margins: { marginType: 'none' },
            pageSize: {
              width: pageWidth === '58mm' ? 58000 : 80000,
              height: 297000
            }
          };
          return printWindow.webContents.print(printOptions, (success, failureReason) => {
            console.log(success ? '✅ [MAIN] Print sent' : `❌ [MAIN] Failed: ${failureReason}`);
            closeAndGcPrintWindow(printWindow);
            resolve({ success, printerName: targetPrinter, error: success ? undefined : failureReason });
          });
        }

        closeAndGcPrintWindow(printWindow);

        // Legacy PDF-based printing for debug mode only
        const { exec } = require('child_process');
        const escapedPath = pdfPath.replace(/\\/g, '\\\\').replace(/"/g, '`"');
        const escapedPrinter = targetPrinter.replace(/"/g, '`"');

        const psScript = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms

  try {
    $acrobat = New-Object -ComObject AcroExch.PDDoc
    if ($acrobat.Open("${escapedPath}")) {
      $acrobat.PrintPages(0, $acrobat.GetNumPages() - 1, 2, 1, 0)
      Start-Sleep -Milliseconds 500
      $acrobat.Close()
      [System.Runtime.Interopservices.Marshal]::ReleaseComObject($acrobat) | Out-Null
      Write-Output "Impreso con Adobe"
      exit 0
    }
  } catch {
    Write-Output "Adobe no disponible: $_"
  }

  $shell = New-Object -ComObject Shell.Application
  $folder = $shell.NameSpace((Split-Path "${escapedPath}"))
  $file = $folder.ParseName((Split-Path "${escapedPath}" -Leaf))
  $file.InvokeVerb("print")
  Start-Sleep -Milliseconds 500
  Write-Output "Impreso con Shell"
  exit 0
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
`.trim();

        const printCommand = `powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript.replace(/"/g, '\\"')}"`;
        console.log('🖨️ [MAIN] Ejecutando impresión con PowerShell (debug PDF)');

        exec(printCommand, { timeout: 30000 }, (error, stdout, stderr) => {
          if (error) {
            console.error('❌ [MAIN] Error:', error.message);
            if (stderr) console.error('stderr:', stderr);
            resolve({ success: false, error: error.message, pdfPath });
          } else {
            console.log('✅ [MAIN] Impresión ejecutada');
            if (stdout) console.log('stdout:', stdout.trim());
            resolve({ success: true, printerName: targetPrinter, pdfPath });
          }

          setTimeout(() => {
            try {
              if (fs.existsSync(pdfPath)) {
                fs.unlinkSync(pdfPath);
                console.log('🗑️ [MAIN] PDF eliminado');
              }
            } catch (e) {
              console.warn('⚠️ [MAIN] No se pudo eliminar PDF:', e?.message);
            }
          }, 10000);
        });
      } catch (error) {
        closeAndGcPrintWindow(printWindow);
        reject(error);
      }
    });

    printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fullHtml)}`);
  });
}

// IPC handler para impresión silenciosa con HTML
ipcMain.handle('silent-print', async (event, htmlContent, options = {}) => {
  console.log('🖨️ [MAIN] silent-print recibido');

  if (!htmlContent) {
    console.error('❌ [MAIN] HTML content vacío');
    return { success: false, error: 'HTML content vacío' };
  }

  try {
    const pageWidth = options.pageWidth || '80mm';
    const printerName = options.printerName || null;

    const result = await printHtmlInHiddenWindow(htmlContent, printerName, pageWidth, options);
    return result;
  } catch (error) {
    console.error('❌ [MAIN] Error completo:', error);
    return { success: false, error: error?.message || String(error) };
  }
});

// IPC handler para obtener lista de impresoras
ipcMain.handle('get-printers', async () => {
  const printers = await mainWindow.webContents.getPrintersAsync();
  return printers;
});

// IPC handler para imprimir a impresora específica con HTML
ipcMain.handle('print-to-printer', async (event, printerName, htmlContent, options = {}) => {
  console.log('🖨️ [MAIN] print-to-printer:', printerName);

  if (!htmlContent) {
    return { success: false, error: 'HTML content vacío' };
  }

  try {
    const pageWidth = options.pageWidth || '80mm';
    const result = await printHtmlInHiddenWindow(htmlContent, printerName, pageWidth, options);
    return result;
  } catch (error) {
    console.error('❌ [MAIN] Error:', error);
    return { success: false, error: error?.message || String(error) };
  }
});

// ==================== BACKUP DE ÓRDENES ====================

// Guardar una orden en backup (escritura asíncrona, sin pretty-print)
ipcMain.handle('backup-save-order', async (event, order) => {
  try {
    const backupDir = getBackupDir();
    const fileName = `order_${order.id || Date.now()}.json`;
    const filePath = path.join(backupDir, fileName);

    await fs.promises.writeFile(filePath, JSON.stringify(order), 'utf-8');
    console.log('💾 [BACKUP] Orden guardada:', fileName);

    return { success: true, path: filePath };
  } catch (error) {
    console.error('❌ [BACKUP] Error guardando orden:', error);
    return { success: false, error: error.message };
  }
});

// Helper para obtener fecha en formato YYYY-MM-DD
const getDateString = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const BACKUP_YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BACKUP_RANGE_DAYS = 62;

const parseLocalYmd = (ymd) => {
  if (!BACKUP_YMD_RE.test(ymd)) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const formatLocalYmd = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/** Fechas locales YYYY-MM-DD inclusivas; si from/to son inválidos, solo hoy. */
const enumerateInclusiveBackupDates = (fromStr, toStr) => {
  const from = parseLocalYmd(fromStr);
  const to = parseLocalYmd(toStr);
  if (!from || !to) {
    return [getDateString()];
  }
  const start = from <= to ? from : to;
  const end = from <= to ? to : from;
  const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  const dayCount =
    Math.round((endDay.getTime() - startDay.getTime()) / 86400000) + 1;
  if (dayCount > MAX_BACKUP_RANGE_DAYS) {
    throw new Error(
      `Rango de respaldo demasiado amplio (${dayCount} días, máximo ${MAX_BACKUP_RANGE_DAYS})`,
    );
  }
  const out = [];
  const cursor = new Date(startDay);
  while (cursor <= endDay) {
    out.push(formatLocalYmd(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
};

const normalizeBackupData = (raw, fallbackDate = getDateString()) => {
  if (!raw || typeof raw !== 'object') {
    return {
      lastSync: null,
      date: fallbackDate,
      count: 0,
      orders: [],
    };
  }

  const orders = Array.isArray(raw.orders) ? raw.orders : [];
  const rawDate = typeof raw.date === 'string' && BACKUP_YMD_RE.test(raw.date) ? raw.date : fallbackDate;
  const rawLastSync = typeof raw.lastSync === 'string' ? raw.lastSync : new Date().toISOString();

  return {
    lastSync: rawLastSync,
    date: rawDate,
    count: orders.length,
    orders,
  };
};

// Escribe el backup en formato firmado v2: { version, data, signature }.
// `data` es JSON plano y legible. `signature` es HMAC-SHA256 de JSON.stringify(data).
//
// Versión SINCRÓNICA — solo se usa en operaciones críticas de admin (re-firma) y
// migración legacy (JWT → v2) durante la lectura. El path de "guardado normal"
// (cada vez que cambia el store) ya no la usa: ver `writeBackupFileAtomicAsync`.
const writeBackupFileAtomic = (filePath, backupData, useJwt = BACKUP_WRITE_JWT) => {
  const normalized = normalizeBackupData(backupData);
  let payload;
  if (useJwt) {
    // Legado: si alguien activa BACKUP_WRITE_JWT, respetamos el formato viejo.
    payload = { token: encodeToJWT(normalized) };
  } else {
    payload = {
      version: BACKUP_FORMAT_VERSION,
      data: normalized,
      signature: computeBackupSignature(normalized),
    };
  }
  const tmpPath = `${filePath}.tmp`;
  // Sin pretty-print: en escrituras frecuentes, indentar duplica el tamaño y
  // ralentiza I/O. Los inspect tools admin parsean JSON normal — no necesitan
  // espacios. Para inspección humana, abrir en un editor que reformatee.
  fs.writeFileSync(tmpPath, JSON.stringify(payload), 'utf-8');
  fs.renameSync(tmpPath, filePath);
};

// Versión ASÍNCRONA del writer atómico — para el path caliente de "guardar el
// store completo". No bloquea el event loop de Electron, lo cual es crítico en
// Celeron con HDD donde `writeFileSync` de 500KB-1MB puede tomar 100-300ms y
// congelar el printer, fiscal handlers e IPC durante ese tiempo.
//
// Mantiene la misma semántica de atomicidad: escribe a `.tmp`, luego rename
// atómico al destino. Si algo falla antes del rename, el archivo destino queda
// intacto (no medio escrito).
const writeBackupFileAtomicAsync = async (filePath, backupData, useJwt = BACKUP_WRITE_JWT) => {
  const normalized = normalizeBackupData(backupData);
  let payload;
  if (useJwt) {
    payload = { token: encodeToJWT(normalized) };
  } else {
    payload = {
      version: BACKUP_FORMAT_VERSION,
      data: normalized,
      signature: computeBackupSignature(normalized),
    };
  }
  const tmpPath = `${filePath}.tmp`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(payload), 'utf-8');
  await fs.promises.rename(tmpPath, filePath);
};

// Lee y normaliza un backup, aceptando tres formatos:
//   v2 firmado:  { version: 2, data, signature }     → verifica HMAC, falla si fue manipulado
//   legado JWT:  { token: "..." }                    → decodifica, migra a v2 si corresponde
//   legado v1:   { lastSync, date, orders, ... }     → sin firma, lo aceptamos y migramos a v2
const readBackupFileNormalized = (backupPath, opts = {}) => {
  const { migrateJwtToPlain = !BACKUP_WRITE_JWT, allowUnsigned = true } = opts;
  const fileContent = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));

  // v2 firmado
  if (
    fileContent &&
    typeof fileContent === 'object' &&
    typeof fileContent.signature === 'string' &&
    fileContent.data &&
    typeof fileContent.data === 'object'
  ) {
    const normalized = normalizeBackupData(fileContent.data);
    if (!verifyBackupSignature(fileContent.data, fileContent.signature)) {
      const err = new Error('Firma de backup inválida (archivo manipulado)');
      err.code = 'BACKUP_SIGNATURE_INVALID';
      throw err;
    }
    return normalized;
  }

  // Legado JWT
  if (fileContent && typeof fileContent === 'object' && fileContent.token) {
    const decoded = decodeBackupTokenSafely(fileContent.token);
    if (!decoded) {
      const err = new Error('Token sin formato soportado');
      err.code = 'BACKUP_TOKEN_UNSUPPORTED';
      throw err;
    }
    const normalized = normalizeBackupData(decoded);
    if (migrateJwtToPlain) {
      try {
        writeBackupFileAtomic(backupPath, normalized, false);
        console.log(`♻️ [BACKUP] Migrado JWT → firmado v2: ${path.basename(backupPath)}`);
      } catch (migrationError) {
        console.warn('⚠️ [BACKUP] No se pudo migrar archivo JWT a v2:', migrationError.message);
      }
    }
    return normalized;
  }

  // Legado v1 (JSON plano sin firma). Lo aceptamos solo si `allowUnsigned` y migramos a v2.
  if (allowUnsigned) {
    const normalized = normalizeBackupData(fileContent);
    try {
      writeBackupFileAtomic(backupPath, normalized, false);
      console.log(`♻️ [BACKUP] Migrado v1 sin firma → firmado v2: ${path.basename(backupPath)}`);
    } catch (migrationError) {
      console.warn('⚠️ [BACKUP] No se pudo migrar v1 a v2:', migrationError.message);
    }
    return normalized;
  }

  const err = new Error('Backup sin firma rechazado');
  err.code = 'BACKUP_UNSIGNED';
  throw err;
};

const mergeOrdersIntoMap = (map, orders) => {
  if (!Array.isArray(orders)) return;
  for (const order of orders) {
    if (order == null || order.id == null) continue;
    const id = String(order.id);
    const prev = map.get(id);
    if (!prev) {
      map.set(id, order);
      continue;
    }
    const tNew = new Date(order.updated_at || order.created_at || 0).getTime();
    const tOld = new Date(prev.updated_at || prev.created_at || 0).getTime();
    if (tNew >= tOld) map.set(id, order);
  }
};

// Guardar múltiples órdenes - backup diario (plano por defecto, JWT opcional por flag).
//
// Escritura ASÍNCRONA: no bloquea el event loop. El renderer mantiene el debounce
// + hash-skip (ver use-checkout-orders backup subscription) para evitar rewrites
// innecesarios. Acá nos limitamos a serializar+firmar+escribir lo más rápido posible.
ipcMain.handle('backup-save-all-orders', async (event, orders) => {
  try {
    const backupDir = getBackupDir();
    const dateStr = getDateString();

    const dailyBackupPath = path.join(backupDir, `backup_${dateStr}.json`);

    const backupData = normalizeBackupData({
      lastSync: new Date().toISOString(),
      date: dateStr,
      count: Array.isArray(orders) ? orders.length : 0,
      orders: Array.isArray(orders) ? orders : [],
    }, dateStr);

    await writeBackupFileAtomicAsync(dailyBackupPath, backupData, BACKUP_WRITE_JWT);

    const modeLabel = BACKUP_WRITE_JWT ? 'JWT' : 'PLANO';
    console.log(`💾 [BACKUP] ${backupData.count} órdenes guardadas (${modeLabel}) en backup_${dateStr}.json`);
    return { success: true, count: backupData.count, date: dateStr };
  } catch (error) {
    console.error('❌ [BACKUP] Error en sync:', error);
    return { success: false, error: error.message };
  }
});

// Obtener órdenes del backup: día actual, o rango { from, to } YYYY-MM-DD (p. ej. cierre de jornada de ayer)
ipcMain.handle('backup-get-all-orders', async (event, range) => {
  try {
    const backupDir = getBackupDir();
    let dates;
    if (
      range &&
      typeof range === 'object' &&
      BACKUP_YMD_RE.test(range.from) &&
      BACKUP_YMD_RE.test(range.to)
    ) {
      dates = enumerateInclusiveBackupDates(range.from, range.to);
    } else {
      dates = [getDateString()];
    }

    const merged = new Map();
    let lastSyncBest = null;
    let filesRead = 0;

    for (const dateStr of dates) {
      const backupPath = path.join(backupDir, `backup_${dateStr}.json`);
      if (!fs.existsSync(backupPath)) continue;
      filesRead += 1;
      let data;
      try {
        data = readBackupFileNormalized(backupPath, { migrateJwtToPlain: !BACKUP_WRITE_JWT });
      } catch (readError) {
        const code = readError?.code;
        let errorCode;
        let errorMessage;
        if (code === 'BACKUP_SIGNATURE_INVALID') {
          errorCode = 'BACKUP_SIGNATURE_INVALID';
          errorMessage = 'Firma de backup inválida (archivo manipulado)';
        } else if (code === 'BACKUP_TOKEN_UNSUPPORTED') {
          errorCode = 'BACKUP_TOKEN_UNSUPPORTED';
          errorMessage = 'Token sin formato soportado';
        } else if (code === 'BACKUP_UNSIGNED') {
          errorCode = 'BACKUP_UNSIGNED';
          errorMessage = 'Backup sin firma rechazado';
        } else {
          errorCode = 'JWT_INVALID_SIGNATURE';
          errorMessage = 'Token JWT inválido o manipulado';
        }
        console.error('❌ [BACKUP] Error leyendo backup:', readError);
        return {
          success: false,
          error: errorMessage,
          errorCode,
          orders: [],
        };
      }
      mergeOrdersIntoMap(merged, data.orders);
      const ls = data.lastSync;
      if (ls && (!lastSyncBest || ls > lastSyncBest)) lastSyncBest = ls;
    }

    const orders = Array.from(merged.values());
    const dateLabel =
      dates.length === 1 ? dates[0] : `${dates[0]}:${dates[dates.length - 1]}`;

    if (filesRead === 0) {
      console.log(
        `📂 [BACKUP] Sin archivos en rango ${dateLabel} (${dates.length} día(s) comprobados)`,
      );
    } else {
      console.log(
        `📂 [BACKUP] ${orders.length} órdenes únicas tras fusionar ${filesRead} archivo(s) (${dateLabel})`,
      );
    }

    return {
      success: true,
      orders,
      lastSync: lastSyncBest,
      count: orders.length,
      date: dateLabel,
    };
  } catch (error) {
    console.error('❌ [BACKUP] Error leyendo backup:', error);
    return { success: false, error: error.message, orders: [] };
  }
});

// Obtener ruta del directorio de backups
ipcMain.handle('backup-get-path', async () => {
  return { path: getBackupDir() };
});

// Eliminar una orden del backup del día actual
ipcMain.handle('backup-delete-order', async (event, orderId) => {
  try {
    const backupDir = getBackupDir();
    const dateStr = getDateString();
    const todayBackupPath = path.join(backupDir, `backup_${dateStr}.json`);

    if (fs.existsSync(todayBackupPath)) {
      const data = readBackupFileNormalized(todayBackupPath, { migrateJwtToPlain: !BACKUP_WRITE_JWT });
      data.orders = data.orders.filter((o) => String(o.id) !== String(orderId));
      data.count = data.orders.length;
      data.lastSync = new Date().toISOString();
      await writeBackupFileAtomicAsync(todayBackupPath, data, BACKUP_WRITE_JWT);
    }

    // También eliminar archivo individual si existe
    const individualPath = path.join(backupDir, `order_${orderId}.json`);
    if (fs.existsSync(individualPath)) {
      await fs.promises.unlink(individualPath);
    }

    console.log('🗑️ [BACKUP] Orden eliminada:', orderId);
    return { success: true };
  } catch (error) {
    console.error('❌ [BACKUP] Error eliminando:', error);
    return { success: false, error: error.message };
  }
});

// ==================== ADMIN: INSPECCIÓN / RE-FIRMA DE BACKUPS ====================
// Estos handlers están pensados para una ventana admin oculta en la app: permiten listar
// archivos del directorio de backup, leer uno sin verificar firma (para inspeccionarlo aunque
// esté corrupto), reportar si la firma es válida, y re-firmar un payload editado manualmente.

// Gate de contraseña para los handlers admin.
//
// Antes: una vez desbloqueado, el flag duraba toda la vida del proceso → entrar
// una vez en el día dejaba el inspector accesible hasta que se cerrara la app.
// Ahora: idle-timeout. Cada operación admin extiende la sesión 5 minutos. Si
// pasan 5 min sin actividad, vuelve a pedir contraseña.
const INSPECTOR_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos
let inspectorUnlockedUntil = 0; // epoch ms; 0 = bloqueado

const getInspectorPassword = () => {
  const dedicated = (process.env.TITANIOPOS_INSPECTOR_PASSWORD || '').trim();
  if (dedicated) return dedicated;
  // Fallback: reutiliza la contraseña de DevTools si no se definió una dedicada.
  return (process.env.TITANIOPOS_DEVTOOLS_PASSWORD || '').trim();
};

const isInspectorUnlocked = () => Date.now() < inspectorUnlockedUntil;

const touchInspectorSession = () => {
  if (isInspectorUnlocked()) {
    inspectorUnlockedUntil = Date.now() + INSPECTOR_IDLE_TIMEOUT_MS;
  }
};

ipcMain.handle('backup-admin-unlock', async (event, password) => {
  const expected = getInspectorPassword();
  if (!expected) {
    return {
      success: false,
      error:
        'No hay contraseña configurada. Añade TITANIOPOS_INSPECTOR_PASSWORD al .env de la app.',
    };
  }
  if (typeof password !== 'string' || !password) {
    return { success: false, error: 'Contraseña requerida' };
  }
  const a = Buffer.from(password);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return { success: false, error: 'Contraseña incorrecta' };
  inspectorUnlockedUntil = Date.now() + INSPECTOR_IDLE_TIMEOUT_MS;
  return { success: true, idleTimeoutMs: INSPECTOR_IDLE_TIMEOUT_MS };
});

ipcMain.handle('backup-admin-lock', async () => {
  inspectorUnlockedUntil = 0;
  return { success: true };
});

ipcMain.handle('backup-admin-status', async () => {
  return {
    unlocked: isInspectorUnlocked(),
    configured: Boolean(getInspectorPassword()),
    idleTimeoutMs: INSPECTOR_IDLE_TIMEOUT_MS,
    expiresAt: isInspectorUnlocked() ? inspectorUnlockedUntil : null,
  };
});

// Extiende la sesión cuando el renderer reporta actividad (mouse/teclado).
// Evita que se bloquee mientras el usuario está mirando o editando.
ipcMain.handle('backup-admin-touch', async () => {
  if (!isInspectorUnlocked()) return { unlocked: false };
  touchInspectorSession();
  return { unlocked: true, expiresAt: inspectorUnlockedUntil };
});

const requireInspectorUnlocked = () => {
  if (!isInspectorUnlocked()) {
    return { success: false, error: 'Inspector bloqueado', code: 'LOCKED' };
  }
  // Cualquier operación válida extiende la sesión — actividad real.
  touchInspectorSession();
  return null;
};

ipcMain.handle('backup-admin-list-files', async () => {
  const locked = requireInspectorUnlocked();
  if (locked) return { ...locked, files: [] };
  try {
    const backupDir = getBackupDir();
    const entries = fs.readdirSync(backupDir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => {
        const full = path.join(backupDir, e.name);
        const stat = fs.statSync(full);
        return {
          name: e.name,
          path: full,
          size: stat.size,
          mtime: stat.mtimeMs,
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return { success: true, dir: backupDir, files };
  } catch (error) {
    return { success: false, error: error.message, files: [] };
  }
});

// Lee un archivo de backup y reporta su formato + estado de firma SIN lanzar excepción.
// Devuelve siempre `data` decodificado cuando es posible — útil para que el admin vea
// el contenido aunque la firma esté rota.
ipcMain.handle('backup-admin-inspect', async (event, filePath) => {
  const locked = requireInspectorUnlocked();
  if (locked) return locked;
  try {
    if (typeof filePath !== 'string' || !filePath) {
      return { success: false, error: 'Ruta inválida' };
    }
    const backupDir = getBackupDir();
    const resolved = path.resolve(filePath);
    // Sandbox: solo permitimos rutas dentro del directorio oficial de backups.
    if (!resolved.startsWith(path.resolve(backupDir) + path.sep) && resolved !== path.resolve(backupDir)) {
      return { success: false, error: 'Ruta fuera del directorio de backups' };
    }
    if (!fs.existsSync(resolved)) return { success: false, error: 'Archivo no existe' };

    const raw = fs.readFileSync(resolved, 'utf-8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { success: true, format: 'invalid-json', signatureValid: false, data: null, raw };
    }

    // v2 firmado
    if (parsed && typeof parsed === 'object' && typeof parsed.signature === 'string' && parsed.data) {
      const valid = verifyBackupSignature(parsed.data, parsed.signature);
      return {
        success: true,
        format: 'v2-signed',
        signatureValid: valid,
        data: normalizeBackupData(parsed.data),
        version: parsed.version || 2,
      };
    }

    // Legado JWT
    if (parsed && typeof parsed === 'object' && parsed.token) {
      const decoded = decodeBackupTokenSafely(parsed.token);
      return {
        success: true,
        format: 'legacy-jwt',
        signatureValid: Boolean(decoded),
        data: decoded ? normalizeBackupData(decoded) : null,
      };
    }

    // v1 plano
    return {
      success: true,
      format: 'v1-unsigned',
      signatureValid: false,
      data: normalizeBackupData(parsed),
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Re-firma un payload (lo que el admin acaba de editar) y lo escribe en formato v2.
// Esto es lo que usa la ventana admin cuando tú editas un .json y quieres que la app
// vuelva a aceptarlo: pasas el `data` modificado y se sobrescribe el archivo con firma válida.
ipcMain.handle('backup-admin-resign', async (event, filePath, data) => {
  const locked = requireInspectorUnlocked();
  if (locked) return locked;
  try {
    if (typeof filePath !== 'string' || !filePath) {
      return { success: false, error: 'Ruta inválida' };
    }
    const backupDir = getBackupDir();
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(backupDir) + path.sep)) {
      return { success: false, error: 'Ruta fuera del directorio de backups' };
    }
    if (!data || typeof data !== 'object') {
      return { success: false, error: 'data inválido' };
    }
    writeBackupFileAtomic(resolved, data, false);
    console.log(`✍️ [BACKUP] Re-firmado por admin: ${path.basename(resolved)}`);
    return { success: true };
  } catch (error) {
    console.error('❌ [BACKUP] Error re-firmando:', error);
    return { success: false, error: error.message };
  }
});

// ==================== PRINTER DEBUG METHODS ====================

// Técnica 1: Native Electron Print API (Optimizado para Térmicas)
ipcMain.handle('printer-test-native', async (event, printerName, testContent) => {
  console.log(' [DEBUG] Técnica 1: Native Electron Print API');
  try {
    const printWindow = new BrowserWindow({
      show: false,
      width: 302,  // 80mm en píxeles (aprox)
      height: 800,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });

    // HTML optimizado para impresoras térmicas con todas las recomendaciones
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          /* Configuración crítica para térmicas */
          @page {
            size: 80mm 200mm;
            margin: 0mm;  /* CRÍTICO: Sin márgenes */
          }
          
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          
          body {
            font-family: 'Courier New', monospace;
            font-size: 14px;
            width: 80mm;  /* CRÍTICO: Ancho exacto */
            margin: 0;
            padding: 5mm;
            background: white !important;
            color: #000000 !important;  /* CRÍTICO: Negro puro */
          }
          
          .header {
            text-align: center;
            font-weight: bold;
            font-size: 16px;
            margin-bottom: 5mm;
            color: #000000 !important;
          }
          
          .line {
            margin: 3mm 0;
            color: #000000 !important;
          }
          
          /* CRÍTICO: Forzar renderizado exacto de colores */
          @media print {
            * {
              -webkit-print-color-adjust: exact !important;
              print-color-adjust: exact !important;
              color: #000000 !important;
            }
            
            body {
              width: 80mm;
              margin: 0;
              padding: 5mm;
              color: #000000 !important;
            }
          }
        </style>
      </head>
      <body>
        <div class="header">═══ TEST NATIVE ═══</div>
        <div class="line">${testContent || 'Test de impresión nativa'}</div>
        <div class="line">Fecha: ${new Date().toLocaleString()}</div>
        <div class="line">Método: Native API Optimizado</div>
        <div class="line">Impresora: ${printerName}</div>
        <div class="line">═════════════════</div>
      </body>
      </html>
    `;

    // Guardar HTML para inspección
    const backupDir = getBackupDir();
    const htmlPath = path.join(backupDir, `test_native_${Date.now()}.html`);
    fs.writeFileSync(htmlPath, html, 'utf8');

    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    printWindow.setTitle('TitanioPOS - Test Ticket');

    // Esperar más tiempo para asegurar renderizado completo
    await new Promise(r => setTimeout(r, 2000));

    // Configuración optimizada para térmicas
    const printOptions = {
      silent: true,
      deviceName: printerName,
      printBackground: true,
      color: false,  // CRÍTICO: Térmicas no usan color
      margins: {
        marginType: 'none'  // CRÍTICO: Sin márgenes
      },
      pageSize: {
        width: 80000,   // 80mm en micras
        height: 200000  // Altura suficiente para el ticket
      }
    };

    console.log(' Opciones de impresión:', JSON.stringify(printOptions, null, 2));

    // Intentar impresión directa con configuración optimizada
    return new Promise((resolve) => {
      printWindow.webContents.print(printOptions, (success, failureReason) => {
        console.log(success ? ' Impresión enviada' : ` Falló: ${failureReason}`);

        closeAndGcPrintWindow(printWindow);

        // Limpiar archivo HTML después de un tiempo
        setTimeout(() => {
          try { if (fs.existsSync(htmlPath)) fs.unlinkSync(htmlPath); } catch (e) { }
        }, 5000);

        resolve({
          success,
          method: 'Native Electron Print API (Optimizado)',
          htmlPath,
          error: success ? undefined : failureReason,
          config: 'Márgenes: none, Color: false, PageSize: 80x200mm'
        });
      });
    });
  } catch (error) {
    console.error(' [DEBUG] Native print error:', error);
    return { success: false, error: error.message };
  }
});

// Técnica 2: PDF Generation + System Print
ipcMain.handle('printer-test-pdf', async (event, printerName, testContent) => {
  console.log('🖨️ [DEBUG] Técnica 2: PDF Generation');
  try {
    const printWindow = new BrowserWindow({
      show: false,
      width: 302,
      height: 600,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          * { margin: 0; padding: 0; }
          body { 
            width: 80mm; 
            font-family: 'Courier New', monospace; 
            font-size: 12px;
            padding: 5mm;
          }
          .header { font-weight: bold; text-align: center; margin-bottom: 10px; }
        </style>
      </head>
      <body>
        <div class="header">TEST - PDF METHOD</div>
        <div>${testContent || 'Test de impresión PDF'}</div>
        <div>Fecha: ${new Date().toLocaleString()}</div>
        <div>Método: PDF Generation</div>
      </body>
      </html>
    `;

    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise(r => setTimeout(r, 500));

    const pdfBuffer = await printWindow.webContents.printToPDF({
      printBackground: true,
      marginsType: 1,
      pageSize: { width: 80000, height: 297000 }
    });

    const backupDir = getBackupDir();
    const pdfPath = path.join(backupDir, `test_${Date.now()}.pdf`);
    fs.writeFileSync(pdfPath, pdfBuffer);

    closeAndGcPrintWindow(printWindow);

    const { exec } = require('child_process');
    const escapedPath = pdfPath.replace(/\\/g, '\\\\');
    const printCommand = `powershell -Command "Start-Process -FilePath '${escapedPath}' -Verb Print"`;

    exec(printCommand, (error) => {
      setTimeout(() => {
        try { if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath); } catch (e) { }
      }, 5000);
    });

    return { success: true, method: 'PDF Generation', pdfPath };
  } catch (error) {
    console.error('❌ [DEBUG] PDF print error:', error);
    return { success: false, error: error.message };
  }
});

// Técnica 3: node-thermal-printer Library
ipcMain.handle('printer-test-thermal', async (event, printerName, testContent) => {
  console.log('🖨️ [DEBUG] Técnica 3: node-thermal-printer');

  const printerTypes = [
    { type: PrinterTypes.EPSON, name: 'EPSON' },
    { type: PrinterTypes.STAR, name: 'STAR' },
    { type: PrinterTypes.TANCA, name: 'TANCA' }
  ];

  let lastError = null;

  for (const printerType of printerTypes) {
    try {
      console.log(`🖨️ Intentando con tipo: ${printerType.name}`);

      let printer;
      try {
        printer = new ThermalPrinter({
          type: printerType.type,
          interface: `printer:${printerName}`,
          characterSet: 'PC858_EURO',
          removeSpecialCharacters: false,
          lineCharacter: '-',
          width: 48
        });
      } catch (e) {
        console.log('⚠️ Interface printer: falló, intentando sin interface');
        printer = new ThermalPrinter({
          type: printerType.type,
          characterSet: 'PC858_EURO',
          removeSpecialCharacters: false,
          lineCharacter: '-',
          width: 48
        });
      }

      printer.alignCenter();
      printer.bold(true);
      printer.println('=== TEST THERMAL ===');
      printer.bold(false);
      printer.alignLeft();
      printer.newLine();
      printer.println(testContent || 'Test termica');
      printer.println(`Fecha: ${new Date().toLocaleString()}`);
      printer.println(`Tipo: ${printerType.name}`);
      printer.newLine();
      printer.drawLine();
      printer.newLine();
      printer.cut();

      const buffer = await printer.execute();
      console.log(`✅ Thermal buffer generado: ${buffer.length} bytes`);

      // Intentar imprimir el buffer directamente
      const { exec } = require('child_process');
      const tempFile = path.join(app.getPath('temp'), `thermal_${Date.now()}.prn`);
      fs.writeFileSync(tempFile, buffer);

      await new Promise((resolve, reject) => {
        exec(`print /D:"${printerName}" "${tempFile}"`, (error) => {
          setTimeout(() => {
            try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (e) { }
          }, 2000);

          if (error) reject(error);
          else resolve();
        });
      });

      return {
        success: true,
        method: `node-thermal-printer (${printerType.name})`,
        bytes: buffer.length
      };
    } catch (error) {
      console.error(`❌ Error con ${printerType.name}:`, error.message);
      lastError = error;
      continue;
    }
  }

  return { success: false, error: lastError?.message || 'Todos los tipos fallaron' };
});

// Técnica 4: ESC/POS Raw Commands via Spooler
ipcMain.handle('printer-test-escpos', async (event, printerName, testContent, manualUsbPort) => {
  console.log('🖨️ [DEBUG] Técnica 4: ESC/POS Raw Commands');

  return new Promise(async (resolve) => {
    try {
      const { exec } = require('child_process');
      const backupDir = path.join(app.getPath('documents'), 'TitanioPOS-Backups');
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

      const tempFile = path.join(backupDir, `escpos_${Date.now()}.prn`);

      // Generar comandos ESC/POS raw
      const ESC = '\x1B';
      const GS = '\x1D';
      let data = '';
      data += ESC + '@';                    // Inicializar impresora
      data += ESC + 'a' + '\x01';           // Centrar
      data += ESC + '!' + '\x10';           // Negrita
      data += '=== TEST ESC/POS ===\n';
      data += ESC + '!' + '\x00';           // Normal
      data += ESC + 'a' + '\x00';           // Izquierda
      data += '\n' + (testContent || 'Test ESC/POS Directo') + '\n';
      data += 'Fecha: ' + new Date().toLocaleString() + '\n';
      data += 'Impresora: ' + printerName + '\n';
      data += 'Metodo: ESC/POS Raw Spooler\n';
      data += '\n\n\n';
      data += GS + 'V' + '\x00';            // Cortar papel

      fs.writeFileSync(tempFile, data, 'binary');
      console.log('📄 Archivo ESC/POS generado:', tempFile);

      // Usar puerto USB manual o detectar automáticamente
      let usbPort = manualUsbPort;

      if (!usbPort) {
        const printers = await mainWindow.webContents.getPrintersAsync();
        const targetPrinter = printers.find(p => p.name === printerName);

        if (targetPrinter && targetPrinter.options && targetPrinter.options.portName) {
          usbPort = targetPrinter.options.portName;
        }
      }

      console.log(`📌 Puerto USB: ${usbPort || 'No detectado'}`);
      if (manualUsbPort) console.log(`   (Configurado manualmente: ${manualUsbPort})`);

      // Intentar múltiples métodos
      const methods = [];

      // Método 1: Windows Spooler API directo con RAW datatype (el más confiable para ESC/POS)
      // Crear script de PowerShell en archivo temporal
      const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class RawPrinter {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public class DOCINFOA {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
    }
    [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
    public static extern bool OpenPrinter([MarshalAs(UnmanagedType.LPStr)] string szPrinter, out IntPtr hPrinter, IntPtr pd);
    [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
    [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);
    public static bool SendBytesToPrinter(string szPrinterName, byte[] pBytes) {
        IntPtr hPrinter = IntPtr.Zero;
        DOCINFOA di = new DOCINFOA();
        di.pDocName = "ESC/POS Document";
        di.pDataType = "RAW";
        bool bSuccess = false;
        if (OpenPrinter(szPrinterName, out hPrinter, IntPtr.Zero)) {
            if (StartDocPrinter(hPrinter, 1, di)) {
                if (StartPagePrinter(hPrinter)) {
                    IntPtr pUnmanagedBytes = Marshal.AllocCoTaskMem(pBytes.Length);
                    Marshal.Copy(pBytes, 0, pUnmanagedBytes, pBytes.Length);
                    int dwWritten;
                    bSuccess = WritePrinter(hPrinter, pUnmanagedBytes, pBytes.Length, out dwWritten);
                    Marshal.FreeCoTaskMem(pUnmanagedBytes);
                    EndPagePrinter(hPrinter);
                }
                EndDocPrinter(hPrinter);
            }
            ClosePrinter(hPrinter);
        }
        return bSuccess;
    }
}
"@
$bytes = [System.IO.File]::ReadAllBytes('${tempFile.replace(/\\/g, '\\\\')}')
$result = [RawPrinter]::SendBytesToPrinter('${printerName}', $bytes)
if ($result) { Write-Host 'SUCCESS' } else { Write-Host 'FAILED'; exit 1 }
`;

      const psScriptFile = path.join(backupDir, `print_${Date.now()}.ps1`);
      fs.writeFileSync(psScriptFile, psScript, 'utf8');

      methods.push({
        cmd: `powershell -ExecutionPolicy Bypass -File "${psScriptFile}"`,
        name: 'WinSpool RAW API',
        cleanup: psScriptFile
      });

      // Método 2: print /D tradicional
      methods.push({
        cmd: `print /D:"${printerName}" "${tempFile}"`,
        name: 'print /D'
      });

      let lastError = null;
      for (const method of methods) {
        console.log(`🖨️ Intentando: ${method.name}`);
        console.log(`   Comando: ${method.cmd}`);

        const result = await new Promise((methodResolve) => {
          exec(method.cmd, (error, stdout, stderr) => {
            if (stdout) console.log(`   stdout: ${stdout}`);
            if (stderr) console.log(`   stderr: ${stderr}`);

            if (!error) {
              console.log(`✅ ${method.name} ejecutado sin errores`);
              methodResolve({ success: true, method: method.name, command: method.cmd });
            } else {
              console.log(`⚠️ ${method.name} falló:`, error.message);
              lastError = error;
              methodResolve({ success: false });
            }
          });
        });

        if (result.success) {
          setTimeout(() => {
            try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (e) { }
            if (method.cleanup) {
              try { if (fs.existsSync(method.cleanup)) fs.unlinkSync(method.cleanup); } catch (e) { }
            }
          }, 3000);
          resolve({
            success: true,
            method: `ESC/POS ${result.method}`,
            file: tempFile,
            command: result.command,
            port: usbPort
          });
          return;
        }
      }

      // Limpiar archivos temporales si todos fallaron
      setTimeout(() => {
        try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (e) { }
        methods.forEach(m => {
          if (m.cleanup) {
            try { if (fs.existsSync(m.cleanup)) fs.unlinkSync(m.cleanup); } catch (e) { }
          }
        });
      }, 3000);

      resolve({
        success: false,
        error: lastError?.message || 'Todos los métodos fallaron',
        file: tempFile,
        port: usbPort,
        triedMethods: methods.length
      });
    } catch (error) {
      console.error('❌ [DEBUG] ESC/POS error:', error);
      resolve({ success: false, error: error.message });
    }
  });
});

// Técnica 5: Serial Port Direct Communication
ipcMain.handle('printer-test-serial', async (event, portName, testContent) => {
  console.log('🖨️ [DEBUG] Técnica 5: Serial Port Direct');

  if (!portName) {
    return { success: false, error: 'No se especificó puerto serial' };
  }

  const baudRates = [9600, 19200, 38400, 115200];

  for (const baudRate of baudRates) {
    try {
      console.log(`🖨️ Intentando ${portName} a ${baudRate} baud`);

      const result = await new Promise((resolve, reject) => {
        let port;

        try {
          port = new SerialPort({
            path: portName,
            baudRate: baudRate,
            dataBits: 8,
            stopBits: 1,
            parity: 'none'
          });
        } catch (e) {
          reject(e);
          return;
        }

        const timeout = setTimeout(() => {
          if (port && port.isOpen) port.close();
          reject(new Error('Timeout abriendo puerto'));
        }, 5000);

        port.on('open', () => {
          clearTimeout(timeout);
          console.log(`✅ Puerto ${portName} abierto a ${baudRate}`);

          const ESC = '\x1B';
          const GS = '\x1D';

          let data = '';
          data += ESC + '@';
          data += ESC + 'a' + '\x01';
          data += ESC + '!' + '\x10';
          data += '=== TEST SERIAL ===\n';
          data += ESC + '!' + '\x00';
          data += ESC + 'a' + '\x00';
          data += '\n';
          data += (testContent || 'Test Serial') + '\n';
          data += `Baud: ${baudRate}\n`;
          data += `Fecha: ${new Date().toLocaleString()}\n`;
          data += '\n\n\n';
          data += GS + 'V' + '\x00';

          port.write(data, (error) => {
            setTimeout(() => {
              if (port && port.isOpen) port.close();
            }, 1000);

            if (error) {
              reject(error);
            } else {
              resolve({ success: true, method: `Serial ${baudRate} baud`, port: portName });
            }
          });
        });

        port.on('error', (error) => {
          clearTimeout(timeout);
          console.error(`❌ Error en puerto:`, error.message);
          reject(error);
        });
      });

      if (result.success) {
        return result;
      }
    } catch (error) {
      console.error(`❌ Falló con ${baudRate}:`, error.message);
      continue;
    }
  }

  return { success: false, error: 'Todos los baud rates fallaron' };
});

// Técnica 6: Windows Printing via PowerShell RAW
ipcMain.handle('printer-test-powershell-raw', async (event, printerName, testContent) => {
  console.log('🖨️ [DEBUG] Técnica 6: PowerShell RAW Printing');
  try {
    const { exec } = require('child_process');

    // Crear archivo temporal con comandos ESC/POS
    const tempDir = app.getPath('temp');
    const tempFile = path.join(tempDir, `print_${Date.now()}.txt`);

    const ESC = '\x1B';
    const content = `${ESC}@${ESC}a\x01${ESC}E\x01TEST - POWERSHELL RAW${ESC}E\x00${ESC}a\x00\n\n${testContent || 'Test PowerShell RAW'}\nFecha: ${new Date().toLocaleString()}\nMétodo: PowerShell RAW\n\n\n`;

    fs.writeFileSync(tempFile, content);

    const psScript = `
      $printerName = "${printerName.replace(/"/g, '`"')}"
      $filePath = "${tempFile.replace(/\\/g, '\\\\')}"
      $content = [System.IO.File]::ReadAllBytes($filePath)
      $printer = New-Object System.Drawing.Printing.PrintDocument
      $printer.PrinterSettings.PrinterName = $printerName
      $stream = New-Object System.IO.MemoryStream(,$content)
      $printer.PrintPage = {
        param($sender, $ev)
        $ev.Graphics.DrawString([System.Text.Encoding]::ASCII.GetString($content), (New-Object System.Drawing.Font("Courier New", 10)), [System.Drawing.Brushes]::Black, 0, 0)
      }
      $printer.Print()
    `;

    const command = `powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`;

    exec(command, (error, stdout, stderr) => {
      setTimeout(() => {
        try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (e) { }
      }, 2000);
    });

    return { success: true, method: 'PowerShell RAW Printing' };
  } catch (error) {
    console.error('❌ [DEBUG] PowerShell RAW error:', error);
    return { success: false, error: error.message };
  }
});

// Técnica 7: Direct RAW printing to Windows Spooler
ipcMain.handle('printer-test-raw-spooler', async (event, printerName, testContent) => {
  console.log('🖨️ [DEBUG] Técnica 7: RAW Spooler');
  try {
    if (!printerName) {
      return { success: false, error: 'No se especificó impresora' };
    }
    const { exec } = require('child_process');

    // Crear archivo temporal con comandos ESC/POS
    const tempDir = app.getPath('temp');
    const tempFile = path.join(tempDir, `raw_${Date.now()}.txt`);

    // Comandos ESC/POS puros
    const ESC = '\x1B';
    const GS = '\x1D';

    let rawData = '';
    rawData += ESC + '@'; // Inicializar
    rawData += ESC + 'a' + '\x01'; // Centrar
    rawData += ESC + '!' + '\x10'; // Doble altura
    rawData += '=== TEST RAW ===\n';
    rawData += ESC + '!' + '\x00'; // Normal
    rawData += ESC + 'a' + '\x00'; // Izquierda
    rawData += '\n';
    rawData += (testContent || 'Test RAW Spooler') + '\n';
    rawData += 'Fecha: ' + new Date().toLocaleString() + '\n';
    rawData += 'Metodo: RAW Spooler\n';
    rawData += '=================\n';
    rawData += '\n\n\n';
    rawData += GS + 'V' + '\x00'; // Cortar

    fs.writeFileSync(tempFile, rawData, 'binary');

    // Intentar múltiples métodos
    // Nombre de recurso compartido: usa el nombre que el usuario define (idealmente sin espacios)
    const escapedPrinter = printerName.replace(/"/g, '""');
    const hostname = os.hostname();
    const shareLocalhost = `\\\\\\\\localhost\\\\${escapedPrinter}`;
    const shareLoopback = `\\\\\\\\127.0.0.1\\\\${escapedPrinter}`;
    const shareHost = `\\\\\\\\${hostname}\\\\${escapedPrinter}`;

    const psRawDirect = `
powershell -Command "$printer='${escapedPrinter}';$path='${tempFile.replace(/\\/g, '\\\\')}';$bytes=[System.IO.File]::ReadAllBytes($path);
Add-Type -Namespace Printing -Name RawPrint -MemberDefinition @'
using System;
using System.Runtime.InteropServices;
public class RawPrinterHelper {
  [DllImport(\\"winspool.drv\\", EntryPoint=\\"OpenPrinterA\\", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);
  [DllImport(\\"winspool.drv\\", EntryPoint=\\"ClosePrinter\\", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport(\\"winspool.drv\\", EntryPoint=\\"StartDocPrinterA\\", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, IntPtr di);
  [DllImport(\\"winspool.drv\\", EntryPoint=\\"StartPagePrinter\\", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport(\\"winspool.drv\\", EntryPoint=\\"EndPagePrinter\\", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport(\\"winspool.drv\\", EntryPoint=\\"EndDocPrinter\\", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport(\\"winspool.drv\\", EntryPoint=\\"WritePrinter\\", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool WritePrinter(IntPtr hPrinter, byte[] data, int buf, out int pcWritten);
  public static bool SendBytesToPrinter(string szPrinterName, byte[] data) {
    IntPtr hPrinter;
    if (!OpenPrinter(szPrinterName, out hPrinter, IntPtr.Zero)) return false;
    if (!StartDocPrinter(hPrinter, 1, IntPtr.Zero)) { ClosePrinter(hPrinter); return false; }
    if (!StartPagePrinter(hPrinter)) { EndDocPrinter(hPrinter); ClosePrinter(hPrinter); return false; }
    int dwWritten = 0;
    bool ok = WritePrinter(hPrinter, data, data.Length, out dwWritten);
    EndPagePrinter(hPrinter);
    EndDocPrinter(hPrinter);
    ClosePrinter(hPrinter);
    return ok;
  }
}
'@;
$res=[Printing.RawPrinterHelper]::SendBytesToPrinter($printer,$bytes);
if($res){'OK'}else{'FAIL'}"`;

    const methods = [
      // Método 1: WinSpool RAW directo (sin compartir)
      psRawDirect,
      // Método 2: copy /B a UNC \\localhost\share
      `copy /B "${tempFile}" "${shareLocalhost}"`,
      // Método 3: copy /B a UNC \\127.0.0.1\share
      `copy /B "${tempFile}" "${shareLoopback}"`,
      // Método 4: copy /B a UNC \\HOSTNAME\share
      `copy /B "${tempFile}" "${shareHost}"`,
      // Método 5: print /D con nombre de dispositivo
      `print /D:"${escapedPrinter}" "${tempFile}"`,
      // Método 6: PowerShell Out-Printer
      `powershell -Command "Get-Content -Path '${tempFile}' -Raw | Out-Printer -Name '${escapedPrinter}'"`
    ];

    for (let i = 0; i < methods.length; i++) {
      const command = methods[i];
      console.log(`🖨️ Intentando método ${i + 1}: ${command.substring(0, 80)}...`);

      const result = await new Promise((resolve) => {
        exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
          const out = stdout?.toString() || '';
          const err = stderr?.toString() || '';
          const deviceError = out.includes('Unable to initialize device') || err.includes('Unable to initialize device');
          const copySuccess = out.includes('1 file(s) copied') || out.toLowerCase().includes('copied') || err.toLowerCase().includes('copied') || out.trim() === 'OK';

          if (error || deviceError) {
            const msg = deviceError ? 'Unable to initialize device' : error?.message;
            console.error(`❌ Método ${i + 1} falló:`, msg);
            resolve({ success: false, error: msg, stdout: out, stderr: err, command });
          } else {
            const ok = copySuccess || !error;
            if (!ok) {
              console.error(`❌ Método ${i + 1} sin confirmación de copia`);
              resolve({ success: false, error: 'Sin confirmación de copia', stdout: out, stderr: err, command });
            } else {
              console.log(`✅ Método ${i + 1} ejecutado`);
              resolve({ success: true, method: `RAW Spooler (Método ${i + 1})`, stdout: out, stderr: err, command });
            }
          }
        });
      });

      if (result.success) {
        setTimeout(() => {
          try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (e) { }
        }, 2000);
        return result;
      }
    }

    setTimeout(() => {
      try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (e) { }
    }, 2000);

    return { success: false, error: 'Todos los métodos RAW fallaron' };
  } catch (error) {
    console.error('❌ [DEBUG] RAW Spooler error:', error);
    return { success: false, error: error.message };
  }
});

// Obtener puertos seriales disponibles
ipcMain.handle('printer-get-serial-ports', async () => {
  try {
    const ports = await SerialPort.list();
    console.log('📡 Serial ports found:', ports.length);
    return { success: true, ports };
  } catch (error) {
    console.error('❌ Error listing serial ports:', error);
    return { success: false, error: error.message, ports: [] };
  }
});

app.whenReady().then(() => {
  // Load fiscal env before starting anything related to fiscal server
  loadFiscalEnv();

  // OS-level perf: raise our own priority + force High Performance power plan.
  // Done here (not in applyElectronOptimizations) because it needs a live PID
  // and child_process to be safe to spawn.
  applyRuntimeOptimizations();

  // Prevent Windows from suspending the app (critical for POS uptime on low-end PCs)
  const { powerSaveBlocker } = require('electron');
  const psbId = powerSaveBlocker.start('prevent-app-suspension');
  console.log('[PERF] Power save blocker started (id:', psbId + ')');

  migrateToUnifiedSettings(app);
  splitFiscalResponsesFromUnifiedIfPresent(app);

  const backupPath = getBackupDir();
  console.log('📁 [BACKUP] Backup directory:', backupPath);
  console.log('📱 [BARCODE] Barcode scanner system initialized');

  createWindow();
  if (app.isPackaged) {
    setupAutoUpdater();
  } else {
    console.log('[UPDATER] Omitido en desarrollo (solo app empaquetada)');
  }

  // Register printer handlers immediately after window is created
  registerPrinterHandlers(app, mainWindow);
  console.log('🖨️ [PRINTER] Printer system initialized');

  // Register fiscal handlers for HKA fiscal machine
  registerFiscalHandlers(app);
  console.log('🧾 [FISCAL] Fiscal machine system initialized');

  // Auto-start fiscal server if it was left running in config
  try {
    const { readSettings, normalizeFiscal } = require('./titaniopos-settings-file');
    const fiscalCfg = normalizeFiscal(readSettings(app).fiscal);
    if (fiscalCfg.enabled && fiscalCfg.serverEnabled) {
      console.log('🧾 [FISCAL] Auto-starting fiscal server (was left running)...');
      const port = parseInt(new URL(fiscalCfg.serverUrl || 'http://127.0.0.1:3005').port, 10) || 3005;
      startFiscalServer({ port })
        .then(r => console.log('🧾 [FISCAL] Auto-start result:', r.success ? 'OK' : r.error))
        .catch(e => console.error('🧾 [FISCAL] Auto-start failed:', e.message));
    }
  } catch (e) {
    console.warn('[FISCAL] Could not auto-start fiscal server:', e.message);
  }

  // Register pinpad handlers for local LAN proxy
  registerPinpadHandlers();
  console.log('💳 [PINPAD] Local proxy initialized');

  // Smart POS (Megasoft VPOS RESTService) — proxy local + arranque del servicio.
  registerSmartPosHandlers();
  startSmartPosServer(app)
    .then((r) => console.log('🟣 [SMART_POS] VPOS:', r && r.message ? r.message : r))
    .catch((e) => console.warn('[SMART_POS] No se pudo arrancar VPOS:', e && e.message));
  console.log('🟣 [SMART_POS] Local proxy initialized');

  // Config Smart POS (host/port del Merchant Server + vtid/afiliación).
  // Se guarda en el settings unificado y se reescribe en vposconf.ini al reiniciar.
  ipcMain.handle('smart-pos-config-get', async () => {
    try {
      const { readSettings, normalizeSmartPos } = require('./titaniopos-settings-file');
      return { success: true, config: normalizeSmartPos(readSettings(app).smartPos) };
    } catch (error) {
      console.error('❌ [SMART_POS CONFIG] get:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('smart-pos-config-save', async (event, partial) => {
    try {
      const { readSettings, writeSettings, normalizeSmartPos } = require('./titaniopos-settings-file');
      const s = readSettings(app);
      s.smartPos = normalizeSmartPos({
        ...(s.smartPos || {}),
        ...(partial && typeof partial === 'object' ? partial : {}),
        lastConfigUpdate: new Date().toISOString(),
      });
      writeSettings(app, s);
      console.log('💾 [SMART_POS CONFIG] Saved:', s.smartPos);
      // Reaplica config al .ini y reinicia el servicio para que tome efecto.
      restartSmartPosServer(app)
        .then((r) => console.log('🟣 [SMART_POS] Reiniciado:', r && r.message ? r.message : r))
        .catch((e) => console.warn('[SMART_POS] Reinicio falló:', e && e.message));
      return { success: true, config: s.smartPos };
    } catch (error) {
      console.error('❌ [SMART_POS CONFIG] save:', error);
      return { success: false, error: error.message };
    }
  });

  // Modo prueba Smart POS: presetea config al simulador, reinicia el VPOS y
  // lanza el simulador (o lo apaga). Todo en un solo switch, sin tocar archivos.
  ipcMain.handle('smart-pos-test-mode', async (event, enabled) => {
    try {
      const result = await setSmartPosTestMode(app, Boolean(enabled));
      console.log('🧪 [SMART_POS] Modo prueba:', enabled, '->', result?.success);
      return result;
    } catch (error) {
      console.error('❌ [SMART_POS] test-mode:', error);
      return { success: false, error: error.message };
    }
  });

  registerCajaConfigHandlers(app);
  console.log('🏪 [CAJA] Caja config (JSON) initialized');

  // Soporte remoto (RustDesk desatendido). Si quedó habilitado, dejarlo corriendo.
  registerRemoteSupportHandlers(app);
  startRemoteSupportIfEnabled(app);
  console.log('🆘 [REMOTE] Soporte remoto initialized');

  // Instaladores de drivers de impresora (térmica, etiquetas, remover).
  registerPrinterDriverHandlers();
  console.log('🖨️ [DRIVERS] Instaladores de drivers initialized');

  // App config handlers (UI settings like reduceAnimations, debugPdf)
  ipcMain.handle('app-config-get', async () => {
    try {
      const { readSettings, normalizeUi } = require('./titaniopos-settings-file');
      const config = normalizeUi(readSettings(app).ui);
      return { success: true, config };
    } catch (error) {
      console.error('❌ [APP CONFIG] Error getting:', error);
      return { success: false, error: error.message, config: { reduceAnimations: false } };
    }
  });

  ipcMain.handle('app-config-save', async (event, partial) => {
    try {
      const { readSettings, writeSettings, normalizeUi } = require('./titaniopos-settings-file');
      const s = readSettings(app);
      s.ui = normalizeUi({ ...(s.ui || {}), ...(partial && typeof partial === 'object' ? partial : {}) });
      writeSettings(app, s);
      console.log('💾 [APP CONFIG] Saved:', s.ui);
      return { success: true, config: s.ui };
    } catch (error) {
      console.error('❌ [APP CONFIG] Error saving:', error);
      return { success: false, error: error.message };
    }
  });

  console.log('⚙️ [APP CONFIG] UI config handlers registered');

  // NOTA: Desde v1.0.42 el servidor fiscal NO se arranca desde Electron.
  // Se distribuye como ZIP standalone aparte (titaniopos-fiscal-server-vX.Y.Z.zip).
  // Esta app solo se conecta a la URL configurada en settings.fiscal.serverUrl.
});

app.on('window-all-closed', () => {
  // Stop fiscal server before quitting
  stopFiscalServer();
  stopSmartPosServer();
  stopSimulator();

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // Ensure fiscal server is stopped
  stopFiscalServer();
  stopSmartPosServer();
  stopSimulator();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});


