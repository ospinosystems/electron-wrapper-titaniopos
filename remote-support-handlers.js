/**
 * Soporte remoto desatendido vía RustDesk (alternativa gratis a AnyDesk).
 *
 * Idea: se empaqueta `rustdesk.exe` en `bin/` (ya incluido por extraResources)
 * y la app lo lanza con una CONTRASEÑA FIJA, usando el relay público gratuito
 * de RustDesk. El técnico se conecta por ID + esa contraseña, sin que el cajero
 * toque nada (desatendido) — igual que se usa AnyDesk hoy.
 *
 * No requiere servidor propio. Si algún día se quiere relay propio, se agrega
 * `--config <base64>` acá sin tocar el frontend.
 *
 * Config persistida en userData/remote-support.json: { enabled, password }.
 * La contraseña se guarda en claro (es la de soporte, no credenciales de
 * usuario); si se quiere endurecer, cifrar con safeStorage de Electron.
 */

const { ipcMain } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

let rustdeskProc = null;

/** Resuelve la ruta de rustdesk.exe en dev y empaquetado (bin/). */
function getRustdeskPath() {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'bin', 'rustdesk.exe'));
  candidates.push(path.join(__dirname, 'bin', 'rustdesk.exe'));
  if (__dirname.includes('app.asar')) {
    const asarParent = __dirname.split('app.asar')[0];
    candidates.push(path.join(asarParent, 'bin', 'rustdesk.exe'));
  }
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) { /* ignore */ }
  }
  return null;
}

function configPath(app) {
  return path.join(app.getPath('userData'), 'remote-support.json');
}

function readConfig(app) {
  try {
    return JSON.parse(fs.readFileSync(configPath(app), 'utf8'));
  } catch (_) {
    return { enabled: false, password: '' };
  }
}

function writeConfig(app, cfg) {
  try {
    fs.writeFileSync(configPath(app), JSON.stringify(cfg, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[REMOTE] No se pudo guardar config:', e.message);
    return false;
  }
}

/** Corre rustdesk.exe con args y captura stdout (para --get-id / --password). */
function runRustdesk(exe, args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    execFile(exe, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: (stdout || '').toString().trim(),
        stderr: (stderr || '').toString().trim(),
        error: error ? error.message : undefined,
      });
    });
  });
}

/** Lanza rustdesk.exe residente (queda escuchando conexiones entrantes). */
function ensureRunning(exe) {
  if (rustdeskProc && !rustdeskProc.killed) return;
  try {
    rustdeskProc = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true });
    rustdeskProc.unref();
    console.log('[REMOTE] RustDesk lanzado');
  } catch (e) {
    console.error('[REMOTE] No se pudo lanzar RustDesk:', e.message);
  }
}

async function getId(exe) {
  const res = await runRustdesk(exe, ['--get-id'], 8000);
  // El ID es numérico; limpiamos cualquier ruido del stdout.
  const m = (res.stdout || '').match(/\d{6,}/);
  return m ? m[0] : (res.stdout || '');
}

function registerRemoteSupportHandlers(app) {
  ipcMain.handle('remote-support:status', async () => {
    const exe = getRustdeskPath();
    const cfg = readConfig(app);
    let id = '';
    if (exe) {
      try { id = await getId(exe); } catch (_) { /* ignore */ }
    }
    return {
      success: true,
      available: !!exe,
      enabled: cfg.enabled === true,
      hasPassword: !!(cfg.password && cfg.password.length),
      running: !!(rustdeskProc && !rustdeskProc.killed),
      id,
    };
  });

  ipcMain.handle('remote-support:get-id', async () => {
    const exe = getRustdeskPath();
    if (!exe) return { success: false, error: 'rustdesk.exe no está instalado en la app.' };
    const id = await getId(exe);
    return { success: !!id, id };
  });

  // Activa el soporte desatendido: fija la contraseña, deja RustDesk corriendo
  // y devuelve el ID para que soporte se conecte.
  ipcMain.handle('remote-support:enable', async (_event, password) => {
    const exe = getRustdeskPath();
    if (!exe) return { success: false, error: 'rustdesk.exe no está instalado en la app.' };
    const pw = (password || '').toString().trim();
    if (pw.length < 6) return { success: false, error: 'La contraseña debe tener al menos 6 caracteres.' };

    // 1) Arrancar RustDesk (genera config + ID la primera vez).
    ensureRunning(exe);
    await new Promise((r) => setTimeout(r, 1500));

    // 2) Fijar la contraseña permanente de acceso desatendido.
    const setPw = await runRustdesk(exe, ['--password', pw], 8000);
    if (!setPw.ok) {
      console.warn('[REMOTE] --password devolvió error:', setPw.error || setPw.stderr);
    }

    // 3) Persistir e informar el ID.
    writeConfig(app, { enabled: true, password: pw });
    const id = await getId(exe);
    return { success: true, id, passwordApplied: setPw.ok };
  });

  ipcMain.handle('remote-support:disable', async () => {
    const cfg = readConfig(app);
    writeConfig(app, { ...cfg, enabled: false });
    try {
      if (rustdeskProc && !rustdeskProc.killed) {
        rustdeskProc.kill();
        rustdeskProc = null;
      }
    } catch (_) { /* ignore */ }
    return { success: true };
  });

  // Abre la ventana de RustDesk (por si se quiere ver ID/estado manualmente).
  ipcMain.handle('remote-support:open', async () => {
    const exe = getRustdeskPath();
    if (!exe) return { success: false, error: 'rustdesk.exe no está instalado en la app.' };
    try {
      spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  console.log('✅ [REMOTE] Handlers de soporte remoto registrados');
}

/** Al iniciar la app, si el soporte está habilitado, deja RustDesk corriendo. */
function startRemoteSupportIfEnabled(app) {
  try {
    const cfg = readConfig(app);
    if (!cfg.enabled) return;
    const exe = getRustdeskPath();
    if (!exe) return;
    ensureRunning(exe);
    // Reaplicar la contraseña por si el config de RustDesk se reseteó.
    if (cfg.password) {
      setTimeout(() => { runRustdesk(exe, ['--password', cfg.password], 8000); }, 2000);
    }
  } catch (e) {
    console.error('[REMOTE] startIfEnabled error:', e.message);
  }
}

module.exports = {
  registerRemoteSupportHandlers,
  startRemoteSupportIfEnabled,
};
