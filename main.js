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
const { registerFiscalHandlers } = require('./fiscal-handlers');
const { registerPinpadHandlers } = require('./pinpad-handlers');
const { registerMegaPosHandlers } = require('./mega-pos-handlers');
const { startMegaPosServer, stopMegaPosServer, restartMegaPosServer, getVposRuntimeDir } = require('./mega-pos-manager');
const { registerCajaConfigHandlers } = require('./caja-config-handlers');
const { registerRemoteSupportHandlers, startRemoteSupportIfEnabled } = require('./remote-support-handlers');
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

// Pantalla de estado unificada (dark, sin emoji, acorde a la UI). Sirve para:
// boot (spinner), error de arranque local, y sin conexión (modo remoto).
function buildStatusPage({ title, message, spinner = false, retry = false, autoOnline = false }) {
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
      <h1>${title}</h1>
      ${message ? `<p>${message}</p>` : ''}
      ${retry ? '<button id="retry" onclick="go()">Reintentar</button>' : ''}
      <div class="st" id="st"></div>
    </div>
    <script>
      function go(){ var b=document.getElementById('retry'); if(b)b.disabled=true;
        var s=document.getElementById('st'); if(s)s.textContent='Reintentando…';
        location.href=${JSON.stringify(RETRY_SENTINEL)}; }
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
        if (!win.isDestroyed()) win.loadURL(url);
        return;
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.error(`[FRONTEND] Arranque local falló (intento ${i}/${attempts}): ${msg}`);
        try { stopFrontendServer(); } catch (_) {}
        if (i < attempts) {
          await new Promise((r) => setTimeout(r, delayMs));
        } else if (!win.isDestroyed()) {
          win.loadURL(buildLocalErrorPage(msg));
        }
      }
    }
    return;
  }
  if (!win.isDestroyed()) win.loadURL(APP_URL);
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
    if (!mainWindow.isDestroyed()) mainWindow.loadURL(buildOfflinePage());
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
    // Forward diagnostic logs to main-process stdout so the user sees them
    // in the `npm start` terminal without needing DevTools open.
    if (typeof message === 'string' && message.startsWith('[PERF-DIAG]')) {
      console.log(message);
    }
  });

  mainWindow.on('closed', () => {
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
  try {
    return await require('./frontend-server-manager').checkViewUpdateNow('manual (Ajustes)');
  } catch (e) { return { ok: false, error: e && e.message }; }
});

// ── UX de la actualización de la vista (checks automáticos y manuales) ───────
// Ventanita flotante arrastrable (view-update-window.js): progreso de descarga
// y, al quedar lista, temporizador de reinicio SIEMPRE visible + "Reiniciar
// ahora". Auto-reinicio a los 5 minutos (el timer autoritativo corre acá, la
// ventana solo lo muestra). Los eventos también se reenvían al renderer
// ('view-update') por si la vista quiere pintar su propia UI.
const VIEW_RESTART_DELAY_MS = 5 * 60 * 1000;
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
    viewRestartTimer = setTimeout(() => relaunchForViewUpdate('timer de 5 min'), VIEW_RESTART_DELAY_MS);
    widget.showStaged(data.buildNumber, Date.now() + VIEW_RESTART_DELAY_MS,
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
// congelar los fiscal handlers e IPC durante ese tiempo.
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

  // Soporte remoto (RustDesk desatendido). Si quedó habilitado, dejarlo corriendo.
  registerRemoteSupportHandlers(app);
  startRemoteSupportIfEnabled(app);
  console.log('🆘 [REMOTE] Soporte remoto initialized');

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


