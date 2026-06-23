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

/** Lista de dirs de config como literal de array PowerShell. */
function psDirsArray() {
  return SERVICE_CONFIG_DIRS.map((d) => `'${d}'`).join(',');
}

/** TOML del servidor para la config DEL SERVICIO (host/key self-host). */
function serverTomlBlock() {
  return [
    `rendezvous_server = '${RUSTDESK_HOST}:21116'`,
    `nat_type = 1`,
    `serial = 0`,
    ``,
    `[options]`,
    `custom-rendezvous-server = '${RUSTDESK_HOST}'`,
    `relay-server = '${RUSTDESK_HOST}'`,
    `key = '${RUSTDESK_KEY}'`,
  ].join('\n');
}

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
 * Bloque PS que instala el servicio apuntando al self-host, fija la clave y
 * lee el ID REAL — esperando a que el servicio esté Running (poll) en vez de
 * dormir a ciegas. Reporta TODO en $result.
 */
function buildInstallBlock(app, configuredExe, pw) {
  const installedExe = INSTALLED_PATHS[0];
  const serverToml = serverTomlBlock();
  return `$installed = '${installedExe}'
$exe = '${configuredExe.replace(/'/g, "''")}'

function Get-RdSvc { foreach ($n in 'RustDesk','rustdesk') { $s = Get-Service -Name $n -ErrorAction SilentlyContinue; if ($s) { return $s } } return $null }
function Wait-RdRunning([int]$timeoutSec) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    $s = Get-RdSvc
    if ($s -and $s.Status -eq 'Running') { return $true }
    Start-Sleep -Milliseconds 700
  }
  return $false
}

# 1) Instalar como servicio con host/key bakeados (nombre del exe).
# OJO: NO usar -Wait con --silent-install: si esa version abre ventana, -Wait
# cuelga para siempre ("Reparar se queda girando"). Lanzamos y hacemos poll
# acotado a que aparezca el exe instalado o el servicio.
$result.step = 'install'
if (-not (Test-Path $installed)) {
  Start-Process -FilePath $exe -ArgumentList '--silent-install'
  $deadline = (Get-Date).AddSeconds(45)
  while ((Get-Date) -lt $deadline -and -not (Test-Path $installed) -and -not (Get-RdSvc)) { Start-Sleep -Milliseconds 800 }
}
$rd = if (Test-Path $installed) { $installed } else { $exe }

# 2) Asegurar el servicio registrado (tambien con poll acotado).
$result.step = 'install-service'
if (-not (Get-RdSvc)) {
  Start-Process -FilePath $rd -ArgumentList '--install-service'
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline -and -not (Get-RdSvc)) { Start-Sleep -Milliseconds 800 }
}

# 3) Escribir el servidor en la config DEL SERVICIO (no la del usuario).
$result.step = 'server-config'
$toml = @'
${serverToml}
'@
foreach ($d in @(${psDirsArray()})) {
  $parent = Split-Path $d -Parent
  if (Test-Path (Split-Path $parent -Parent)) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    Set-Content -Path (Join-Path $d 'RustDesk2.toml') -Value $toml -Encoding ascii
  }
}

# 4) Reiniciar el servicio y ESPERAR a que esté Running (poll real).
$result.step = 'start-service'
$svc = Get-RdSvc
if ($svc) { Restart-Service -Name $svc.Name -Force -ErrorAction SilentlyContinue }
$result.running = Wait-RdRunning 40
$result.installed = [bool](Get-RdSvc)

# 5) Fijar la clave (IPC al servicio ya corriendo), con verificación + reintentos.
# Se marca OK si el toml la muestra O si '--password' salió con código 0 (el
# formato de almacenamiento varía por versión; no asumir un solo formato).
$result.step = 'password'
for ($i = 0; $i -lt 3 -and -not $result.passwordSet; $i++) {
  & $rd --password ${psSingleQuote(pw)} 2>$null
  $pwExit = $LASTEXITCODE
  Start-Sleep -Seconds 2
  if ($pwExit -eq 0) { $result.passwordSet = $true; break }
  foreach ($d in @(${psDirsArray()})) {
    $f = Join-Path $d 'RustDesk.toml'
    if (Test-Path $f) {
      if ((Get-Content $f -ErrorAction SilentlyContinue | Where-Object { $_ -match "^password\\s*=\\s*'?.+" })) { $result.passwordSet = $true; break }
    }
  }
}

# 6) Leer el ID REAL del servicio. OJO: las versiones nuevas guardan el id como
# 'enc_id' CIFRADO (no 'id=' plano), así que el toml no siempre sirve. Por eso,
# además de leer el toml, corremos '--get-id' ELEVADO: con el servicio instalado
# devuelve el ID del SERVICIO (el mismo que muestra la app), no el del usuario.
$result.step = 'read-id'
for ($i = 0; $i -lt 15 -and -not $result.id; $i++) {
  # a) toml plano (versiones viejas).
  foreach ($d in @(${psDirsArray()})) {
    $f = Join-Path $d 'RustDesk.toml'
    if (Test-Path $f) {
      $line = (Get-Content $f -ErrorAction SilentlyContinue | Where-Object { $_ -match "^id\\s*=" } | Select-Object -First 1)
      if ($line) {
        $val = ($line -replace "^id\\s*=\\s*'?","") -replace "'.*$",""
        $val = $val.Trim()
        if ($val -match '^\\d{6,}$') { $result.id = $val; break }
      }
    }
  }
  # b) --get-id elevado (versiones nuevas con enc_id cifrado).
  if (-not $result.id) {
    try {
      $out = (& $rd --get-id 2>$null) -join ''
      $m = [regex]::Match($out, '\\d{6,}')
      if ($m.Success) { $result.id = $m.Value }
    } catch {}
  }
  if (-not $result.id) { Start-Sleep -Seconds 1 }
}

# Exito = servicio instalado. El ID es secundario: si no se leyo aca, la app lo
# resuelve luego con --get-id en vivo. No fallar la activacion por falta de ID.
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
            ? 'Se canceló el permiso de administrador.'
            : (error.killed
                ? 'La operación tardó demasiado y se canceló. Reintentá o usá Reparar.'
                : 'No se pudo completar la operación (¿se canceló el permiso de administrador?).'),
        });
      }
      // Hubo result file: la verdad la dice el JSON, no el exit code.
      resolve({ ok: !!(result && result.ok), result });
    });
  });
}

/** Mensaje claro según qué falló en el resultado de install/repair. */
function describeSetupFailure(result) {
  if (!result) return 'No se pudo leer el resultado de la instalación.';
  if (result.error) return `Falló en "${result.step}": ${result.error}`;
  if (!result.installed) return 'No se pudo instalar/registrar el servicio de RustDesk. Probá "Reparar".';
  if (!result.id) return 'El servicio se instaló pero aún no devolvió un ID. Esperá unos segundos y refrescá.';
  return 'No se pudo completar la instalación del soporte remoto.';
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
