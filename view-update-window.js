/**
 * view-update-window.js — ventanita flotante de la actualización de la vista.
 *
 * Frameless, arrastrable, always-on-top, esquina inferior derecha. Muestra el
 * progreso de la descarga y, cuando la build queda lista, el temporizador de
 * reinicio visible en todo momento + botón "Reiniciar ahora". Vive en el main
 * de Electron (NO en la vista): funciona igual con bundles viejos y nuevos.
 *
 * El temporizador AUTORITATIVO corre en main.js (setTimeout); el de la ventana
 * es solo display contra el deadline que se le pasa.
 */
const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

const W = 340;
const H = 132;

let win = null;
let onRestartNow = null;
let closeTimer = null;

ipcMain.on('view-widget:restart-now', () => {
  try { if (onRestartNow) onRestartNow(); } catch (_) {}
});

function ensureWindow() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: W,
    height: H,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#111827',
    webPreferences: {
      preload: path.join(__dirname, 'view-update-widget-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'view-update-widget.html'));
  try {
    const wa = screen.getPrimaryDisplay().workArea;
    win.setPosition(wa.x + wa.width - W - 16, wa.y + wa.height - H - 16);
  } catch (_) {}
  // showInactive: no roba el foco de la caja (puede haber una venta en curso).
  win.once('ready-to-show', () => { try { win.showInactive(); } catch (_) {} });
  win.on('closed', () => { win = null; });
  return win;
}

function send(payload) {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  const w = ensureWindow();
  const deliver = () => { try { w.webContents.send('view-widget:state', payload); } catch (_) {} };
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', deliver);
  else deliver();
}

function close() {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
  win = null;
  onRestartNow = null;
}

module.exports = {
  showDownloading(buildNumber) {
    send({ mode: 'downloading', buildNumber, pct: null });
  },
  setProgress(buildNumber, got, total) {
    send({ mode: 'downloading', buildNumber, pct: total > 0 ? got / total : null });
  },
  showStaged(buildNumber, deadlineTs, restartCb) {
    onRestartNow = restartCb;
    send({ mode: 'staged', buildNumber, deadlineTs });
  },
  showError(message) {
    send({ mode: 'error', message });
    closeTimer = setTimeout(close, 6000); // el error se muestra y la ventana se va sola
  },
  close,
};
