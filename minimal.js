/**
 * Wrapper Electron MINIMALISTA para diagnóstico A/B.
 *
 * Objetivo: cargar el mismo URL que la app real PERO con cero config —
 * sin preload, sin flags Chromium custom, sin IPC, sin webPreferences
 * exóticas, sin priority manipulation, sin fiscal-server. Solo una
 * BrowserWindow defaults y `loadURL`.
 *
 * Cómo correr:
 *   npx electron minimal.js              → carga POS URL (localhost:3001)
 *   npx electron minimal.js --html       → carga HTML local con animación pura
 *   npx electron minimal.js --url=...    → carga URL custom
 *
 * Qué comparar:
 *   - Si la app POS lagguea acá igual que en `npm start` → el problema
 *     NO está en nuestro main.js / webPreferences / flags. Es Electron
 *     o nuestro frontend, no el wrapper.
 *   - Si el HTML local lagguea acá → el problema es Electron/Chromium
 *     o la GPU stack. Nuestro frontend está absolutamente exonerado.
 *   - Si todo va fluido acá → uno de nuestros 30+ ajustes en main.js
 *     real es el culpable, lo bisectamos.
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');

// ─── OPCIÓN A: forzar backend OpenGL en vez de Direct3D 11 ───
// Comentá esta línea para volver al default (D3D11).
// app.commandLine.appendSwitch('use-angle', 'gl');
// ─── OPCIÓN B: software rendering (desactiva GPU completa) ───
// Descomentar SOLO una opción a la vez. Si activás B, comentá A.
// app.disableHardwareAcceleration();
// ─── OPCIÓN C: spoofear User-Agent como Chrome puro ───
// Si esto resuelve el lag = nuestra app detecta Electron y hace algo
// distinto que la hace más lenta.
const FAKE_CHROME_UA = true;

const args = process.argv.slice(2);
const useHtml = args.includes('--html');
const urlArg = args.find((a) => a.startsWith('--url='));
const customUrl = urlArg ? urlArg.slice('--url='.length) : null;

const POS_URL = process.env.TITANIOPOS_URL || 'http://localhost:3001/checkout/guacara';

const ANIMATION_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Minimal Electron Animation Test</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, sans-serif;
      background: #111827;
      color: #fff;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 24px;
      gap: 16px;
    }
    .box {
      width: 240px;
      height: 60px;
      background: linear-gradient(135deg, #4f46e5, #ec4899);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      animation: slide 1.4s ease-in-out infinite alternate;
      will-change: transform;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(10, 1fr);
      gap: 8px;
      width: 100%;
      max-width: 1100px;
    }
    .cell {
      height: 38px;
      background: #1f2937;
      border-radius: 6px;
      animation: pulse 2s ease-in-out infinite alternate;
    }
    .cell:nth-child(odd) { animation-delay: 0.1s; }
    .cell:nth-child(3n) { animation-delay: 0.25s; }
    @keyframes slide {
      from { transform: translateX(-200px) scale(0.95); }
      to   { transform: translateX( 200px) scale(1.05); }
    }
    @keyframes pulse {
      from { opacity: 0.4; transform: scale(1); }
      to   { opacity: 1.0; transform: scale(1.03); }
    }
    #fps {
      position: fixed; top: 8px; right: 12px;
      font-family: monospace; font-size: 14px;
      background: rgba(0,0,0,0.5); padding: 4px 8px; border-radius: 6px;
    }
    h1 { font-size: 18px; margin: 4px 0 12px; opacity: 0.85; }
  </style>
</head>
<body>
  <div id="fps">FPS: --</div>
  <h1>Electron Minimal Animation Test</h1>
  <div class="box">Animación A (transform)</div>
  <div class="grid" id="grid"></div>
  <script>
    // 100 celdas animadas — paridad con 100 filas de la tabla del POS.
    const grid = document.getElementById('grid');
    for (let i = 0; i < 100; i++) {
      const c = document.createElement('div');
      c.className = 'cell';
      c.textContent = i;
      grid.appendChild(c);
    }
    // FPS counter
    let frames = 0, lastTs = performance.now();
    const el = document.getElementById('fps');
    (function tick(ts) {
      frames++;
      const dt = ts - lastTs;
      if (dt >= 1000) {
        el.textContent = 'FPS: ' + frames + ' | DPR: ' + devicePixelRatio.toFixed(2) +
                         ' | ' + innerWidth + 'x' + innerHeight;
        console.log('[MINIMAL] FPS=' + frames + ' DPR=' + devicePixelRatio +
                    ' inner=' + innerWidth + 'x' + innerHeight);
        frames = 0;
        lastTs = ts;
      }
      requestAnimationFrame(tick);
    })(performance.now());
  </script>
</body>
</html>`;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#111827',
    title: 'Electron Minimal Test',
    // webPreferences omitido a propósito → defaults de Electron.
  });

  // Forward renderer console → main process stdout (para ver el FPS log
  // sin abrir DevTools).
  win.webContents.on('console-message', (event, level, message) => {
    if (typeof message === 'string' && message.startsWith('[MINIMAL]')) {
      console.log(message);
    }
  });

  // Reset zoom: descartamos que zoom persistido sea el culpable.
  win.webContents.once('did-finish-load', () => {
    win.webContents.setZoomFactor(1.0);
    win.webContents.executeJavaScript(`
      console.log('[MINIMAL] loaded. DPR=' + devicePixelRatio +
                  ' inner=' + innerWidth + 'x' + innerHeight);
    `).catch(() => {});
  });

  // Zoom: Ctrl+Scroll y Ctrl + / Ctrl − / Ctrl 0 (paridad con la app real).
  win.webContents.on('zoom-changed', (event, zoomDirection) => {
    const current = win.webContents.getZoomFactor();
    const next = zoomDirection === 'in'
      ? Math.min(current + 0.1, 3.0)
      : Math.max(current - 0.1, 0.3);
    win.webContents.setZoomFactor(next);
    console.log('[MINIMAL] zoomFactor=' + next.toFixed(2));
  });

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control) return;
    const current = win.webContents.getZoomFactor();
    if (input.key === '+' || input.key === '=') {
      event.preventDefault();
      win.webContents.setZoomFactor(Math.min(current + 0.1, 3.0));
      console.log('[MINIMAL] zoomFactor=' + win.webContents.getZoomFactor().toFixed(2));
    } else if (input.key === '-' || input.key === '_') {
      event.preventDefault();
      win.webContents.setZoomFactor(Math.max(current - 0.1, 0.3));
      console.log('[MINIMAL] zoomFactor=' + win.webContents.getZoomFactor().toFixed(2));
    } else if (input.key === '0') {
      event.preventDefault();
      win.webContents.setZoomFactor(1.0);
      console.log('[MINIMAL] zoomFactor=1.00 (reset)');
    }
  });

  const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

  if (useHtml) {
    console.log('[MINIMAL] Loading local animation HTML');
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(ANIMATION_HTML));
  } else {
    const url = customUrl || POS_URL;
    const loadOpts = FAKE_CHROME_UA ? { userAgent: CHROME_UA } : undefined;
    if (FAKE_CHROME_UA) console.log('[MINIMAL] Spoofing UA as Chrome');
    console.log('[MINIMAL] Loading URL:', url);
    win.loadURL(url, loadOpts);
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
