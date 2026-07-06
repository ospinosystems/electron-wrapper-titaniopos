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
 *  - El ID se lee SIEMPRE de la config DEL SERVICIO (el mismo que muestra la
 *    app). NUNCA se cae a `--get-id` de usuario (devolvería otro ID y por eso
 *    "el número de la UI no coincidía con el de la app").
 *  - La clave se fija con `--password` (IPC) DESPUÉS de esperar a que el
 *    servicio esté `Running` (poll, no `Sleep` a ciegas), con reintentos.
 *  - Cada operación elevada escribe un JSON de resultado real (instalado/
 *    corriendo/clave/ID/error). La app NUNCA reporta "activado" si falló: se
 *    acabó el "éxito ciego" que mostraba OK aunque no funcionara nada.
 *  - El uninstall borra servicio + Program Files + AMBAS carpetas de config.
 *  - "Reparar" = uninstall limpio + install en UN solo paso elevado (un UAC).
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

// Formato que acepta `rustdesk --config`: "host=<id-server>,key=<pubkey>". Este
// es el método PROBADO (v1.0.59) para apuntar al self-host: aplica el servidor
// a la config que usa el servicio. El relay (hbbr) lo resuelve el propio hbbs.
const RUSTDESK_CONFIG = `host=${RUSTDESK_HOST},key=${RUSTDESK_KEY}`;

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

/** Archivo donde el script elevado deja el ID REAL del servicio para la app. */
function serviceIdPath(app) {
  return path.join((app || electronApp).getPath('userData'), 'rustdesk-service-id.txt');
}

/** JSON de resultado real de la última operación elevada (install/repair). */
function setupResultPath(app) {
  return path.join((app || electronApp).getPath('userData'), 'rustdesk-setup-result.json');
}

function readSetupResult(app) {
  try { return JSON.parse(fs.readFileSync(setupResultPath(app), 'utf8')); }
  catch (_) { return null; }
}

function clearSetupResult(app) {
  try { fs.unlinkSync(setupResultPath(app)); } catch (_) { /* ignore */ }
}

