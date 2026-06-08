/**
 * Lanzadores de instaladores de drivers de impresora (bundleados en drivers/).
 *
 * Tres ejecutables, accesibles desde la configuración:
 *   - thermal : XPrinter Driver Setup  → instalar la impresora térmica.
 *   - label   : LabelPrinter           → impresora de tickets/etiquetas.
 *   - remove  : 4BARCODE               → remover impresoras instaladas.
 *
 * Se ejecutan ELEVADOS (UAC) porque los instaladores de drivers requieren
 * permisos de administrador.
 */

const { ipcMain } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const DRIVERS = {
  thermal: 'xprinter-driver.exe',
  label: 'labelprinter-driver.exe',
  remove: '4barcode-driver.exe',
};

/** Resuelve la ruta del instalador en dev y empaquetado (drivers/). */
function getDriverPath(file) {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'drivers', file));
  candidates.push(path.join(__dirname, 'drivers', file));
  if (__dirname.includes('app.asar')) {
    const asarParent = __dirname.split('app.asar')[0];
    candidates.push(path.join(asarParent, 'drivers', file));
  }
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) { /* ignore */ }
  }
  return null;
}

/** Lanza el instalador con permisos de administrador (UAC). */
function launchElevated(exe) {
  return new Promise((resolve) => {
    const outer = `Start-Process -Verb RunAs -FilePath '${exe}'`;
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', outer], { windowsHide: true }, (error) => {
      if (error) return resolve({ ok: false, error: 'No se pudo ejecutar (¿se canceló el permiso de administrador?).' });
      resolve({ ok: true });
    });
  });
}

function registerPrinterDriverHandlers() {
  ipcMain.handle('printer-driver:status', async () => {
    const available = {};
    for (const [key, file] of Object.entries(DRIVERS)) {
      available[key] = !!getDriverPath(file);
    }
    return { success: true, available };
  });

  ipcMain.handle('printer-driver:launch', async (_event, key) => {
    const file = DRIVERS[key];
    if (!file) return { success: false, error: 'Instalador desconocido.' };
    const exe = getDriverPath(file);
    if (!exe) return { success: false, error: 'El instalador no está incluido en esta versión de la app.' };
    const res = await launchElevated(exe);
    return { success: res.ok, error: res.error };
  });

  console.log('✅ [DRIVERS] Handlers de drivers de impresora registrados');
}

module.exports = { registerPrinterDriverHandlers };
