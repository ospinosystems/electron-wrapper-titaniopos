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

// Rutas típicas del RustDesk YA INSTALADO como servicio (acceso desatendido real).
const INSTALLED_PATHS = [
  'C:\\Program Files\\RustDesk\\rustdesk.exe',
  'C:\\Program Files (x86)\\RustDesk\\rustdesk.exe',
];

function getInstalledPath() {
  for (const p of INSTALLED_PATHS) {
    try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
  }
  return null;
}

/** Ruta donde guardamos rustdesk.exe si lo descargamos (userData). */
function downloadedBinPath(app) {
  return path.join((app || electronApp).getPath('userData'), 'rustdesk.exe');
}

/**
 * Resuelve un rustdesk.exe utilizable. Prioridad: INSTALADO (servicio) →
 * bundleado en bin/ → descargado en userData. El instalado es el que da
 * acceso desatendido real (corre como servicio, sin la app abierta).
 */
function getRustdeskPath(app) {
  const installed = getInstalledPath();
  if (installed) return installed;
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

/**
 * Instala RustDesk como servicio y fija la contraseña permanente, en UN solo
 * paso elevado (un único UAC). Tras esto, RustDesk corre como servicio: se
 * conecta aunque la app POS esté cerrada y la clave persiste.
 *
 * Usa un .ps1 temporal lanzado con Start-Process -Verb RunAs (UAC).
 */
function elevatedInstallAndSetPassword(app, exe, pw) {
  return new Promise((resolve) => {
    const tmpDir = (app || electronApp).getPath('temp');
    const ps1 = path.join(tmpDir, `rd-setup-${Date.now()}.ps1`);
    const installedExe = INSTALLED_PATHS[0];
    // Usar Start-Process (no bloqueante) + esperas acotadas: así el script
    // termina en ~18s aunque el instalador no devuelva el control, evitando
    // que la activación quede "cargando" indefinidamente.
    const script = [
      `$ErrorActionPreference = 'SilentlyContinue'`,
      `if (-not (Test-Path "${installedExe}")) {`,
      `  Start-Process -FilePath "${exe}" -ArgumentList '--silent-install'`,
      `  Start-Sleep -Seconds 15`,
      `}`,
      `$rd = if (Test-Path "${installedExe}") { "${installedExe}" } else { "${exe}" }`,
      `Start-Process -FilePath $rd -ArgumentList '--password',"${pw}"`,
      `Start-Sleep -Seconds 3`,
    ].join('\r\n');
    try {
      fs.writeFileSync(ps1, script, 'utf8');
    } catch (e) {
      return resolve({ ok: false, error: 'No se pudo preparar el instalador: ' + e.message });
    }
    const outer = `Start-Process -Verb RunAs -Wait -WindowStyle Hidden powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${ps1}'`;
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', outer], { timeout: 60000, windowsHide: true }, (error) => {
      try { fs.unlinkSync(ps1); } catch (_) { /* ignore */ }
      if (error) {
        // El usuario pudo cancelar el UAC.
        return resolve({ ok: false, error: 'No se pudo completar la instalación (¿se canceló el permiso de administrador?).' });
      }
      resolve({ ok: true });
    });
  });
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

async function getId(exe) {
  const res = await runRustdesk(exe, ['--get-id'], 8000);
  // El ID es numérico; limpiamos cualquier ruido del stdout.
  const m = (res.stdout || '').match(/\d{6,}/);
  return m ? m[0] : (res.stdout || '');
}

/**
 * Desinstala RustDesk (servicio incluido) en un paso elevado. Usa el
 * desinstalador oficial silencioso si existe; si no, borra el servicio con sc.
 */
