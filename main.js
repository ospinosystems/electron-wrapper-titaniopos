const { app, BrowserWindow, ipcMain, Menu, dialog, nativeImage, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// ── Carga de .env ANTES de cualquier require local ───────────────────────────
// Varios módulos (local-proxy, etc.) leen TITANIOPOS_* en CONSTANTES al cargar
// el módulo. Si el env se carga después de los requires, capturan los defaults
// (prod) e ignoran .env/.env.local — el bug de "local apunta a prod". Orden de
// prioridad (gana el primero; loadEnvFile no pisa lo ya seteado):
//   1. preset --env=local|prod (npm run start:local / start:prod)
//   2. resources/.env (externo editable de la caja instalada)
//   3. .env de la raíz del repo
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

const envFlag = (process.argv.find((a) => a.startsWith('--env=')) || '').slice(6).trim()
  || String(process.env.TITANIOPOS_ENV || '').trim();
if (/^[a-z0-9_-]+$/i.test(envFlag)) {
  loadEnvFile(path.join(__dirname, `.env.${envFlag}`), `.env.${envFlag} (preset --env)`);
}
if (process.resourcesPath) {
  loadEnvFile(path.join(process.resourcesPath, '.env'), 'resources/.env (externo, editable)');
}
loadEnvFile(path.join(__dirname, '.env'), path.join(__dirname, '.env'));

const {
  startFrontendServer,
  stopFrontendServer,
  hasLocalBundle,
  resolveServerDir,
} = require('./frontend-server-manager');
const bootWatchdog = require('./boot-watchdog');

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

// CRÍTICO — en modo local (vista descargada) TODO va al mismo origen
// 127.0.0.1:<puerto>: la app, /__backend y /__electric. Electric mantiene 8
// shape streams (long-polls) vivos, y Chromium limita a 6 conexiones HTTP/1.1
// por origen: los long-polls saturan el pool y cualquier navegación nueva
// (fetch RSC de Next) queda encolada indefinidamente → la UI "se traba" (p. ej.
// Ajustes no entra). La vista horneada no lo sufre porque usa URLs absolutas
// (electric.titanio-pos.com = otro origen). Este switch elimina el límite solo
// para el origen local.
app.commandLine.appendSwitch('ignore-connections-limit', '127.0.0.1,localhost');
console.log('[PERF] Límite de 6 conexiones/origen deshabilitado para 127.0.0.1 (long-polls de Electric via proxy local)');

const crypto = require('crypto');
const { autoUpdater } = require('electron-updater');
const jwt = require('jsonwebtoken');
const { registerPrinterHandlers } = require('./printer-handlers');
const { registerFiscalHandlers } = require('./fiscal-handlers');
const { registerPinpadHandlers } = require('./pinpad-handlers');
const { registerMegaPosHandlers } = require('./mega-pos-handlers');
const { startMegaPosServer, stopMegaPosServer, restartMegaPosServer, getVposRuntimeDir, setSeqNum } = require('./mega-pos-manager');
const { registerCajaConfigHandlers } = require('./caja-config-handlers');
const { registerPrintShareHandlers, maybeStartPrintShareServer } = require('./print-share');
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

// (La carga de .env vive al TOPE del archivo, antes de los requires locales —
// ver comentario allá: módulos como local-proxy capturan env al cargarse.)

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
const rootEnvExists = fs.existsSync(path.join(__dirname, '.env'));
const rawAppUrl = (process.env.TITANIOPOS_URL || '').trim();
const APP_URL = rawAppUrl || DEFAULT_APP_URL;

if (!rootEnvExists) {
  console.warn(
    `[ENV] Sin archivo .env (${path.join(__dirname, '.env')}) → TITANIOPOS_URL = ${APP_URL}. ` +
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
    // Si la ventana se perdió pero el proceso sigue vivo (quedó sin ventana),
    // al relanzar el .exe RECREAMOS la ventana en vez de no hacer nada. Esto
    // evita el caso "la app no abre, no hace nada".
    if (!mainWindow || mainWindow.isDestroyed()) {
      try { createWindow(); } catch (e) { console.error('[APP] No se pudo recrear ventana:', e && e.message); }
      return;
    }
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

// ¿Servir la UI desde el bundle local (abre sin internet) o desde APP_URL remota?
// - TITANIOPOS_FRONTEND_MODE=local|remote fuerza el modo.
// - Por defecto: local si hay bundle empaquetado; remoto si no (dev con next dev).
function shouldUseLocalFrontend() {
  const mode = String(process.env.TITANIOPOS_FRONTEND_MODE || '').trim().toLowerCase();
  if (mode === 'local') return true;
  if (mode === 'remote') return false;
  return hasLocalBundle();
}

// Sentinela para "Reintentar" desde las pantallas internas: navegar a esta URL
// hace que Electron vuelva a ejecutar loadAppUI (no recarga la página de estado).
const RETRY_SENTINEL = 'tpos://retry';
// Botón de la pantalla de reparación (ver boot-watchdog.js). Igual que el
// sentinela de reintento: navegar acá dispara la acción en el main, sin IPC.
const REPAIR_SENTINEL = 'tpos://repair';

// Pantalla de estado unificada (dark, sin emoji, acorde a la UI). Sirve para:
// boot (spinner), error de arranque local, y sin conexión (modo remoto).
function buildStatusPage({ title, message, spinner = false, retry = false, autoOnline = false, action = null, icon = null }) {
  // Colores tomados del tema dark de la app (src/app/globals.css): fondo casi
  // negro, primario NARANJA, texto casi blanco. Electron soporta oklch().
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1"><style>
    :root{
      --bg:oklch(0.15 0 0); --fg:oklch(0.98 0 0); --muted:oklch(0.65 0.01 55);
      --primary:oklch(0.66 0.22 55); --primary-h:oklch(0.6 0.2 54); --border:oklch(0.3 0 0);
    }
    *{box-sizing:border-box}
    html,body{height:100%;margin:0;background:var(--bg);color:var(--fg);
      font-family:system-ui,'Segoe UI',sans-serif;display:flex;align-items:center;
      justify-content:center;overflow:hidden}
    /* glow naranja suave como el fondo del login */
    body::before{content:'';position:fixed;top:-10%;right:-5%;width:520px;height:520px;
      background:var(--primary);opacity:.12;border-radius:50%;filter:blur(150px);pointer-events:none}
    body::after{content:'';position:fixed;bottom:-15%;left:-5%;width:440px;height:440px;
      background:var(--primary);opacity:.07;border-radius:50%;filter:blur(130px);pointer-events:none}
    .box{position:relative;max-width:420px;text-align:center;padding:40px 32px}
    .brand{font-size:22px;font-weight:600;letter-spacing:-.01em;margin-bottom:30px}
    .brand b{color:var(--primary);font-weight:700}
    .s{width:30px;height:30px;margin:0 auto 22px;border:3px solid var(--border);
      border-top-color:var(--primary);border-radius:50%;animation:r .8s linear infinite}
    @keyframes r{to{transform:rotate(360deg)}}
    h1{font-size:18px;font-weight:600;margin:0 0 10px}
    p{color:var(--muted);font-size:14px;line-height:1.55;margin:0 0 24px}
    /* Igual que el Button de la app: rounded (4px), h-9 (36px), px-4, text-sm font-medium */
    button{background:var(--primary);color:#fff;border:0;border-radius:4px;height:36px;
      padding:0 16px;font-size:14px;font-weight:500;cursor:pointer;transition:background .15s}
    button:hover{background:var(--primary-h)} button:disabled{opacity:.5;cursor:default}
    .st{margin-top:18px;font-size:12px;color:var(--muted);opacity:.8;min-height:16px}
  </style></head><body>
    <div class="box">
      <div class="brand">Titanio<b>POS</b></div>
      ${spinner ? '<div class="s"></div>' : ''}
      ${icon ? `<div style="margin:0 auto 22px;width:56px;height:56px;color:var(--fg)">${icon}</div>` : ''}
      <h1>${title}</h1>
      ${message ? `<p>${message}</p>` : ''}
      ${retry ? '<button id="retry" onclick="go()">Reintentar</button>' : ''}
      ${action ? `<button id="act" onclick="act()">${action.label}</button>` : ''}
      <div class="st" id="st"></div>
    </div>
    <script>
      function go(){ var b=document.getElementById('retry'); if(b)b.disabled=true;
        var s=document.getElementById('st'); if(s)s.textContent='Reintentando…';
        location.href=${JSON.stringify(RETRY_SENTINEL)}; }
      ${action ? `
      function act(){ var b=document.getElementById('act'); if(b)b.disabled=true;
        var s=document.getElementById('st'); if(s)s.textContent=${JSON.stringify(action.busy || 'Reparando…')};
        location.href=${JSON.stringify(REPAIR_SENTINEL)}; }` : ''}
      ${autoOnline ? `
      window.addEventListener('online', go);
      setInterval(function(){ if(navigator.onLine) go(); }, 5000);` : ''}
    </script>
  </body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

// Splash inicial = MISMO loader branded que la app (BrandedLoader: logo +
// "Titanio POS" + spinner naranja, sobre fondo oscuro). Se replica en HTML y el
// logo se embebe en base64 (leído del bundle), así se ve idéntico aunque el
// server local todavía no haya levantado.
// Tema persistido por la app (para que el splash combine con el tema del usuario).
function uiThemePath() {
  try { return path.join(app.getPath('userData'), 'ui-theme'); } catch { return null; }
}
function getSavedUiTheme() {
  try {
    const p = uiThemePath();
    if (p && fs.existsSync(p)) { const t = fs.readFileSync(p, 'utf8').trim(); if (t === 'light' || t === 'dark') return t; }
  } catch (_) {}
  // Sin tema guardado (primera apertura): usar el del sistema operativo.
  try { return require('electron').nativeTheme.shouldUseDarkColors ? 'dark' : 'light'; } catch (_) {}
  return 'dark';
}
function saveUiTheme(t) {
  if (t !== 'light' && t !== 'dark') return;
  try { const p = uiThemePath(); if (p) fs.writeFileSync(p, t); } catch (_) {}
}

// La app avisa su tema (dark|light) vía preload → lo guardamos para el splash.
ipcMain.handle('ui:save-theme', (_e, theme) => { saveUiTheme(theme); return true; });

// Fuente de la UI activa: 'web' (online) | 'local' (bundle offline). Para el badge.
ipcMain.handle('ui:source', () => {
  try { return require('./frontend-server-manager').getUiSource(); } catch (_) { return 'local'; }
});

let _bootSplash = null;
function getBootSplash() {
  if (_bootSplash) return _bootSplash;
  // Paleta según el tema guardado (claro/oscuro) para que NO salte de color.
  const dark = getSavedUiTheme() !== 'light';
  const C = dark
    ? { bg: 'oklch(0.15 0 0)', fg: 'oklch(0.98 0 0)', muted: 'oklch(0.65 0.01 55)', track: 'rgba(255,255,255,.1)' }
    : { bg: 'oklch(1 0 0)', fg: 'oklch(0.4 0 0)', muted: 'oklch(0.5 0.01 55)', track: 'rgba(0,0,0,.08)' };
  let logoTag = '';
  try {
    const logoPath = path.join(resolveServerDir(), 'public', 'assets', 'images', 'titanio-icon-2.png');
    if (fs.existsSync(logoPath)) {
      const b64 = fs.readFileSync(logoPath).toString('base64');
      logoTag = `<img src="data:image/png;base64,${b64}" alt="" style="width:48px;height:48px;object-fit:contain">`;
    }
  } catch (_) { /* sin logo: queda solo el texto + barra */ }
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{height:100%;margin:0;background:${C.bg};color:${C.fg};
      font-family:system-ui,'Segoe UI',sans-serif;display:flex;flex-direction:column;
      align-items:center;justify-content:center;gap:28px;overflow:hidden}
    /* glow naranja sutil (como el login) */
    body::before{content:'';position:fixed;top:-12%;right:-6%;width:480px;height:480px;
      background:oklch(0.66 0.22 55);opacity:.10;border-radius:50%;filter:blur(150px)}
    body::after{content:'';position:fixed;bottom:-16%;left:-6%;width:420px;height:420px;
      background:oklch(0.66 0.22 55);opacity:.06;border-radius:50%;filter:blur(130px)}
    .head{position:relative;display:flex;flex-direction:column;align-items:center;gap:8px}
    .brand{display:flex;align-items:center;gap:8px}
    .brand span{font-size:24px;font-weight:600;letter-spacing:-.01em}
    .brand b{color:oklch(0.66 0.22 55);font-weight:700}
    .tag{font-size:13px;letter-spacing:.02em;color:${C.muted}}
    /* Barra INDETERMINADA (va y viene) durante el arranque: no hay progreso real
       todavía (la barra 0→100 la lleva el overlay de React después). */
    .ind{position:relative;width:220px;max-width:72vw;height:3px;margin-top:16px;
      border-radius:99px;overflow:hidden;background:${C.track}}
    .ind i{position:absolute;top:0;left:0;width:38%;height:100%;border-radius:99px;
      background:oklch(0.66 0.22 55);animation:slide 1.05s ease-in-out infinite alternate}
    @keyframes slide{from{left:0%}to{left:62%}}
    .boot{margin-top:10px;font-size:12px;letter-spacing:.02em;color:${C.muted}}
  </style></head><body>
    <div class="head">
      <div class="brand">${logoTag}<span>Titanio<b>POS</b></span></div>
      <div class="tag">Sistema de punto de venta</div>
    </div>
    <div class="ind"><i></i></div>
    <div class="boot">Iniciando…</div>
  </body></html>`;
  _bootSplash = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  return _bootSplash;
}

// Pantalla "sin conexión" (modo remoto): fallo de red al cargar la URL remota.
function buildOfflinePage() {
  return buildStatusPage({
    title: 'Sin conexión',
    message: 'No se pudo conectar con TitanioPOS. Revisá la conexión de la caja. Se reintentará solo apenas vuelva internet.',
    retry: true, autoOnline: true,
  });
}

// Pantalla de error de arranque local (no es problema de internet).
function buildLocalErrorPage(detail) {
  return buildStatusPage({
    title: 'No se pudo iniciar la app',
    message: `Hubo un problema al arrancar TitanioPOS localmente.${detail ? '<br><span style="color:#6b7280;font-size:12px">' + detail + '</span>' : ''}`,
    retry: true,
  });
}

/**
 * Pantalla de "la caja no arrancó". La dibuja el watchdog cuando la UI cargó el
 * HTML pero el JavaScript nunca se ejecutó — el modo de falla del 13/08/2026,
 * que hasta ahora dejaba una ventana en blanco sin explicación.
 * El botón es lo ÚNICO que repara: nada corre solo, así se ve qué se hizo.
 */
// Fantasma: icono `ghostty` de Simple Icons (el SiGhostty de react-icons),
// inline porque esta pantalla es HTML puro en el main: acá no hay React.
const GHOST_ICON = '<svg viewBox="0 0 24 24" width="56" height="56" fill="currentColor" aria-hidden="true">' +
  '<path d="M12 0C6.7 0 2.4 4.3 2.4 9.6v11.146c0 1.772 1.45 3.267 3.222 3.254a3.18 3.18 0 0 0 1.955-.686 1.96 1.96 0 0 1 2.444 0 3.18 3.18 0 0 0 1.976.686c.75 0 1.436-.257 1.98-.686.715-.563 1.71-.587 2.419-.018.59.476 1.355.743 2.182.699 1.705-.094 3.022-1.537 3.022-3.244V9.601C21.6 4.3 17.302 0 12 0M6.069 6.562a1 1 0 0 1 .46.131l3.578 2.065v.002a.974.974 0 0 1 0 1.687L6.53 12.512a.975.975 0 0 1-.976-1.687L7.67 9.602 5.553 8.38a.975.975 0 0 1 .515-1.818m7.438 2.063h4.7a.975.975 0 1 1 0 1.95h-4.7a.975.975 0 0 1 0-1.95"/></svg>';

/** Pantalla que dibuja el watchdog cuando la UI no arrancó. Para el cajero:
 *  un fantasma, "Ha ocurrido un error" y un botón. Nada más. El detalle
 *  técnico (`why`, nivel) va al log, no a la pantalla. */
function buildRepairPage({ why, level, info }) {
  if (why) console.warn(`[WATCHDOG] pantalla de reparación (nivel ${level || 'agotado'}): ${why}`);
  return buildStatusPage({
    icon: GHOST_ICON,
    title: 'Ha ocurrido un error con la app',
    message: level
      ? 'Intenta repararla con el botón de abajo.'
      : 'No se pudo reparar. Avisa a soporte.',
    action: level ? { label: info.label, busy: 'Reparando…' } : null,
    retry: !level,
  });
}

// Carga la UI. Local: arranca el server standalone (con reintentos) y apunta al
// proxy local; si no levanta, muestra error con Reintentar (NO cae a una URL muerta).
// Remoto: carga APP_URL; si falla la red, el handler did-fail-load muestra "sin conexión".
async function loadAppUI(win) {
  if (shouldUseLocalFrontend()) {
    if (!win.isDestroyed()) win.loadURL(getBootSplash());
    // Reintenta varias veces detrás del splash. El primer arranque tras un build
    // o actualización suele fallar porque el ANTIVIRUS (Windows Defender) está
    // escaneando los .js recién creados y los bloquea un instante → Next no puede
    // leer un módulo y sale. Reintentando con pausa, apenas el antivirus libera
    // los archivos arranca, sin que el usuario vea el error.
    const attempts = 8;
    const delayMs = 1500;
    for (let i = 1; i <= attempts; i++) {
      try {
        const { url } = await startFrontendServer();
        if (!win.isDestroyed()) {
          win.loadURL(url);
          // A partir de acá la UI tiene que dar señales de vida; si no las da,
          // sale la pantalla de reparación (ver boot-watchdog.js).
          bootWatchdog.arm(win, url);
        }
        return;
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.error(`[FRONTEND] Arranque local falló (intento ${i}/${attempts}): ${msg}`);
        try { stopFrontendServer(); } catch (_) {}
        if (i < attempts) {
          await new Promise((r) => setTimeout(r, delayMs));
        } else if (!win.isDestroyed()) {
          bootWatchdog.disarm('pantalla de error local');
          win.loadURL(buildLocalErrorPage(msg));
        }
      }
    }
    return;
  }
  if (!win.isDestroyed()) {
    win.loadURL(APP_URL);
    bootWatchdog.arm(win, APP_URL);
  }
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
    backgroundColor: getSavedUiTheme() === 'light' ? '#ffffff' : '#1a1a1a',
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

  // Abrir maximizada por defecto (la caja se usa a pantalla completa).
  mainWindow.maximize();

  // [Path B/prueba] Quitar service workers viejos que intercepten las llamadas
  // (la PWA queda desactivada en la caja; el offline va por el bundle local).
  // También 'cachestorage': los caches de workbox (js/static de builds viejos,
  // 1 año de maxAge) quedan huérfanos al quitar el SW y podrían servir assets
  // de otra build si un SW volviera a registrarse.
  try { mainWindow.webContents.session.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] }); } catch (_) {}

  // "Reintentar" desde las pantallas de estado: navega al sentinela → re-ejecuta
  // loadAppUI (vuelve a decidir local/remoto y reintenta), sin loops a URLs muertas.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url && url.startsWith(RETRY_SENTINEL)) {
      event.preventDefault();
      loadAppUI(mainWindow);
    }
    if (url && url.startsWith(REPAIR_SENTINEL)) {
      event.preventDefault();
      bootWatchdog.repairNow(mainWindow);
    }
  });

  // Si la carga remota falla por red, mostrar "sin conexión" en vez de la pantalla
  // gris de Chromium. Solo frame principal, solo fallos de red reales (no data:/sentinela).
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (errorCode === -3) return; // ERR_ABORTED (navegación reemplazada): ignorar
    if (validatedURL && (validatedURL.startsWith('data:') || validatedURL.startsWith('tpos:'))) return;
    // En modo local los fallos los maneja loadAppUI (pantalla de error con reintento).
    if (shouldUseLocalFrontend()) return;
    console.warn(`[APP] did-fail-load (${errorCode} ${errorDescription}) en ${validatedURL} → sin conexión`);
    // Sin red no hay nada que reparar: la pantalla de "sin conexión" no es un
    // arranque fallido y no debe disparar la escalada.
    bootWatchdog.disarm('sin conexión');
    if (!mainWindow.isDestroyed()) mainWindow.loadURL(buildOfflinePage());
  });

  // El watchdog detecta el arranque fallido; dibujar la pantalla es cosa de acá.
  bootWatchdog.setPresenter((state) => {
    if (!mainWindow.isDestroyed()) mainWindow.loadURL(buildRepairPage(state));
  });

  loadAppUI(mainWindow);

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
    // Señal de vida de la UI + detección de JS ilegible (bytes en cero, chunk
    // servido como HTML, code cache podrido).
    try { bootWatchdog.onConsoleMessage(mainWindow, message); } catch (_) {}
    // Forward diagnostic logs to main-process stdout so the user sees them
    // in the `npm start` terminal without needing DevTools open.
    if (typeof message === 'string' && message.startsWith('[PERF-DIAG]')) {
      console.log(message);
    }
  });

  mainWindow.on('closed', () => {
    bootWatchdog.disarm('ventana cerrada');
    mainWindow = null;
    // La ventanita de actualización NO debe impedir 'window-all-closed': si
    // queda viva, la app sigue corriendo sin ventana y el timer de 5 min la
    // "reabre sola" al relanzar.
    try { require('./view-update-window').close(); } catch (_) {}
  });
}

// IPC: versiones (app y runtime)
ipcMain.handle('app-versions', () => ({
  app: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
}));

// (Re)crea el acceso directo en el Escritorio. Lo usan el botón de Ajustes y el
// arranque (self-heal): los updates NSIS borran el acceso directo y no lo
// recrean, así que al iniciar lo restauramos si falta.
//   - force=false (arranque): solo crea si NO existe (no pisa nada).
//   - force=true  (botón):    siempre lo reescribe.
function ensureDesktopShortcut({ force = false } = {}) {
  if (!app.isPackaged) return { success: false, error: 'Solo disponible en la app instalada.' };
  try {
    const desktop = app.getPath('desktop');
    const shortcutPath = path.join(desktop, 'TitanioPOS.lnk');
    const exists = fs.existsSync(shortcutPath);
    if (!force && exists) return { success: true, path: shortcutPath, existed: true };
    const exePath = process.execPath;
    const ok = shell.writeShortcutLink(shortcutPath, exists ? 'replace' : 'create', {
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
}

// IPC: botón de Ajustes para (re)crear el acceso directo si el usuario lo borró.
ipcMain.handle('app:create-desktop-shortcut', () => ensureDesktopShortcut({ force: true }));

// IPC hot-swap de la vista: listar builds instaladas y switchear a demanda.
// Útil para rollback (volver a una build anterior conocida-buena) desde soporte.
ipcMain.handle('view:list-builds', () => {
  try {
    const vu = require('./view-updater');
    const { active, next } = vu.readState();
    return { ok: true, active: vu.getActiveBuildNumber(), next: next || null, builds: vu.listBuilds(), keep: vu.KEEP_BUILDS };
  } catch (e) { return { ok: false, error: e && e.message }; }
});

// Switch a una build instalada + relanzar para aplicarla. relaunch=false solo
// programa el cambio (se aplica en el próximo arranque manual).
ipcMain.handle('view:switch-build', (_e, buildNumber, opts = {}) => {
  try {
    const vu = require('./view-updater');
    const res = vu.switchToBuild(buildNumber, (m) => console.log(m));
    if (!res.ok) return res;
    if (opts.relaunch !== false) {
      // Mismo camino seguro que el auto-reinicio (mata Next hijo y evita que
      // autoInstallOnAppQuit dispare el NSIS del shell sin relanzar).
      relaunchToApplyView(`switch manual a build ${buildNumber}`);
    }
    return { ok: true, relaunching: opts.relaunch !== false };
  } catch (e) { return { ok: false, error: e && e.message }; }
});

// Buscar actualización de la VISTA AHORA (a demanda), contra el host real
// (updates.titanio-pos.com por default). Baja + valida + deja pendiente; se
// aplica al reiniciar. Es el equivalente manual del check en background.
ipcMain.handle('view:check-now', async () => {
  // Pasa por el manager: mismo guard anti-solapamiento y mismo notificador que
  // el check periódico (ventanita de progreso + temporizador de reinicio).
  // El flag marca que ESTA actualización la pidió alguien (Ctrl+F5, login de
  // admin, Ajustes): el evento 'staged' llega durante esta misma llamada.
  viewCheckWasManual = true;
  try {
    return await require('./frontend-server-manager').checkViewUpdateNow('manual (Ajustes)');
  } catch (e) { return { ok: false, error: e && e.message }; }
  finally { viewCheckWasManual = false; }
});

// ── UX de la actualización de la vista (checks automáticos y manuales) ───────
// Ventanita flotante arrastrable (view-update-window.js): progreso de descarga
// y, al quedar lista, temporizador de reinicio SIEMPRE visible + "Reiniciar
// ahora". Auto-reinicio a los 5 minutos + un jitter aleatorio (el timer
// autoritativo corre acá, la ventana solo lo muestra). Los eventos también se
// reenvían al renderer ('view-update') por si la vista quiere pintar su propia UI.
//
// El jitter es lo que evita que una tienda se reinicie entera a la vez. Los
// polls de las cajas están desfasados, pero el retraso al reinicio era una
// constante, así que ese desfase se conservaba tal cual: dos cajas que
// preguntan con 20 s de diferencia se reiniciaban con 20 s de diferencia. Con
// el jitter cada caja cae en un punto propio de una ventana de 10 min. Es el
// reemplazo del escalonado por turnos del backend (apagado por defecto), que
// costaba rollouts de ~40 min por tienda y ni siquiera podía apuntar a una caja
// concreta: el Electron pide latest.json sin identificarse.
const VIEW_RESTART_DELAY_MS = 5 * 60 * 1000;
const VIEW_RESTART_JITTER_MS = 10 * 60 * 1000;
/**
 * Actualización PEDIDA a mano (Ctrl+F5, login de admin, Ajustes): sin jitter y
 * con una espera corta. El jitter existe para desperdigar un despliegue masivo
 * automático; aplicarlo a un pedido explícito solo lograba que quien la pidió
 * viera "faltan 15 minutos", que es lo contrario de lo que buscaba. Igual queda
 * la cuenta atrás y el botón "Reiniciar ahora" por si estaba en algo.
 */
const VIEW_RESTART_MANUAL_MS = 60 * 1000;
let viewCheckWasManual = false;
let viewRestartTimer = null;
let lastProgressPushAt = 0;

// Reinicio para aplicar una vista. app.exit() NO dispara before-quit/
// window-all-closed: hay que matar el Next hijo explícitamente (si no, node.exe
// huérfano por reinicio en vistas standalone). Y OJO con el updater del SHELL:
// app.exit(0) SÍ emite 'quit' → autoInstallOnAppQuit lanzaría el NSIS silencioso
// SIN relanzar, compitiendo con app.relaunch() → caja cerrada a mitad de jornada.
function relaunchToApplyView(reason) {
  console.log(`[VIEW] relanzando la app para aplicar la vista (${reason})`);
  if (viewRestartTimer) { clearTimeout(viewRestartTimer); viewRestartTimer = null; }
  try { stopFrontendServer(); } catch (_) {}
  try {
    if (updaterState.phase === 'done') {
      // Shell descargado pendiente: instalarlo EN este reinicio (silencioso y
      // relanzando); la vista pendiente se aplica igual al arrancar.
      console.log('[VIEW] shell descargado pendiente → quitAndInstall(instala y relanza)');
      autoUpdater.quitAndInstall(true, true);
      return;
    }
    autoUpdater.autoInstallOnAppQuit = false; // cinturón para este exit
  } catch (_) {}
  try { app.relaunch(); } catch (_) {}
  app.exit(0);
}

function relaunchForViewUpdate(reason) { relaunchToApplyView(reason); }

function handleViewUpdateEvent(ev, data) {
  const widget = require('./view-update-window');
  const win = () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);
  try { win()?.webContents.send('view-update', { type: ev, ...data }); } catch (_) {}

  if (ev === 'downloading') {
    widget.showDownloading(data.buildNumber);
    try { win()?.setProgressBar(0.02); } catch (_) {}
  } else if (ev === 'progress') {
    // Throttle: onProgress dispara por chunk; empujar cada frame satura el IPC.
    const now = Date.now();
    if (now - lastProgressPushAt < 300) return;
    lastProgressPushAt = now;
    widget.setProgress(data.buildNumber, data.got, data.total);
    try { win()?.setProgressBar(data.total > 0 ? data.got / data.total : 0.5); } catch (_) {}
  } else if (ev === 'error') {
    widget.showError(data.message);
    try { win()?.setProgressBar(-1); } catch (_) {}
  } else if (ev === 'staged') {
    try { win()?.setProgressBar(-1); } catch (_) {}
    // El timer corre aunque nadie toque la ventana (caja desatendida se
    // actualiza sola); el botón solo lo adelanta.
    if (viewRestartTimer) clearTimeout(viewRestartTimer);
    const delay = viewCheckWasManual
      ? VIEW_RESTART_MANUAL_MS
      : VIEW_RESTART_DELAY_MS + Math.floor(Math.random() * VIEW_RESTART_JITTER_MS);
    const mins = Math.round(delay / 60000);
    viewRestartTimer = setTimeout(() => relaunchForViewUpdate(`timer de ${mins} min`), delay);
    widget.showStaged(data.buildNumber, Date.now() + delay,
      () => relaunchForViewUpdate('botón Reiniciar ahora'));
  }
}

function setupViewUpdateUX() {
  require('./frontend-server-manager').setViewUpdateNotifier(handleViewUpdateEvent);
}

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
let updaterDialogOpen = false;
let updaterDismissedVersion = null;
/**
 * Update OBLIGATORIO (post-cierre): sin diálogos. El flujo normal exige dos
 * clics del cajero ("Descargar" y "Reiniciar ahora") y un "Ahora no" silencia
 * esa versión para todo el proceso; con cajas que quedan abiertas días, eso
 * congela la flota en la versión con la que se instaló. Al cerrar la jornada
 * no hay venta en curso, así que ahí sí se puede bajar e instalar solo.
 */
let updaterForced = false;

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
    // En una caja desatendida los checks de cada 2h apilaban un modal idéntico
    // por check (y dos "Descargar" disparaban downloadUpdate dos veces). Un solo
    // diálogo a la vez, y si dijeron "Ahora no" para ESTA versión no se vuelve a
    // ofrecer sola (el check manual del menú sí la re-ofrece).
    if (updaterDialogOpen) return;
    if (updaterForced) {
      // Sin preguntar: el cajero ya cerró. El banner de progreso igual se ve.
      updaterDownloading = true;
      setUpdaterProgressUI('indeterminate');
      notifyUpdaterStart();
      updateUpdaterState({ phase: 'downloading', version: info.version, percent: 0, bytesPerSecond: 0, transferred: 0, total: 0, error: undefined });
      sendUpdaterEvent('start', { version: info.version });
      try {
        await autoUpdater.downloadUpdate();
      } catch (err) {
        console.error('[UPDATER] Update obligatorio: descarga falló:', err);
        updaterForced = false;
        clearUpdaterProgressUI();
        const message = formatUpdaterErrorForUser(err);
        updateUpdaterState({ phase: 'error', error: message });
        sendUpdaterEvent('error', { message });
      }
      return;
    }
    if (!updateCheckRequestedByUser && updaterDismissedVersion === info.version) return;
    const win = getUpdaterWindow();
    updaterDialogOpen = true;
    let response;
    try {
      ({ response } = await dialog.showMessageBox(win, {
        type: 'info',
        title: 'Actualización disponible',
        message: `Hay una nueva versión: ${info.version}.`,
        detail:
          '¿Descargar ahora? Puedes posponerlo; también desde el menú Help → Buscar actualizaciones… (Alt para ver la barra de menús).',
        buttons: ['Descargar', 'Ahora no'],
        defaultId: 0,
        cancelId: 1,
      }));
    } finally {
      updaterDialogOpen = false;
    }
    if (response !== 0) updaterDismissedVersion = info.version;
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
    if (updaterForced) {
      // autoInstallOnAppQuit ya cubre el caso de que alguien cierre antes.
      console.log('[UPDATER] Update obligatorio: instalando sin preguntar.');
      updaterForced = false;
      autoUpdater.quitAndInstall(false, true);
      return;
    }
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

  // Sin chequeo automatico al arrancar ni re-chequeo periodico: el diálogo "Hay
  // una nueva versión" en cada apertura y cada 2h confundía a los cajeros. La
  // actualización llega por dos vías controladas: el update OBLIGATORIO al
  // cerrar la jornada (updater:force-now, sin diálogos) y el chequeo MANUAL
  // desde Ajustes / Help → Buscar actualizaciones. Si en el futuro se quiere
  // reactivar el periódico, restaurar el setInterval con UPDATER_PERIODIC_CHECK_MS.
  if (updaterPeriodicTimer) { clearInterval(updaterPeriodicTimer); updaterPeriodicTimer = null; }

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

  /**
   * Update obligatorio, sin diálogos: lo dispara la vista al cerrar la jornada.
   * Si hay algo nuevo lo baja y reinicia solo; si no, no molesta a nadie.
   */
  ipcMain.handle('updater:force-now', async () => {
    if (!app.isPackaged) return { ok: false, reason: 'no empaquetada' };
    if (updaterDownloading || updaterState.phase === 'done') {
      return { ok: true, already: true, phase: updaterState.phase };
    }
    updaterForced = true;
    // Un "Ahora no" previo no debe bloquear el update obligatorio.
    updaterDismissedVersion = null;
    try {
      const res = await autoUpdater.checkForUpdates();
      const version = res?.updateInfo?.version ?? null;
      const available = Boolean(version) && version !== app.getVersion();
      if (!available) updaterForced = false;
      return { ok: true, available, version };
    } catch (err) {
      updaterForced = false;
      console.warn('[UPDATER] Update obligatorio: check falló:', err.message);
      return { ok: false, reason: String(err?.message || err) };
    }
  });

  // Permite al usuario buscar actualizaciones desde Ajustes. Reusa el mismo
  // flujo que el menú (diálogos nativos + banner de progreso).
  ipcMain.handle('updater:check', () => {
    try {
      checkForUpdatesManual();
      return { success: true };
    } catch (err) {
      console.error('[UPDATER] check manual falló:', err);
      return { success: false, error: String(err?.message || err) };
    }
  });
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

    // Atómico + fsync: mismo motivo que los backups diarios — un corte de
    // energía a mitad de escritura no debe dejar un JSON truncado.
    const tmpPath = `${filePath}.tmp`;
    const fh = await fs.promises.open(tmpPath, 'w');
    try {
      await fh.writeFile(JSON.stringify(order), 'utf-8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.promises.rename(tmpPath, filePath);
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

// Rota el archivo actual a `.prev` antes de renombrar el `.tmp` nuevo encima.
// Mantiene siempre una generación anterior recuperable: si un corte de energía
// deja el archivo principal corrupto (o desaparece entre los dos rename), el
// lector puede restaurar desde `.prev` (ver readBackupFileWithRecovery).
const rotateBackupToPrevSync = (filePath) => {
  const prevPath = `${filePath}.prev`;
  try {
    // CRÍTICO: si el archivo principal NO existe (primera escritura del día, o
    // una restauración post-corte donde .prev es la ÚNICA copia buena), no hay
    // nada que rotar y .prev NO SE TOCA. El orden viejo (rm .prev primero,
    // incondicional) borraba esa única copia; si la luz se iba entre ese rm y el
    // rename final del writer —los cortes vienen en ráfagas— no quedaba NINGUNA
    // generación legible y el backup "se borraba por completo".
    if (!fs.existsSync(filePath)) return;
    fs.rmSync(prevPath, { force: true });
    fs.renameSync(filePath, prevPath);
  } catch (err) {
    // ENOENT = carrera benigna con el existsSync de arriba — normal.
    if (err.code !== 'ENOENT') {
      console.warn('⚠️ [BACKUP] No se pudo rotar a .prev:', err.message);
    }
  }
};

const rotateBackupToPrevAsync = async (filePath) => {
  const prevPath = `${filePath}.prev`;
  try {
    // Mismo guard que la versión sync: nunca borrar .prev sin un principal que
    // lo reemplace — puede ser la única copia buena tras un corte de energía.
    if (!fs.existsSync(filePath)) return;
    await fs.promises.rm(prevPath, { force: true });
    await fs.promises.rename(filePath, prevPath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('⚠️ [BACKUP] No se pudo rotar a .prev:', err.message);
    }
  }
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
  // `.tmp-sync` (no `.tmp`): este writer corre SÍNCRONO en el hilo principal y
  // puede intercalarse entre los await del writer async (p. ej. una restauración
  // durante la hidratación mientras hay un flush del store en vuelo). Si
  // compartieran el mismo .tmp, este open('w') truncaría el archivo que el otro
  // todavía tiene abierto y el rename publicaría un JSON a medias.
  const tmpPath = `${filePath}.tmp-sync`;
  // Sin pretty-print: en escrituras frecuentes, indentar duplica el tamaño y
  // ralentiza I/O. Los inspect tools admin parsean JSON normal — no necesitan
  // espacios. Para inspección humana, abrir en un editor que reformatee.
  //
  // fsync ANTES del rename: sin él, un corte de energía puede dejar el rename
  // registrado en el journal de NTFS con los datos aún sin bajar a disco → el
  // archivo destino queda vacío o lleno de ceros al reiniciar.
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(payload), null, 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  rotateBackupToPrevSync(filePath);
  fs.renameSync(tmpPath, filePath);
};

// Serializa las escrituras ASÍNCRONAS por archivo. Sin esto, dos escritores
// concurrentes al mismo destino (backup-save-all-orders del renderer y
// backup-delete-order, por ejemplo) comparten el mismo `.tmp`: el segundo
// open('w') trunca lo que el primero está escribiendo, y el rename del primero
// publica un archivo a medias — con rotación de por medio, podía borrar la
// generación buena. Cadena de promesas por filePath: cada escritura espera a
// que termine la anterior (los errores previos no bloquean la siguiente).
const backupWriteChains = new Map();
// Clave normalizada por archivo físico: en NTFS (case-insensitive) dos rutas con
// distinta capitalización (p. ej. la que teclea el admin en el inspector vs la que
// arma getBackupDir) son EL MISMO archivo y deben compartir cadena.
const backupLockKey = (p) =>
  process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
const withBackupWriteLock = (filePath, fn) => {
  const key = backupLockKey(filePath);
  const tail = backupWriteChains.get(key) ?? Promise.resolve();
  const run = tail.catch(() => {}).then(fn);
  // Auto-poda: cuando esta operación termina Y nadie encadenó después, borrar la
  // entrada (evita que el Map acumule una clave por cada día/rango tocado). El
  // chequeo de identidad preserva el FIFO: si alguien encadenó mientras corría,
  // get(key) !== chained y no se borra.
  const chained = run.catch(() => {}).then(() => {
    if (backupWriteChains.get(key) === chained) backupWriteChains.delete(key);
  });
  backupWriteChains.set(key, chained);
  return run;
};

// Versión ASÍNCRONA del writer atómico — para el path caliente de "guardar el
// store completo". No bloquea el event loop de Electron, lo cual es crítico en
// Celeron con HDD donde `writeFileSync` de 500KB-1MB puede tomar 100-300ms y
// congelar el printer, fiscal handlers e IPC durante ese tiempo.
//
// Mantiene la misma semántica de atomicidad: escribe a `.tmp` con fsync, rota el
// archivo anterior a `.prev` y hace rename atómico al destino. Si algo falla
// antes del rename final, el destino o su `.prev` quedan intactos.
const writeBackupFileAtomicAsync = (filePath, backupData, useJwt = BACKUP_WRITE_JWT) =>
  withBackupWriteLock(filePath, async () => {
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
    const fh = await fs.promises.open(tmpPath, 'w');
    try {
      await fh.writeFile(JSON.stringify(payload), 'utf-8');
      // fsync antes del rename — ver nota en writeBackupFileAtomic.
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rotateBackupToPrevAsync(filePath);
    await fs.promises.rename(tmpPath, filePath);
  });

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

  // Legado v1 (JSON plano sin firma). Lo aceptamos solo si `allowUnsigned`.
  if (allowUnsigned) {
    const normalized = normalizeBackupData(fileContent);
    // La reescritura EN SITIO solo cuando el caller lo pide (migrateJwtToPlain).
    // readBackupFileWithRecovery lee `.prev` con migrateJwtToPlain:false justo
    // porque NO quiere que se reescriba la generación de recuperación: migrar el
    // .prev en sitio rota (.prev → .prev.prev) y abre una ventana donde ni el
    // principal (ya cuarentenado) ni .prev existen — un corte ahí lo pierde todo.
    if (migrateJwtToPlain) {
      try {
        writeBackupFileAtomic(backupPath, normalized, false);
        console.log(`♻️ [BACKUP] Migrado v1 sin firma → firmado v2: ${path.basename(backupPath)}`);
      } catch (migrationError) {
        console.warn('⚠️ [BACKUP] No se pudo migrar v1 a v2:', migrationError.message);
      }
    }
    return normalized;
  }

  const err = new Error('Backup sin firma rechazado');
  err.code = 'BACKUP_UNSIGNED';
  throw err;
};

// Códigos que indican manipulación o formato inválido REAL (no corrupción por
// I/O). Estos NO se auto-recuperan desde .prev: se propagan al caller para que
// mantenga el comportamiento estricto de siempre.
const BACKUP_TAMPER_CODES = new Set([
  'BACKUP_SIGNATURE_INVALID',
  'BACKUP_TOKEN_UNSUPPORTED',
  'BACKUP_UNSIGNED',
]);

// Mueve un backup ilegible a cuarentena (`*.corrupt-<stamp>.json`) en vez de
// dejarlo en el camino: así el siguiente flush no lo pisa y queda disponible
// para inspección/recuperación manual desde el inspector admin.
const quarantineCorruptBackup = (backupPath) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${backupPath}.corrupt-${stamp}.json`;
  try {
    fs.renameSync(backupPath, target);
    console.warn('🧪 [BACKUP] Archivo corrupto puesto en cuarentena:', path.basename(target));
    return target;
  } catch (err) {
    console.warn('⚠️ [BACKUP] No se pudo poner en cuarentena:', err.message);
    return null;
  }
};

// Lee un backup con recuperación ante corrupción por corte de energía:
//  - JSON ilegible → cuarentena + intento con `.tmp` firmado y luego `.prev`
//  - archivo principal ausente → `.tmp` firmado (corte entre el fsync y el
//    rename final del writer: es la escritura MÁS RECIENTE, completa en disco)
//    y si no, `.prev` (generación anterior)
//  - lo recuperado se restaura como archivo principal
// Lanza con código:
//  - BACKUP_NOT_FOUND  → no hay archivo, ni .tmp válido, ni .prev (día sin backup)
//  - BACKUP_CORRUPT    → había datos pero ninguna generación es legible
//  - códigos de manipulación (firma/JWT) → se propagan sin auto-recuperar
const readBackupFileWithRecovery = (backupPath, opts = {}) => {
  const prevPath = `${backupPath}.prev`;
  let hadCorruption = false;

  if (fs.existsSync(backupPath)) {
    try {
      return readBackupFileNormalized(backupPath, opts);
    } catch (error) {
      if (BACKUP_TAMPER_CODES.has(error?.code)) throw error;
      hadCorruption = true;
      console.error('⚠️ [BACKUP] Backup ilegible (posible corte de energía), intentando .tmp/.prev:', error.message);
      quarantineCorruptBackup(backupPath);
    }
  }

  // Un `.tmp` solo sobrevive si la ÚLTIMA escritura murió después del fsync y
  // antes del rename (toda escritura exitosa lo consume al renombrarlo): si su
  // firma verifica, es la foto más nueva que existe — más fresca que `.prev`.
  // Solo se acepta FIRMADO (allowUnsigned:false): una escritura a medias no
  // parsea o no verifica, y jamás debe "recuperarse".
  const tmpPath = `${backupPath}.tmp`;
  if (fs.existsSync(tmpPath)) {
    try {
      const data = readBackupFileNormalized(tmpPath, {
        ...opts,
        migrateJwtToPlain: false,
        allowUnsigned: false,
      });
      try {
        writeBackupFileAtomic(backupPath, data, BACKUP_WRITE_JWT);
        console.log('♻️ [BACKUP] Restaurado desde .tmp (escritura interrumpida por corte):', path.basename(backupPath));
        // Consumirlo: su contenido ya vive en el principal. Si quedara, una
        // corrupción futura podría "recuperar" este estado ya viejo por encima
        // de un .prev más nuevo.
        fs.rmSync(tmpPath, { force: true });
      } catch (restoreError) {
        console.warn('⚠️ [BACKUP] No se pudo restaurar desde .tmp:', restoreError.message);
      }
      return data;
    } catch (tmpError) {
      // .tmp roto/no firmado = escritura a medias, caso esperado: se ignora.
      console.warn('⚠️ [BACKUP] .tmp descartado (escritura a medias):', tmpError.message);
    }
  }

  if (fs.existsSync(prevPath)) {
    try {
      const data = readBackupFileNormalized(prevPath, { ...opts, migrateJwtToPlain: false });
      try {
        writeBackupFileAtomic(backupPath, data, BACKUP_WRITE_JWT);
        console.log('♻️ [BACKUP] Restaurado desde .prev:', path.basename(backupPath));
      } catch (restoreError) {
        console.warn('⚠️ [BACKUP] No se pudo restaurar desde .prev:', restoreError.message);
      }
      return data;
    } catch (prevError) {
      if (BACKUP_TAMPER_CODES.has(prevError?.code)) throw prevError;
      hadCorruption = true;
      console.error('⚠️ [BACKUP] .prev también ilegible:', prevError.message);
      quarantineCorruptBackup(prevPath);
    }
  }

  const err = hadCorruption
    ? new Error('Backup corrupto y sin generación previa recuperable')
    : new Error('Backup no existe');
  err.code = hadCorruption ? 'BACKUP_CORRUPT' : 'BACKUP_NOT_FOUND';
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
    const corruptFiles = [];

    for (const dateStr of dates) {
      const backupPath = path.join(backupDir, `backup_${dateStr}.json`);
      let data;
      try {
        // Serializado contra las escrituras del mismo archivo: leer (y sobre todo
        // recuperar/cuarentenar) en paralelo con un flush en vuelo podía tomar un
        // estado a medias como "corrupto".
        data = await withBackupWriteLock(backupPath, async () =>
          readBackupFileWithRecovery(backupPath, { migrateJwtToPlain: !BACKUP_WRITE_JWT }),
        );
      } catch (readError) {
        const code = readError?.code;
        if (code === 'BACKUP_NOT_FOUND') continue;
        if (code === 'BACKUP_CORRUPT') {
          // Corrupción por I/O (corte de energía) sin .prev recuperable. NO es
          // manipulación: se reporta al renderer para que caiga a IndexedDB en
          // lugar de arrancar en cero. El archivo dañado ya quedó en cuarentena.
          corruptFiles.push(`backup_${dateStr}.json`);
          console.error(`❌ [BACKUP] backup_${dateStr}.json corrupto sin recuperación posible`);
          continue;
        }
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
          // Error de I/O genérico (EACCES, EIO...). Antes se reportaba como
          // JWT_INVALID_SIGNATURE, lo que hacía que el renderer lo tratara como
          // manipulación y borrara sus copias locales. Ahora tiene código propio.
          errorCode = 'BACKUP_READ_ERROR';
          errorMessage = `No se pudo leer el respaldo: ${readError?.message || 'error desconocido'}`;
        }
        console.error('❌ [BACKUP] Error leyendo backup:', readError);
        return {
          success: false,
          error: errorMessage,
          errorCode,
          orders: [],
        };
      }
      filesRead += 1;
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
      corruptFiles,
    };
  } catch (error) {
    console.error('❌ [BACKUP] Error leyendo backup:', error);
    return { success: false, error: error.message, errorCode: 'BACKUP_READ_ERROR', orders: [] };
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

    // Read-modify-write bajo UNA sola adquisición del lock: leer y escribir en
    // dos locks separados dejaba una ventana donde un flush del renderer se
    // intercalaba y su versión (con la orden aún presente) pisaba el borrado
    // (lost update). Dentro del lock se usa el writer SÍNCRONO writeBackupFileAtomic
    // — NO writeBackupFileAtomicAsync, que re-entraría en withBackupWriteLock sobre
    // la misma clave y haría deadlock (la op interna esperaría a la externa).
    await withBackupWriteLock(todayBackupPath, async () => {
      let todayData = null;
      try {
        todayData = readBackupFileWithRecovery(todayBackupPath, { migrateJwtToPlain: !BACKUP_WRITE_JWT });
      } catch (readError) {
        // Sin backup de hoy (o irrecuperable): no hay nada que borrar del diario.
        if (readError?.code !== 'BACKUP_NOT_FOUND' && readError?.code !== 'BACKUP_CORRUPT') throw readError;
        return;
      }
      if (todayData) {
        todayData.orders = todayData.orders.filter((o) => String(o.id) !== String(orderId));
        todayData.count = todayData.orders.length;
        todayData.lastSync = new Date().toISOString();
        writeBackupFileAtomic(todayBackupPath, todayData, BACKUP_WRITE_JWT);
      }
    });

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
    // Además de los .json: las generaciones de recuperación — `.prev` (anterior),
    // `.tmp` (escritura interrumpida por corte, puede tener la foto más nueva) y
    // `.tmp-sync` (writer síncrono). Los `.corrupt-*.json` de cuarentena ya
    // entran por el sufijo .json. Todos se pueden abrir con el inspector (el
    // parseo/verificación de firma se reporta por archivo sin lanzar).
    const isInspectable = (name) =>
      name.endsWith('.json') ||
      name.endsWith('.json.prev') ||
      name.endsWith('.json.tmp') ||
      name.endsWith('.json.tmp-sync');
    const files = entries
      .filter((e) => e.isFile() && isInspectable(e.name))
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
    // BAJO EL LOCK: si un flush del renderer sobre el mismo backup_HOY.json está
    // en vuelo (rotación a medias, principal inexistente por un instante), su
    // rename final pisaría esta re-firma sin dejar rastro. El lock serializa esta
    // escritura sync contra los writers async del mismo archivo.
    await withBackupWriteLock(resolved, async () => {
      writeBackupFileAtomic(resolved, data, false);
    });
    console.log(`✍️ [BACKUP] Re-firmado por admin: ${path.basename(resolved)}`);
    return { success: true };
  } catch (error) {
    console.error('❌ [BACKUP] Error re-firmando:', error);
    return { success: false, error: error.message };
  }
});

// ==================== RESTAURACIÓN MANUAL DE GENERACIONES ====================
// Base canónica de un archivo de recuperación: quita los sufijos de generación
// para obtener el backup_YYYY-MM-DD.json al que pertenece.
//   backup_2026-07-24.json.prev              → backup_2026-07-24.json
//   backup_2026-07-24.json.tmp               → backup_2026-07-24.json
//   backup_2026-07-24.json.tmp-sync          → backup_2026-07-24.json
//   backup_2026-07-24.json.corrupt-<stamp>.json → backup_2026-07-24.json
const canonicalBackupTarget = (filePath) => {
  let name = path.basename(filePath);
  // El nombre de cuarentena es `${backup_...json}.corrupt-<stamp>.json`, es decir
  // el sufijo se AÑADE sobre un nombre que YA termina en `.json`. Por eso se quita
  // a vacío (no a '.json'): reemplazar por '.json' dejaba `backup_....json.json`
  // (un destino fantasma que la app nunca lee). Tras quitarlo, un compuesto
  // `....json.prev.corrupt-<stamp>.json` queda en `....json.prev`, que la línea
  // siguiente reduce al principal.
  name = name.replace(/\.corrupt-[0-9TZ:.-]+\.json$/i, '');
  name = name.replace(/\.json\.(prev|tmp|tmp-sync)$/i, '.json');
  return path.join(path.dirname(filePath), name);
};

// Lista, para un backup base, TODAS sus generaciones de recuperación con estado.
// Alimenta la utilidad "Restaurar" del inspector: el operador ve de un vistazo
// cuál generación tiene más órdenes / firma válida y elige cuál restaurar.
ipcMain.handle('backup-admin-list-generations', async (event, basePath) => {
  const locked = requireInspectorUnlocked();
  if (locked) return { ...locked, generations: [] };
  try {
    const backupDir = getBackupDir();
    const canonical = path.resolve(canonicalBackupTarget(basePath || ''));
    if (!canonical.startsWith(path.resolve(backupDir) + path.sep)) {
      return { success: false, error: 'Ruta fuera del directorio de backups', generations: [] };
    }
    const baseName = path.basename(canonical); // backup_YYYY-MM-DD.json
    const entries = fs.readdirSync(backupDir, { withFileTypes: true });
    // Todas las generaciones de ESE día: el principal, .tmp/.prev/.tmp-sync y las
    // cuarentenas *.corrupt-*.json.
    const genRe = new RegExp(
      '^' + baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        '(\\.prev|\\.tmp|\\.tmp-sync|\\.corrupt-[0-9TZ:.-]+\\.json)?$',
      'i',
    );
    const generations = [];
    for (const e of entries) {
      if (!e.isFile() || !genRe.test(e.name)) continue;
      const full = path.join(backupDir, e.name);
      // throwIfNoEntry:false — si el archivo se esfumó entre readdir y stat (un
      // flush/cuarentena concurrente lo renombró), saltar SOLO esa entrada en vez
      // de abortar el listado completo.
      const stat = fs.statSync(full, { throwIfNoEntry: false });
      if (!stat) continue;
      let kind = 'principal';
      if (e.name.endsWith('.prev')) kind = 'anterior (.prev)';
      else if (e.name.endsWith('.tmp-sync')) kind = 'escritura sync (.tmp-sync)';
      else if (e.name.endsWith('.tmp')) kind = 'escritura interrumpida (.tmp)';
      else if (/\.corrupt-/i.test(e.name)) kind = 'cuarentena';
      // Estado sin lanzar: firma, formato, nº de órdenes, lastSync.
      let ordersCount = null;
      let lastSync = null;
      let signatureValid = false;
      let readable = false;
      try {
        const raw = fs.readFileSync(full, 'utf-8');
        const parsed = JSON.parse(raw);
        let data = null;
        if (parsed && typeof parsed === 'object' && typeof parsed.signature === 'string' && parsed.data) {
          signatureValid = verifyBackupSignature(parsed.data, parsed.signature);
          data = normalizeBackupData(parsed.data);
        } else if (parsed && typeof parsed === 'object' && parsed.token) {
          const decoded = decodeBackupTokenSafely(parsed.token);
          signatureValid = Boolean(decoded);
          data = decoded ? normalizeBackupData(decoded) : null;
        } else if (parsed && typeof parsed === 'object') {
          data = normalizeBackupData(parsed);
        }
        if (data) {
          readable = true;
          ordersCount = Array.isArray(data.orders) ? data.orders.length : 0;
          lastSync = data.lastSync ?? null;
        }
      } catch {
        readable = false;
      }
      generations.push({
        name: e.name,
        path: full,
        kind,
        isPrincipal: e.name === baseName,
        size: stat.size,
        mtime: stat.mtimeMs,
        readable,
        signatureValid,
        ordersCount,
        lastSync,
      });
    }
    // Orden: principal primero, luego por nº de órdenes desc, luego por mtime desc.
    generations.sort((a, b) => {
      if (a.isPrincipal !== b.isPrincipal) return a.isPrincipal ? -1 : 1;
      if ((b.ordersCount ?? -1) !== (a.ordersCount ?? -1)) return (b.ordersCount ?? -1) - (a.ordersCount ?? -1);
      return b.mtime - a.mtime;
    });
    return { success: true, target: canonical, targetName: baseName, generations };
  } catch (error) {
    console.error('❌ [BACKUP] Error listando generaciones:', error);
    return { success: false, error: error.message, generations: [] };
  }
});

// Restaura una generación (`sourcePath`) como el backup principal del día.
// Lee la fuente (aceptando firmada, JWT o v1 plano — una copia de recuperación
// puede no estar firmada), y la reescribe firmada v2 en el archivo canónico,
// BAJO EL LOCK (serializa contra flushes del renderer) y de forma atómica (el
// principal previo se conserva en .prev por la rotación del writer).
ipcMain.handle('backup-admin-restore-generation', async (event, sourcePath) => {
  const locked = requireInspectorUnlocked();
  if (locked) return locked;
  try {
    if (typeof sourcePath !== 'string' || !sourcePath) {
      return { success: false, error: 'Ruta inválida' };
    }
    const backupDir = getBackupDir();
    const resolvedSrc = path.resolve(sourcePath);
    if (!resolvedSrc.startsWith(path.resolve(backupDir) + path.sep)) {
      return { success: false, error: 'Ruta fuera del directorio de backups' };
    }
    if (!fs.existsSync(resolvedSrc)) {
      return { success: false, error: 'La generación seleccionada no existe' };
    }
    const target = canonicalBackupTarget(resolvedSrc);
    if (path.resolve(target) === resolvedSrc) {
      return { success: false, error: 'La fuente ya es el archivo principal' };
    }

    // Leer la fuente sin migrarla en sitio (allowUnsigned para aceptar .tmp/.prev
    // legado o plano). Si no parsea/verifica, se rechaza — no restauramos basura.
    let data;
    try {
      data = readBackupFileNormalized(resolvedSrc, { migrateJwtToPlain: false, allowUnsigned: true });
    } catch (readErr) {
      return { success: false, error: `La generación no es legible: ${readErr.message}` };
    }
    // OJO: normalizeBackupData SIEMPRE devuelve {orders:[...]}, así que
    // `Array.isArray(data.orders)` nunca es falso — no sirve de guard. Hay que
    // mirar el CONTEO real.
    const srcCount = Array.isArray(data.orders) ? data.orders.length : 0;
    if (srcCount === 0) {
      return {
        success: false,
        error: 'La generación seleccionada no contiene órdenes; no se restaura sobre el principal.',
      };
    }

    // Protección contra restaurar una copia MÁS PEQUEÑA sobre el principal: el
    // principal anterior solo sobrevive en .prev y el próximo flush del renderer
    // lo pisa, así que un restore que encoge = pérdida permanente. Se permite si
    // el principal es ilegible/inexistente (count 0) — ese ES el caso de
    // recuperación — o si la fuente trae MÁS o IGUAL órdenes.
    let principalCount = 0;
    try {
      if (fs.existsSync(target)) {
        const cur = readBackupFileNormalized(target, { migrateJwtToPlain: false, allowUnsigned: true });
        principalCount = Array.isArray(cur?.orders) ? cur.orders.length : 0;
      }
    } catch {
      principalCount = 0; // principal ilegible → tratamos como recuperación válida
    }
    if (principalCount > srcCount) {
      return {
        success: false,
        error:
          `El archivo principal tiene ${principalCount} órdenes y esta generación solo ${srcCount}. ` +
          `No se restaura una copia con menos para no perder órdenes. Elige otra generación o usa Re-firmar.`,
      };
    }

    await withBackupWriteLock(target, async () => {
      writeBackupFileAtomic(target, data, false);
    });
    console.log(
      `♻️ [BACKUP] Restaurado ${path.basename(resolvedSrc)} → ${path.basename(target)} (${data.orders.length} órdenes)`,
    );
    return { success: true, target, count: data.orders.length };
  } catch (error) {
    console.error('❌ [BACKUP] Error restaurando generación:', error);
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
    // Self-heal: los updates NSIS borran el acceso directo del escritorio.
    // Si falta, lo recreamos en cada arranque.
    try { ensureDesktopShortcut(); } catch (_) { /* no crítico */ }
  } else {
    console.log('[UPDATER] Omitido en desarrollo (solo app empaquetada)');
  }
  setupViewUpdateUX();

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
  registerMegaPosHandlers();
  startMegaPosServer(app)
    .then((r) => console.log('🟣 [MEGA_POS] VPOS:', r && r.message ? r.message : r))
    .catch((e) => console.warn('[MEGA_POS] No se pudo arrancar VPOS:', e && e.message));
  console.log('🟣 [MEGA_POS] Local proxy initialized');

  // Reiniciar / forzar arranque del servicio VPOS desde la UI. Devuelve el
  // resultado (success + message/error) para diagnosticar si no levanta.
  ipcMain.handle('mega-pos-restart', async () => {
    try {
      const r = await restartMegaPosServer(app);
      console.log('🟣 [MEGA_POS] Restart:', r && (r.message || r.error));
      return r;
    } catch (error) {
      console.error('❌ [MEGA_POS] restart:', error);
      return { success: false, error: error.message };
    }
  });

  // Fija [SeqNum] seqnum en el vposconf.ini runtime y reinicia el servicio para
  // que el VPOS lo tome. Operación de soporte (realinear la secuencia con el
  // Merchant). No se persiste en el settings: es un ajuste puntual.
  ipcMain.handle('mega-pos-set-seqnum', async (_e, value) => {
    try {
      const r = setSeqNum(getVposRuntimeDir(app), value);
      if (!r.success) return r;
      // Reiniciar para que el VPOS relea el ini con la nueva secuencia.
      const restart = await restartMegaPosServer(app);
      return { ...r, restarted: Boolean(restart && restart.success), restartMessage: restart && (restart.message || restart.error) };
    } catch (error) {
      console.error('❌ [MEGA_POS] set-seqnum:', error);
      return { success: false, error: error.message };
    }
  });

  // Instala la VPOS (procedimiento oficial Megasoft) ELEVADO (UAC): registra el
  // autoarranque en Startup y configura las rutas. Antes detiene la instancia
  // gestionada por la app y después la vuelve a arrancar para quedar como único
  // dueño del servicio en :8085 (startMegaPosServer mata instancias externas).
  ipcMain.handle('mega-pos-install-vpos', async () => {
    try {
      const runtimeDir = getVposRuntimeDir(app);
      const bat = path.join(runtimeDir, 'InstalacionVPOSREST.bat');
      if (!fs.existsSync(bat)) {
        return { success: false, error: 'No se encontró InstalacionVPOSREST.bat. Reinicia el servicio primero para generar la copia runtime.' };
      }
      stopMegaPosServer();
      const { execFile } = require('child_process');
      const psCmd = `Start-Process -Verb RunAs -Wait -WindowStyle Hidden -WorkingDirectory '${runtimeDir.replace(/'/g, "''")}' -FilePath 'cmd.exe' -ArgumentList '/c','\"${bat.replace(/'/g, "''")}\"'`;
      const ran = await new Promise((resolve) => {
        execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], { timeout: 300000, windowsHide: true }, (error) => {
          if (error && error.killed) return resolve({ success: false, error: 'La instalación no respondió a tiempo (¿el .bat quedó esperando una tecla, o el permiso de administrador sin responder?).' });
          if (error) return resolve({ success: false, error: 'No se pudo instalar (¿se canceló el permiso de administrador?).' });
          resolve({ success: true });
        });
      });
      if (!ran.success) { restartMegaPosServer(app).catch(() => {}); return ran; }
      // La app vuelve a ser dueña del servicio (mata la instancia del autostart y arranca la suya).
      const restart = await restartMegaPosServer(app);
      return { success: true, message: 'VPOS instalada (autoarranque registrado).', restarted: Boolean(restart && restart.success) };
    } catch (error) {
      console.error('❌ [MEGA_POS] install-vpos:', error);
      restartMegaPosServer(app).catch(() => {});
      return { success: false, error: error.message };
    }
  });

  // Desinstala la VPOS ELEVADO (UAC): detiene el servicio y quita el
  // autoarranque de Startup. Se replica el EFECTO del DesinstalacionVPOSREST.bat
  // (taskkill javaw + quitar el VBS de autostart) sin correr el .bat original,
  // que trae un `pause` interactivo y un `del` sobre TODA la carpeta Startup.
  ipcMain.handle('mega-pos-uninstall-vpos', async () => {
    try {
      stopMegaPosServer();
      const { execFile } = require('child_process');
      // El comando va a un .ps1 temporal (mismo patrón que el soporte remoto):
      // pasarlo inline por -ArgumentList '-Command','...' rompía el quoting —
      // la ruta con comillas dobles y espacios ($env:APPDATA\...\Start Menu\...)
      // dejaba a la powershell ELEVADA con un comando incompleto, esperando
      // input en una ventana oculta. Con -Wait, el handle no resolvía nunca y
      // el botón "Desinstalar VPOS" se quedaba cargando para siempre.
      const script = [
        "$ErrorActionPreference='SilentlyContinue'",
        'taskkill /F /IM javaw.exe',
        'taskkill /F /IM java.exe',
        'Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $env:APPDATA \'Microsoft\\Windows\\Start Menu\\Programs\\Startup\\VposREST.vbs\')',
        'exit 0',
      ].join('\n');
      const ps1 = path.join(app.getPath('temp'), `vpos-uninstall-${script.length}.ps1`);
      try {
        fs.writeFileSync(ps1, script, 'utf8');
      } catch (e) {
        return { success: false, error: 'No se pudo preparar la desinstalación: ' + e.message };
      }
      const outer = `Start-Process -Verb RunAs -Wait -WindowStyle Hidden powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${ps1.replace(/'/g, "''")}'`;
      // timeout: aunque el quoting ya no cuelga, un UAC sin responder dejaría
      // el -Wait colgado. Preferimos fallar con mensaje a congelar la UI.
      const ran = await new Promise((resolve) => {
        execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', outer], { timeout: 120000, windowsHide: true }, (error) => {
          try { fs.unlinkSync(ps1); } catch (_) { /* ignore */ }
          if (error && error.killed) return resolve({ success: false, error: 'La desinstalación no respondió a tiempo (¿quedó el permiso de administrador sin responder?).' });
          if (error) return resolve({ success: false, error: 'No se pudo desinstalar (¿se canceló el permiso de administrador?).' });
          resolve({ success: true });
        });
      });
      return ran.success
        ? { success: true, message: 'VPOS desinstalada (servicio detenido y autoarranque quitado).' }
        : ran;
    } catch (error) {
      console.error('❌ [MEGA_POS] uninstall-vpos:', error);
      return { success: false, error: error.message };
    }
  });

  // Config Smart POS (host/port del Merchant Server + SSL + vtid/afiliación).
  // Se guarda en el settings unificado y se reescribe en vposconf.ini al reiniciar.
  ipcMain.handle('mega-pos-config-get', async () => {
    try {
      const { readSettings, normalizeMegaPos } = require('./titaniopos-settings-file');
      return { success: true, config: normalizeMegaPos(readSettings(app).megaPos) };
    } catch (error) {
      console.error('❌ [MEGA_POS CONFIG] get:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mega-pos-config-save', async (event, partial) => {
    try {
      const { readSettings, writeSettings, normalizeMegaPos } = require('./titaniopos-settings-file');
      const s = readSettings(app);
      s.megaPos = normalizeMegaPos({
        ...(s.megaPos || {}),
        ...(partial && typeof partial === 'object' ? partial : {}),
        lastConfigUpdate: new Date().toISOString(),
      });
      writeSettings(app, s);
      console.log('💾 [MEGA_POS CONFIG] Saved:', s.megaPos);
      // Reaplica config al .ini y reinicia el servicio para que tome efecto.
      restartMegaPosServer(app)
        .then((r) => console.log('🟣 [MEGA_POS] Reiniciado:', r && r.message ? r.message : r))
        .catch((e) => console.warn('[MEGA_POS] Reinicio falló:', e && e.message));
      return { success: true, config: s.megaPos };
    } catch (error) {
      console.error('❌ [MEGA_POS CONFIG] save:', error);
      return { success: false, error: error.message };
    }
  });

  // Vuelca las secciones clave del vposconf.ini que el VPOS está usando (read-only,
  // para verificar desde la UI que la config quedó aplicada).
  ipcMain.handle('mega-pos-config-dump', async () => {
    try {
      const runtimeDir = getVposRuntimeDir(app);
      const iniPath = path.join(runtimeDir, 'conf', 'vposconf.ini');
      let settingsPath = '';
      try { settingsPath = require('./titaniopos-settings-file').getSettingsPath(app); } catch (_) {}
      const paths = {
        settings: settingsPath, // credenciales guardadas desde la UI
        runtime: runtimeDir, // distribución que ejecuta el VPOS
        vposconf: iniPath, // archivo que reescribe la app: [server],[SSL],[vtid],[pinpad],[pinpad-verifone]
        vposuniversal: path.join(runtimeDir, 'conf', 'vposuniversal.ini'), // [COMPRA_MEDIOS_PAGO]
      };
      if (!fs.existsSync(iniPath)) return { success: false, error: 'El VPOS aún no se ha inicializado en esta caja.', paths };
      const text = fs.readFileSync(iniPath, 'utf8');
      const WANT = ['server', 'tpdu', 'vtid', 'pinpad', 'pinpad-verifone', 'ssl'];
      const lines = text.split(/\r?\n/);
      const out = [];
      let section = null, keep = false;
      for (const line of lines) {
        const sec = line.match(/^\s*\[([^\]]+)\]\s*$/);
        if (sec) { section = sec[1].trim().toLowerCase(); keep = WANT.includes(section); if (keep) out.push(`[${sec[1].trim()}]`); continue; }
        if (keep) {
          const kv = line.match(/^\s*([A-Za-z0-9_]+)\s*=(.*)$/);
          if (kv) out.push(`${kv[1]}=${kv[2].trim()}`);
          else if (line.trim() === '') out.push('');
        }
      }
      return { success: true, path: iniPath, paths, dump: out.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Devuelve la LISTA de archivos de config relevantes (nombre + ruta), para el visor de la UI.
  ipcMain.handle('mega-pos-config-files', async () => {
    try {
      const runtimeDir = getVposRuntimeDir(app);
      const confDir = path.join(runtimeDir, 'conf');
      let settingsPath = '';
      try { settingsPath = require('./titaniopos-settings-file').getSettingsPath(app); } catch (_) {}
      const files = [
        { key: 'settings', label: 'Credenciales (UI)', path: settingsPath },
        { key: 'vposconf', label: 'vposconf.ini (servidor, vtid, pinpad)', path: path.join(confDir, 'vposconf.ini') },
        { key: 'vposuniversal', label: 'vposuniversal.ini (medios de pago, pinpads)', path: path.join(confDir, 'vposuniversal.ini') },
      ].map((f) => ({ ...f, exists: (() => { try { return fs.existsSync(f.path); } catch { return false; } })() }));
      return { success: true, files };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Lee el contenido COMPLETO de uno de esos archivos (read-only, lista blanca por key).
  ipcMain.handle('mega-pos-read-config-file', async (_e, key) => {
    try {
      const runtimeDir = getVposRuntimeDir(app);
      const confDir = path.join(runtimeDir, 'conf');
      let settingsPath = '';
      try { settingsPath = require('./titaniopos-settings-file').getSettingsPath(app); } catch (_) {}
      const MAP = {
        settings: settingsPath,
        vposconf: path.join(confDir, 'vposconf.ini'),
        vposuniversal: path.join(confDir, 'vposuniversal.ini'),
      };
      const target = MAP[key];
      if (!target) return { success: false, error: 'Archivo no permitido.' };
      if (!fs.existsSync(target)) return { success: false, error: 'El archivo aún no existe (arranca el VPOS primero).', path: target };
      const content = fs.readFileSync(target, 'utf8');
      return { success: true, path: target, content };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  registerCajaConfigHandlers(app);
  console.log('🏪 [CAJA] Caja config (JSON) initialized');

  // Impresión en red entre cajas: si esta caja comparte sus impresoras
  // (printShare.mode === 'share'), levantar el servidor HTTP en la LAN.
  registerPrintShareHandlers(app);
  maybeStartPrintShareServer(app);
  console.log('🖨️ [PRINT-SHARE] Impresión en red initialized');

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
  stopMegaPosServer();
  stopFrontendServer();

  if (process.platform !== 'darwin') {
    app.quit();
    // Red de seguridad anti-ZOMBI: si en 1.5s el proceso no salió (algún hijo
    // mantiene vivo el event loop), forzamos la salida para liberar el lock de
    // instancia única. Sin esto, un proceso sin ventana se queda colgado y la
    // próxima apertura "no abre".
    setTimeout(() => { try { app.exit(0); } catch (_) {} }, 1500);
  }
});

app.on('before-quit', () => {
  // Ensure fiscal server is stopped
  stopFiscalServer();
  stopMegaPosServer();
  stopFrontendServer();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});