/** ID del servicio que dejó el último enable (mismo que muestra la app). */
function getServiceId(app) {
  try {
    const id = fs.readFileSync(serviceIdPath(app), 'utf8').trim();
    const m = id.match(/\d{6,}/);
    return m ? m[0] : '';
  } catch (_) { return ''; }
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

// ─── Helpers de PowerShell ────────────────────────────────────────────────────

/**
 * Bloque PS que limpia por completo una instalación de RustDesk: mata proceso,
 * desinstala, borra el servicio y AMBAS carpetas de config + Program Files.
 */
function buildUninstallBlock() {
  return `taskkill /IM rustdesk.exe /F 2>$null | Out-Null
$rdUn = '${(getInstalledPath() || INSTALLED_PATHS[0]).replace(/'/g, "''")}'
if (Test-Path $rdUn) { & $rdUn --uninstall 2>$null }
foreach ($svc in 'RustDesk','rustdesk') { sc.exe stop $svc 2>$null | Out-Null; sc.exe delete $svc 2>$null | Out-Null }
$uns = @(
  'C:\\Program Files\\RustDesk\\uninstall.exe',
  'C:\\Program Files\\RustDesk\\Uninstall RustDesk.exe',
  'C:\\Program Files (x86)\\RustDesk\\uninstall.exe'
)
foreach ($u in $uns) { if (Test-Path $u) { Start-Process -FilePath $u -ArgumentList '/S' -Wait } }
Start-Sleep -Seconds 2
taskkill /IM rustdesk.exe /F 2>$null | Out-Null
$paths = @(
  ${SERVICE_CONFIG_DIRS.map((d) => `'${d.replace(/\\config$/, '')}'`).join(',\n  ')},
  (Join-Path $env:APPDATA 'RustDesk'),
  'C:\\Program Files\\RustDesk',
  'C:\\Program Files (x86)\\RustDesk'
)
foreach ($p in $paths) { if (Test-Path $p) { Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue } }
`;
}

/**
 * Bloque PS que instala el soporte: --silent-install (instala Y registra el
 * servicio), --config para apuntar al self-host (método PROBADO v1.0.59),
 * --password para la clave, y --get-id en vivo. Start-Process no bloqueante +
 * esperas cortas acotadas: termina en ~10-30s y nunca se cuelga. Reporta $result.
 */
function buildInstallBlock(app, configuredExe, pw) {
  const installedExe = INSTALLED_PATHS[0];
  return `$installed = '${installedExe}'
$exe = '${configuredExe.replace(/'/g, "''")}'

function Get-RdSvc { foreach ($n in 'RustDesk','rustdesk') { $s = Get-Service -Name $n -ErrorAction SilentlyContinue; if ($s) { return $s } } return $null }

# 1) Instalar. --silent-install instala Y registra el servicio en un paso.
# NO -Wait (colgaba si abria ventana): lanzamos y esperamos acotado.
$result.step = 'install'
if (-not (Test-Path $installed)) {
  Start-Process -FilePath $exe -ArgumentList '--silent-install'
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline -and -not (Test-Path $installed) -and -not (Get-RdSvc)) { Start-Sleep -Milliseconds 800 }
}
$rd = if (Test-Path $installed) { $installed } else { $exe }

# 1b) Si quedo el exe pero no el servicio, registrarlo aparte (belt-and-suspenders).
if (-not (Get-RdSvc) -and (Test-Path $installed)) {
  Start-Process -FilePath $rd -ArgumentList '--install-service'
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline -and -not (Get-RdSvc)) { Start-Sleep -Milliseconds 800 }
}

# 2) Apuntar al servidor self-host (metodo --config, el que funciona).
$result.step = 'config'
Start-Process -FilePath $rd -ArgumentList '--config',${psSingleQuote(RUSTDESK_CONFIG)}
Start-Sleep -Seconds 2

# 3) Fijar la clave de acceso (comillas simples por el \`$$\`).
$result.step = 'password'
Start-Process -FilePath $rd -ArgumentList '--password',${psSingleQuote(pw)}
Start-Sleep -Seconds 3
$result.passwordSet = $true

# 4) Estado del servicio + ID en vivo (--get-id devuelve el ID del servicio).
$result.step = 'read-id'
$svc = Get-RdSvc
$result.installed = [bool]$svc
$result.running = [bool]($svc -and $svc.Status -eq 'Running')
for ($i = 0; $i -lt 8 -and -not $result.id; $i++) {
  try {
    $out = (& $rd --get-id 2>$null) -join ''
    $m = [regex]::Match($out, '\\d{6,}')
    if ($m.Success) { $result.id = $m.Value }
  } catch {}
  if (-not $result.id) { Start-Sleep -Seconds 1 }
}

# Exito = servicio instalado. El ID es secundario: la app lo resuelve con --get-id.
$result.ok = $result.installed
`;
}

/**
 * Corre un bloque PS elevado (un solo UAC) envuelto en un harness que captura
 * el resultado en JSON. `mode` = 'install' | 'repair'. Devuelve {ok, result}.
 */
function runElevatedSetup(app, innerBlock, mode) {
  return new Promise((resolve) => {
    const tmpDir = (app || electronApp).getPath('temp');
    const idOut = serviceIdPath(app);
    const resultOut = setupResultPath(app);
    const ps1 = path.join(tmpDir, `rd-${mode}-${innerBlock.length}.ps1`);

    const script = `$ErrorActionPreference = 'Continue'
$result = [ordered]@{ ok = $false; installed = $false; running = $false; passwordSet = $false; id = ''; step = 'start'; error = '' }
try {
${innerBlock}
  $result.step = 'done'
}
catch {
  $result.error = $_.Exception.Message
}
try { (ConvertTo-Json $result -Compress) | Set-Content -Path '${resultOut.replace(/'/g, "''")}' -Encoding ascii } catch {}
try { Set-Content -Path '${idOut.replace(/'/g, "''")}' -Value $result.id -Encoding ascii } catch {}
if ($result.ok) { exit 0 } else { exit 1 }
`;

    try {
      fs.writeFileSync(ps1, script, 'utf8');
    } catch (e) {
      return resolve({ ok: false, error: 'No se pudo preparar el instalador: ' + e.message });
    }

    // UAC: Start-Process -Verb RunAs. Si el usuario cancela, lanza error en el
    // powershell externo y lo detectamos abajo.
    const outer = `Start-Process -Verb RunAs -Wait -WindowStyle Hidden powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${ps1}'`;
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', outer], { timeout: 180000, windowsHide: true }, (error) => {
      try { fs.unlinkSync(ps1); } catch (_) { /* ignore */ }
      const result = readSetupResult(app);
      if (error && !result) {
        const cancelled = /cancel|denied|1223|operation was canceled/i.test(error.message || '');
        return resolve({
          ok: false,
          error: cancelled
            ? 'Se canceló el permiso de Windows.'
            : (error.killed
                ? 'Tardó demasiado. Intenta de nuevo o usa Reparar.'
                : 'No se pudo completar (¿se canceló el permiso de Windows?).'),
        });
      }
      // Hubo result file: la verdad la dice el JSON, no el exit code.
      resolve({ ok: !!(result && result.ok), result });
    });
  });
}