function elevatedUninstall(app) {
  return new Promise((resolve) => {
    const tmpDir = (app || electronApp).getPath('temp');
    const ps1 = path.join(tmpDir, `rd-uninstall-${Date.now()}.ps1`);
    // Estrategia de cinturón y tirantes: matar proceso, parar/borrar el
    // servicio (varios nombres posibles), e intentar el/los desinstaladores.
    const script = [
      `$ErrorActionPreference='SilentlyContinue'`,
      `taskkill /IM rustdesk.exe /F`,
      `foreach ($svc in 'RustDesk','rustdesk') { sc.exe stop $svc; sc.exe delete $svc }`,
      `& "${getInstalledPath() || 'C:\\Program Files\\RustDesk\\rustdesk.exe'}" --uninstall`,
      `$uns = @(`,
      `  'C:\\Program Files\\RustDesk\\uninstall.exe',`,
      `  'C:\\Program Files\\RustDesk\\Uninstall RustDesk.exe',`,
      `  'C:\\Program Files (x86)\\RustDesk\\uninstall.exe'`,
      `)`,
      `foreach ($u in $uns) { if (Test-Path $u) { Start-Process -FilePath $u -ArgumentList '/S' -Wait } }`,
      `Start-Sleep -Seconds 2`,
      `taskkill /IM rustdesk.exe /F`,
    ].join('\r\n');
    try {
      fs.writeFileSync(ps1, script, 'utf8');
    } catch (e) {
      return resolve({ ok: false, error: 'No se pudo preparar la desinstalación: ' + e.message });
    }
    const outer = `Start-Process -Verb RunAs -Wait -WindowStyle Hidden powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${ps1}'`;
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', outer], { timeout: 120000, windowsHide: true }, (error) => {
      try { fs.unlinkSync(ps1); } catch (_) { /* ignore */ }
      if (error) {
        return resolve({ ok: false, error: 'No se pudo desinstalar (¿se canceló el permiso de administrador?).' });
      }
      resolve({ ok: true });
    });
  });
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
      installed: !!getInstalledPath(),
      enabled: cfg.enabled === true,
      hasPassword: !!(cfg.password && cfg.password.length),
      running: !!getInstalledPath() || !!(rustdeskProc && !rustdeskProc.killed),
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
    if (!exe) return { success: false, error: 'RustDesk no está instalado. Descargá el componente primero.' };
    const pw = (password || '').toString().trim();
    if (pw.length < 6) return { success: false, error: 'La contraseña debe tener al menos 6 caracteres.' };

    // Instalar como servicio + fijar contraseña permanente, en un solo paso
    // elevado (un UAC). Tras esto RustDesk corre como servicio: desatendido
    // aunque la app POS esté cerrada, y la clave persiste.
    const setup = await elevatedInstallAndSetPassword(app, exe, pw);
    if (!setup.ok) return { success: false, error: setup.error };

    writeConfig(app, { enabled: true, password: pw });

    // Esperar a que el servicio levante y reporte ID.
    const installed = getInstalledPath() || exe;
    let id = '';
    for (let i = 0; i < 5 && !id; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      id = await getId(installed);
    }
    return { success: true, id, installed: !!getInstalledPath() };
  });

  // Desactiva el soporte: desinstala el servicio de RustDesk (un UAC) y apaga
  // el flag. Tras esto la caja deja de ser accesible de forma desatendida.
  ipcMain.handle('remote-support:disable', async () => {
    const cfg = readConfig(app);
    const res = await elevatedUninstall(app);
    writeConfig(app, { ...cfg, enabled: false });
    try {
      if (rustdeskProc && !rustdeskProc.killed) {
        rustdeskProc.kill();
        rustdeskProc = null;
      }
    } catch (_) { /* ignore */ }
    return { success: res.ok, error: res.ok ? undefined : res.error };
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

/**
 * Al iniciar la app NO se lanza nada: el acceso desatendido lo provee el
 * SERVICIO de RustDesk (instalado al activar), que corre solo en segundo plano.
 * No spawneamos el portable para no abrir una ventana de RustDesk al arrancar.
 */
function startRemoteSupportIfEnabled() {
  // intencionalmente vacío — el servicio maneja el acceso desatendido.
}

module.exports = {
  registerRemoteSupportHandlers,
  startRemoteSupportIfEnabled,
};
