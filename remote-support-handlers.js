/**
 * Soporte remoto desatendido vía RustDesk (alternativa gratis a AnyDesk),
 * apuntando a NUESTRO servidor self-host (no al relay público).
 *
 * CLAVE DE DISEÑO (lo que rompía antes): en Windows el SERVICIO de RustDesk
 * corre como `LocalService` y guarda su config en
 *   C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\RustDesk\config
 * mientras que un `rustdesk.exe` lanzado por el admin lee/escribe
 *   %APPDATA%\RustDesk\config
 * Son archivos DISTINTOS. Por eso, correr `--get-id`/`--password`/`--config`
 * como usuario NO afectaba al servicio y mostraba un ID diferente al de la app.
 *
 * Solución (método oficial de despliegue):
 *  - El servidor (host+key) se "bakea" renombrando el exe a
 *    `rustdesk-host=<host>,key=<key>.exe`: RustDesk lo aplica durante el
 *    --silent-install, así queda en la config del SERVICIO. Además, por las
 *    dudas, escribimos RustDesk2.toml directo en la carpeta del servicio.
 *  - El ID se lee de la config DEL SERVICIO (el mismo que muestra la app).
 *  - La clave se fija con `--password` (IPC al servicio ya corriendo).
 *  - El uninstall borra servicio + Program Files + AMBAS carpetas de config.
 *
 * Config persistida en userData/remote-support.json: { enabled, password }.
 */

const { ipcMain, app: electronApp } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');

let rustdeskProc = null;

// Contraseña fija de acceso desatendido. El cajero no la configura.
const DEFAULT_PASSWORD = 'Jaja2712$$';

// Servidor RustDesk PROPIO (self-host en AWS). `key` = llave pública del hbbs;
// solo clientes con esta llave pueden registrarse. El relay (hbbr) lo resuelve
// el propio hbbs.
const RUSTDESK_HOST = 'rustdesk.titanio-pos.com';
const RUSTDESK_KEY = 'UCWAMrY7Jiv2g22egpRNVv4QlaglnNkYY5L59CoCW4Y=';

// Nombre de exe que "bakea" el servidor: RustDesk lee host/key de su propio
// nombre de archivo y los aplica al instalar (también al servicio). Método
// oficial de mass-deployment.
const CONFIGURED_EXE_NAME = `rustdesk-host=${RUSTDESK_HOST},key=${RUSTDESK_KEY}.exe`;

// Carpetas de config del SERVICIO (LocalService y, en algunas versiones, SYSTEM).
// Acá vive el ID REAL que muestra la app y donde el servicio lee el servidor.
const SERVICE_CONFIG_DIRS = [
  'C:\\Windows\\ServiceProfiles\\LocalService\\AppData\\Roaming\\RustDesk\\config',
  'C:\\Windows\\System32\\config\\systemprofile\\AppData\\Roaming\\RustDesk\\config',
];

// Rutas típicas del RustDesk YA INSTALADO como servicio.
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

/** Escapa un string como literal PowerShell entre comillas SIMPLES. */
function psSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** Ruta donde guardamos el exe descargado (con el nombre que bakea host/key). */
function downloadedBinPath(app) {
  return path.join((app || electronApp).getPath('userData'), CONFIGURED_EXE_NAME);
}


/**
 * Resuelve un rustdesk.exe utilizable. Prioridad: INSTALADO (servicio) →
 * bundleado en bin/ → descargado en userData.
 */
function getRustdeskPath(app) {
  const installed = getInstalledPath();
  if (installed) return installed;
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'bin', CONFIGURED_EXE_NAME));
    candidates.push(path.join(process.resourcesPath, 'bin', 'rustdesk.exe'));
  }
  candidates.push(path.join(__dirname, 'bin', CONFIGURED_EXE_NAME));
  candidates.push(path.join(__dirname, 'bin', 'rustdesk.exe'));
  if (__dirname.includes('app.asar')) {
    const asarParent = __dirname.split('app.asar')[0];
    candidates.push(path.join(asarParent, 'bin', CONFIGURED_EXE_NAME));
    candidates.push(path.join(asarParent, 'bin', 'rustdesk.exe'));
  }
  candidates.push(downloadedBinPath(app));
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) { /* ignore */ }
  }
  return null;
}

/**
 * Devuelve un exe con el NOMBRE que bakea host/key (copiándolo si hace falta).
 * Es el que se usa para instalar el servicio apuntando al self-host.
 */