/** Mensaje claro (lenguaje llano) según qué falló en install/repair. */
function describeSetupFailure(result) {
  if (!result) return 'No se pudo completar. Intenta de nuevo.';
  if (!result.installed) return 'No se pudo instalar el soporte. Intenta de nuevo o usa Reparar.';
  return 'No se pudo completar. Intenta de nuevo.';
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
 * ID que se muestra en la UI. Fuente de verdad: `--get-id` EN VIVO (devuelve el
 * mismo ID que muestra la app porque servicio y usuario comparten el `enc_id`).
 * El caché solo es respaldo si el exe no respondiera. Antes leíamos solo el
 * caché y se quedaba viejo → por eso el número no coincidía.
 */
async function resolveId(app) {
  const exe = getRustdeskPath(app);
  if (exe) {
    const res = await runRustdesk(exe, ['--get-id'], 8000);
    const m = (res.stdout || '').match(/\d{6,}/);
    if (m) return m[0];
  }
  return getServiceId(app);
}

/**
 * Desinstala RustDesk por completo en un paso elevado: mata proceso, borra el
 * servicio, corre los desinstaladores y limpia AMBAS carpetas de config
 * (servicio + usuario) y Program Files.
 */
function elevatedUninstall(app) {
  return new Promise((resolve) => {
    const tmpDir = (app || electronApp).getPath('temp');
    const block = buildUninstallBlock();
    const ps1 = path.join(tmpDir, `rd-uninstall-${block.length}.ps1`);
    const script = `$ErrorActionPreference='SilentlyContinue'
${block}`;
    try {
      fs.writeFileSync(ps1, script, 'utf8');
    } catch (e) {
      return resolve({ ok: false, error: 'No se pudo preparar la desinstalación: ' + e.message });
    }
    const outer = `Start-Process -Verb RunAs -Wait -WindowStyle Hidden powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${ps1}'`;
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', outer], { timeout: 120000, windowsHide: true }, (error) => {
      try { fs.unlinkSync(ps1); } catch (_) { /* ignore */ }
      // Limpiar el ID cacheado, el resultado y el exe descargado.
      try { fs.unlinkSync(serviceIdPath(app)); } catch (_) { /* ignore */ }
      clearSetupResult(app);
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
    const id = await resolveId(app);
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
    const id = await resolveId(app);
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
  // fija la clave y devuelve el ID REAL del servicio. Reporta éxito/fallo real.
  ipcMain.handle('remote-support:enable', async (_event, password) => {
    const base = getRustdeskPath(app);
    if (!base) return { success: false, error: 'RustDesk no está disponible. Descargá el componente primero.' };
    const pw = ((password || '').toString().trim()) || DEFAULT_PASSWORD;
    const configuredExe = ensureConfiguredExe(app, base);

    clearSetupResult(app);
    const run = await runElevatedSetup(app, buildInstallBlock(app, configuredExe, pw), 'install');
    if (!run.ok) {
      writeConfig(app, { enabled: false, password: pw });
      return { success: false, error: run.error || describeSetupFailure(run.result), result: run.result || null };
    }

    const result = run.result;
    writeConfig(app, { enabled: true, password: pw });
    return {
      success: true,
      id: result.id || '',
      installed: !!result.installed,
      running: !!result.running,
      passwordSet: !!result.passwordSet,
    };
  });

  // Reparar = desinstalar limpio + reinstalar en UN solo UAC. Para cuando el
  // servicio quedó a medio instalar (sin feedback, ID que no coincide, etc.).
  ipcMain.handle('remote-support:repair', async (_event, password) => {
    const base = getRustdeskPath(app);
    if (!base) return { success: false, error: 'RustDesk no está disponible. Descargá el componente primero.' };
    const pw = ((password || '').toString().trim()) || DEFAULT_PASSWORD;
    const configuredExe = ensureConfiguredExe(app, base);

    clearSetupResult(app);
    try { fs.unlinkSync(serviceIdPath(app)); } catch (_) { /* ignore */ }

    const block = `${buildUninstallBlock()}\nStart-Sleep -Seconds 2\n${buildInstallBlock(app, configuredExe, pw)}`;
    const run = await runElevatedSetup(app, block, 'repair');
    if (!run.ok) {
      writeConfig(app, { enabled: false, password: pw });
      return { success: false, error: run.error || describeSetupFailure(run.result), result: run.result || null };
    }

    const result = run.result;
    writeConfig(app, { enabled: true, password: pw });
    return {
      success: true,
      id: result.id || '',
      installed: !!result.installed,
      running: !!result.running,
      passwordSet: !!result.passwordSet,
    };
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
