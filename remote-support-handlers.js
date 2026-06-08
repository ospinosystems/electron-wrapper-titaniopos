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

const { ipcMain, app: electronApp } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');

let rustdeskProc = null;

/** Ruta donde guardamos rustdesk.exe si lo descargamos (userData). */
function downloadedBinPath(app) {
  return path.join((app || electronApp).getPath('userData'), 'rustdesk.exe');
}

/**
 * Resuelve la ruta de rustdesk.exe. Prioridad: bundleado en bin/ (dev y
 * empaquetado) → descargado en userData. Devuelve null si no está en ningún lado.
 */
function getRustdeskPath(app) {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'bin', 'rustdesk.exe'));
  candidates.push(path.join(__dirname, 'bin', 'rustdesk.exe'));
  if (__dirname.includes('app.asar')) {
    const asarParent = __dirname.split('app.asar')[0];
    candidates.push(path.join(asarParent, 'bin', 'rustdesk.exe'));
  }
  candidates.push(downloadedBinPath(app));
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) { /* ignore */ }
  }
  return null;
}

/** GET con seguimiento de redirects, devuelve el body como string. */
function httpsGetText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'TitanioPOS', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpsGetText(res.headers.location, headers));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

/** Descarga binaria a `dest` siguiendo redirects. */
function httpsDownload(url, dest, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'TitanioPOS', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpsDownload(res.headers.location, dest, headers));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const tmp = dest + '.part';
      const file = fs.createWriteStream(tmp);
      res.pipe(file);
      file.on('finish', () => file.close(() => {
        try { fs.renameSync(tmp, dest); resolve(dest); }
        catch (e) { reject(e); }
      }));
      file.on('error', (e) => { try { fs.unlinkSync(tmp); } catch (_) {} reject(e); });
    }).on('error', reject);
  });
}

/**
 * Descarga rustdesk.exe (Windows x86_64) del último release oficial a userData.
 * Resuelve el asset por la API de GitHub para no depender de una versión fija.
 */
async function downloadRustdesk(app) {
  const dest = downloadedBinPath(app);
  const meta = await httpsGetText('https://api.github.com/repos/rustdesk/rustdesk/releases/latest', {
    'Accept': 'application/vnd.github+json',
  });
  const release = JSON.parse(meta);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const asset = assets.find((a) => /x86_64\.exe$/i.test(a.name) && !/aarch64|arm/i.test(a.name));
  if (!asset || !asset.browser_download_url) {
    throw new Error('No se encontró el instalador de Windows en el último release de RustDesk.');
  }
  console.log('[REMOTE] Descargando RustDesk:', asset.name);
  await httpsDownload(asset.browser_download_url, dest);
  return dest;
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
    const exe = getRustdeskPath(app);
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
    const exe = getRustdeskPath(app);
    if (!exe) return { success: false, error: 'rustdesk.exe no está instalado en la app.' };
    const id = await getId(exe);
    return { success: !!id, id };
  });

  // Descarga rustdesk.exe del release oficial (cuando no viene bundleado).
  ipcMain.handle('remote-support:download', async () => {
    try {
      if (getRustdeskPath(app)) return { success: true, alreadyPresent: true };
      const dest = await downloadRustdesk(app);
      return { success: !!dest, path: dest };
    } catch (e) {
      console.error('[REMOTE] Descarga falló:', e.message);
      return { success: false, error: e.message };
    }
  });

  // Activa el soporte desatendido: fija la contraseña, deja RustDesk corriendo
  // y devuelve el ID para que soporte se conecte.
  ipcMain.handle('remote-support:enable', async (_event, password) => {
    const exe = getRustdeskPath(app);
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
    const exe = getRustdeskPath(app);
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
    const exe = getRustdeskPath(app);
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
