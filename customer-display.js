/**
 * TitanioPOS - Pantalla del cliente (segundo monitor)
 *
 * Si la caja tiene un segundo monitor, abre ahí una ventana a pantalla
 * completa, sin marco y que nunca roba el foco, con la ruta
 * `/customer-display` de la MISMA vista que corre la caja (mismo origen: el
 * bundle local o la URL remota, lo que esté cargado en la ventana principal).
 * La caja publica el carrito por IPC (`customer-display:publish`) y este
 * módulo lo reenvía a esa ventana; guarda el último para entregarlo cuando la
 * ventana (re)abre.
 *
 * - Conectar o quitar el monitor en caliente abre o cierra la ventana sola.
 * - `ui.customerDisplay = "off"` en titaniopos-settings.json la desactiva.
 * - Simulación: `customer-display:simulate` abre la misma pantalla en una
 *   ventana normal sobre el monitor principal (cajas sin segundo monitor,
 *   pruebas en configuración).
 */

const path = require('path');

let appRef = null;
let mainRef = null;
let win = null;
let simulated = false;
let lastPayload = null;
let retryTimer = null;

const SIMULATED_SIZE = { width: 1024, height: 600 };

/** Origen http(s) de una URL; null para data:, tpos:, about: o inválidas. */
function originFromUrl(url) {
  try {
    const u = new URL(String(url || ''));
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch (_) {
    return null;
  }
}

/** El primer monitor que no es el principal (donde vive la caja). */
function pickExternalDisplay(displays, primary) {
  const list = Array.isArray(displays) ? displays : [];
  const primaryId = primary ? primary.id : null;
  return list.find((d) => d && d.id !== primaryId) || null;
}

function isEnabled() {
  try {
    const { readSettings, normalizeUi } = require('./titaniopos-settings-file');
    return normalizeUi(readSettings(appRef).ui).customerDisplay !== 'off';
  } catch (_) {
    return true;
  }
}

function currentOrigin() {
  if (!mainRef || mainRef.isDestroyed()) return null;
  try {
    return originFromUrl(mainRef.webContents.getURL());
  } catch (_) {
    return null;
  }
}

function isOpen() {
  return Boolean(win && !win.isDestroyed());
}

function closeWindow() {
  if (isOpen()) {
    try { win.close(); } catch (_) {}
  }
  win = null;
  simulated = false;
}

function sendLast() {
  if (isOpen() && lastPayload) {
    try { win.webContents.send('customer-display:update', lastPayload); } catch (_) {}
  }
}

function openWindow(origin, bounds, asSimulation) {
  const { BrowserWindow } = require('electron');
  if (isOpen()) {
    if (simulated === asSimulation) return;
    closeWindow();
  }
  simulated = asSimulation;
  const common = {
    backgroundColor: '#1a1a1a',
    show: false,
    focusable: !asSimulation ? false : true,
    skipTaskbar: !asSimulation,
    autoHideMenuBar: true,
    title: asSimulation ? 'Pantalla del cliente (simulación)' : 'Pantalla del cliente',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
      spellcheck: false,
    },
  };
  win = asSimulation
    ? new BrowserWindow({ ...common, width: SIMULATED_SIZE.width, height: SIMULATED_SIZE.height, frame: true })
    : new BrowserWindow({
        ...common,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        frame: false,
        fullscreen: true,
      });
  win.on('closed', () => { win = null; simulated = false; });
  win.webContents.on('did-finish-load', sendLast);
  // showInactive: no roba el foco de la caja (puede haber una venta en curso).
  win.once('ready-to-show', () => { try { win.showInactive(); } catch (_) {} });
  win.loadURL(`${origin}/customer-display`).catch((e) => {
    console.warn('[CUSTOMER-DISPLAY] No se pudo cargar la pantalla:', e && e.message);
  });
  console.log(`🖥️ [CUSTOMER-DISPLAY] ${asSimulation ? 'Simulación' : 'Segundo monitor'}: ${origin}/customer-display`);
}

/** Abre o cierra según monitores conectados y configuración. Idempotente. */
function reconcile() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (!appRef) return;
  if (!isEnabled()) { closeWindow(); return; }
  if (simulated && isOpen()) return; // la simulación la maneja el usuario
  const { screen } = require('electron');
  const external = pickExternalDisplay(screen.getAllDisplays(), screen.getPrimaryDisplay());
  if (!external) { closeWindow(); return; }
  const origin = currentOrigin();
  if (!origin) {
    // La caja aún muestra el splash/estado: reintentar cuando cargue la vista.
    retryTimer = setTimeout(reconcile, 3000);
    return;
  }
  openWindow(origin, external.bounds, false);
}

function status() {
  let displays = 0;
  try { displays = require('electron').screen.getAllDisplays().length; } catch (_) {}
  return { enabled: isEnabled(), displays, open: isOpen(), simulated, hasPayload: Boolean(lastPayload) };
}

function init(app, mainWindow) {
  const { ipcMain, screen } = require('electron');
  appRef = app;
  mainRef = mainWindow;

  mainWindow.webContents.on('did-finish-load', reconcile);
  screen.on('display-added', reconcile);
  screen.on('display-removed', reconcile);
  screen.on('display-metrics-changed', reconcile);

  ipcMain.handle('customer-display:publish', (event, payload) => {
    if (payload && typeof payload === 'object') {
      lastPayload = payload;
      sendLast();
    }
    return { success: true, open: isOpen() };
  });
  ipcMain.handle('customer-display:last', () => lastPayload);
  ipcMain.handle('customer-display:status', () => status());
  ipcMain.handle('customer-display:simulate', (event, open) => {
    if (open) {
      const origin = currentOrigin();
      if (!origin) return { success: false, error: 'La vista aún no cargó.', ...status() };
      openWindow(origin, null, true);
    } else {
      closeWindow();
      reconcile();
    }
    return { success: true, ...status() };
  });

  reconcile();
  console.log('🖥️ [CUSTOMER-DISPLAY] Pantalla del cliente initialized');
}

module.exports = { init, reconcile, status, originFromUrl, pickExternalDisplay };