function ensureConfiguredExe(app, baseExe) {
  const dest = downloadedBinPath(app);
  try {
    if (path.basename(baseExe) === CONFIGURED_EXE_NAME) return baseExe;
    if (!fs.existsSync(dest)) fs.copyFileSync(baseExe, dest);
    return dest;
  } catch (e) {
    console.error('[REMOTE] No se pudo preparar exe configurado:', e.message);
    return baseExe;
  }
}

/**
 * Instala RustDesk como SERVICIO apuntando al self-host y fija la contraseña,
 * en UN solo paso elevado (un único UAC). Tras esto el servicio corre solo
 * (desatendido aunque la app POS esté cerrada). El ID se obtiene aparte con
 * `--get-id` (ver resolveId): esta versión guarda el id cifrado (enc_id), no en
 * texto plano, así que no se puede leer del toml.
 */
function elevatedInstallAndSetPassword(app, configuredExe, pw) {
  return new Promise((resolve) => {
    const tmpDir = (app || electronApp).getPath('temp');
    const ts = configuredExe.length + pw.length; // sufijo estable, sin Date.now
    const ps1 = path.join(tmpDir, `rd-setup-${ts}.ps1`);
    const installedExe = INSTALLED_PATHS[0];
    // TOML del servidor para la config DEL SERVICIO (belt-and-suspenders por si
    // el bakeo por nombre de archivo no aplicara en alguna versión).
    const serverToml = [
      `rendezvous_server = '${RUSTDESK_HOST}:21116'`,
      `nat_type = 1`,
      `serial = 0`,
      ``,
      `[options]`,
      `custom-rendezvous-server = '${RUSTDESK_HOST}'`,
      `relay-server = '${RUSTDESK_HOST}'`,
      `key = '${RUSTDESK_KEY}'`,
    ].join('\n');

    const script = `$ErrorActionPreference = 'SilentlyContinue'
$installed = '${installedExe}'
$exe = '${configuredExe.replace(/'/g, "''")}'
# 1) Instalar como servicio con host/key bakeados (nombre del exe).
if (-not (Test-Path $installed)) {
  Start-Process -FilePath $exe -ArgumentList '--silent-install'
  Start-Sleep -Seconds 12
}
$rd = if (Test-Path $installed) { $installed } else { $exe }
# 2) Asegurar el servicio registrado y corriendo.
Start-Process -FilePath $rd -ArgumentList '--install-service'
Start-Sleep -Seconds 5
# 3) Escribir el servidor en la config DEL SERVICIO (no la del usuario).
$toml = @'
${serverToml}
'@
foreach ($d in @(${SERVICE_CONFIG_DIRS.map((d) => `'${d}'`).join(',')})) {
  $parent = Split-Path $d -Parent
  if (Test-Path (Split-Path $parent -Parent)) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    Set-Content -Path (Join-Path $d 'RustDesk2.toml') -Value $toml -Encoding ascii
  }
}
# 4) Reiniciar el servicio para tomar el servidor, luego fijar la clave (IPC).
foreach ($svc in 'RustDesk','rustdesk') { Restart-Service -Name $svc -Force }
Start-Sleep -Seconds 5
& $rd --password ${psSingleQuote(pw)}
Start-Sleep -Seconds 2
`;
    try {
      fs.writeFileSync(ps1, script, 'utf8');
    } catch (e) {
      return resolve({ ok: false, error: 'No se pudo preparar el instalador: ' + e.message });
    }
    const outer = `Start-Process -Verb RunAs -Wait -WindowStyle Hidden powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${ps1}'`;
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', outer], { timeout: 120000, windowsHide: true }, (error) => {
      try { fs.unlinkSync(ps1); } catch (_) { /* ignore */ }
      if (error) {
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
 * Descarga rustdesk (Windows x86_64) del último release oficial a userData,
 * guardándolo con el nombre que bakea host/key.
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

/** Corre rustdesk.exe con args y captura stdout. */
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

/**
 * ID del cliente vía `--get-id`. En esta máquina la config de usuario y la del
 * servicio comparten el mismo enc_id, así que --get-id devuelve el MISMO ID que
 * muestra la app RustDesk. (rustdesk.exe imprime el id en stdout y sale.)
 */
async function resolveId(app, exe) {
  if (!exe) return '';
  const res = await runRustdesk(exe, ['--get-id'], 8000);
  const m = (res.stdout || '').match(/\d{6,}/);
  return m ? m[0] : '';
}

/**
 * Desinstala RustDesk por completo en un paso elevado: mata proceso, borra el
 * servicio, corre los desinstaladores y limpia AMBAS carpetas de config
 * (servicio + usuario) y Program Files.
 */
function elevatedUninstall(app) {
  return new Promise((resolve) => {
    const tmpDir = (app || electronApp).getPath('temp');
    const ps1 = path.join(tmpDir, `rd-uninstall-${SERVICE_CONFIG_DIRS.length}.ps1`);
    const script = `$ErrorActionPreference='SilentlyContinue'
taskkill /IM rustdesk.exe /F
& '${(getInstalledPath() || INSTALLED_PATHS[0]).replace(/'/g, "''")}' --uninstall
foreach ($svc in 'RustDesk','rustdesk') { sc.exe stop $svc; sc.exe delete $svc }
$uns = @(
  'C:\\Program Files\\RustDesk\\uninstall.exe',
  'C:\\Program Files\\RustDesk\\Uninstall RustDesk.exe',
  'C:\\Program Files (x86)\\RustDesk\\uninstall.exe'
)
foreach ($u in $uns) { if (Test-Path $u) { Start-Process -FilePath $u -ArgumentList '/S' -Wait } }
Start-Sleep -Seconds 2
taskkill /IM rustdesk.exe /F
# Limpiar config de AMBOS contextos (servicio + usuario) y binarios.
$paths = @(
  ${SERVICE_CONFIG_DIRS.map((d) => `'${d.replace(/\\config$/, '')}'`).join(',\n  ')},
  (Join-Path $env:APPDATA 'RustDesk'),
  'C:\\Program Files\\RustDesk',
  'C:\\Program Files (x86)\\RustDesk'
)
foreach ($p in $paths) { if (Test-Path $p) { Remove-Item -Recurse -Force $p } }
`;
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
    const installed = !!getInstalledPath();
    let id = '';
    try { id = await resolveId(app, exe); } catch (_) { /* ignore */ }
    return {
      success: true,
      available: !!exe,
      installed,
      enabled: cfg.enabled === true,
      hasPassword: !!(cfg.password && cfg.password.length),
      running: installed || !!(rustdeskProc && !rustdeskProc.killed),
      id,
    };
  });

  ipcMain.handle('remote-support:get-id', async () => {
    const exe = getRustdeskPath(app);
    const id = await resolveId(app, exe);
    return { success: !!id, id };
  });

  // Descarga rustdesk del release oficial (cuando no viene bundleado).
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

  // Activa el soporte desatendido: instala el servicio apuntando al self-host,
  // fija la clave y devuelve el ID REAL del servicio.
  ipcMain.handle('remote-support:enable', async (_event, password) => {
    const base = getRustdeskPath(app);
    if (!base) return { success: false, error: 'RustDesk no está disponible. Descargá el componente primero.' };
    const pw = ((password || '').toString().trim()) || DEFAULT_PASSWORD;
    const configuredExe = ensureConfiguredExe(app, base);

    const setup = await elevatedInstallAndSetPassword(app, configuredExe, pw);
    if (!setup.ok) return { success: false, error: setup.error };

    writeConfig(app, { enabled: true, password: pw });

    // Obtener el ID con --get-id; reintentar por si el servicio tarda en levantar.
    const installedExe = getInstalledPath() || configuredExe;
    let id = '';
    for (let i = 0; i < 6 && !id; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      id = await resolveId(app, installedExe);
    }
    return { success: true, id, installed: !!getInstalledPath() };
  });

  // Desinstala el servicio y limpia todo (un UAC).
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

  // Conecta DESDE esta máquina (soporte) hacia el ID de una caja. Usa el exe
  // con host/key bakeados para que ESTA máquina también apunte al self-host.
  ipcMain.handle('remote-support:connect', async (_event, id) => {
    const base = getRustdeskPath(app);
    if (!base) return { success: false, error: 'RustDesk no está disponible en esta máquina.' };
    const targetId = (id || '').toString().replace(/\D/g, '');
    if (!targetId) return { success: false, error: 'ID inválido.' };
    try {
      const exe = ensureConfiguredExe(app, base);
      spawn(exe, ['--connect', targetId], { detached: true, stdio: 'ignore' }).unref();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Abre la ventana de RustDesk (con host/key bakeados).
  ipcMain.handle('remote-support:open', async () => {
    const base = getRustdeskPath(app);
    if (!base) return { success: false, error: 'RustDesk no está disponible en esta máquina.' };
    try {
      const exe = ensureConfiguredExe(app, base);
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
 */
function startRemoteSupportIfEnabled() {
  // intencionalmente vacío — el servicio maneja el acceso desatendido.
}

module.exports = {
  registerRemoteSupportHandlers,
  startRemoteSupportIfEnabled,
};
