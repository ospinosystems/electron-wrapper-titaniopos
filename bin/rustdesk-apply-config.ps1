# Aplica servidor+key del self-host a la config del SERVICIO de RustDesk.
#
# POR QUE ESTE SCRIPT EXISTE: el servicio corre como LocalService y lee su
# config de C:\Windows\ServiceProfiles\LocalService\...\RustDesk2.toml, que es
# un archivo DISTINTO del %APPDATA%\RustDesk del usuario. `rustdesk --config`
# escribe el del usuario que lo ejecuta — incluso elevado, porque el admin
# sigue sin ser LocalService — asi que NO cambia la key del servicio. En una
# instalacion nueva la key entra por el nombre bakeado del exe durante
# --silent-install, pero en una caja YA instalada no habia ningun mecanismo que
# la actualizara: al rotar la key del hbbs quedaban con la vieja y toda
# conexion moria con "Key mismatch".
#
# Parchea el TOML preservando el resto del archivo (en especial `enc_id`: si se
# pierde, la caja estrena ID remoto y hay que re-registrarlo).
#
# REQUIERE ADMIN. Uso manual en una caja rota:
#   powershell -NoProfile -ExecutionPolicy Bypass -File rustdesk-apply-config.ps1
param(
  [string]$RdHost = 'rustdesk.titanio-pos.com',
  [string]$RdKey = 'cpyYPJtZXVO4W3P28t3K1M5RiQxdpBZ+n9p81FmWVIU=',
  [string]$RdPassword = 'Jaja2712$$'
)

$ErrorActionPreference = 'Continue'

$ServiceConfigDirs = @(
  'C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\RustDesk\config',
  'C:\Windows\System32\config\systemprofile\AppData\Roaming\RustDesk\config'
)

function Get-RdSvc {
  foreach ($n in 'RustDesk', 'rustdesk') {
    $s = Get-Service -Name $n -ErrorAction SilentlyContinue
    if ($s) { return $s }
  }
  return $null
}

# Setea `name = 'value'` dentro de la seccion [options], creando clave o seccion
# si faltan. Devuelve el contenido nuevo.
function Set-TomlOption {
  param([string]$Content, [string]$Name, [string]$Value)

  $escaped = [regex]::Escape($Name)
  $line = "$Name = '$Value'"

  if ($Content -match "(?m)^\s*$escaped\s*=") {
    return [regex]::Replace($Content, "(?m)^\s*$escaped\s*=.*$", $line)
  }
  if ($Content -match '(?m)^\[options\]') {
    return [regex]::Replace($Content, '(?m)^\[options\]', "[options]`n$line", 1)
  }
  if ($Content.Length -gt 0 -and -not $Content.EndsWith("`n")) { $Content += "`n" }
  return $Content + "`n[options]`n$line`n"
}

$changed = $false
$touched = $false

foreach ($dir in $ServiceConfigDirs) {
  if (-not (Test-Path $dir)) { continue }
  $touched = $true
  $toml = Join-Path $dir 'RustDesk2.toml'

  $content = ''
  if (Test-Path $toml) { $content = Get-Content $toml -Raw -ErrorAction SilentlyContinue }
  if ($null -eq $content) { $content = '' }

  $prevKey = ''
  $m = [regex]::Match($content, "(?m)^\s*key\s*=\s*['`"]([^'`"]*)['`"]")
  if ($m.Success) { $prevKey = $m.Groups[1].Value }

  if ($prevKey -eq $RdKey) {
    Write-Output "OK already-current $dir"
    continue
  }

  # Backup antes de tocar: si algo sale mal, la config vieja es recuperable.
  if (Test-Path $toml) { Copy-Item -Force $toml "$toml.bak" -ErrorAction SilentlyContinue }

  $new = Set-TomlOption -Content $content -Name 'key' -Value $RdKey
  $new = Set-TomlOption -Content $new -Name 'custom-rendezvous-server' -Value $RdHost

  # Solo escribir si el resultado conserva el enc_id que hubiera (guarda contra
  # un parcheo que se coma la identidad de la caja).
  $hadEncId = $content -match '(?m)^\s*enc_id\s*='
  $keepsEncId = $new -match '(?m)^\s*enc_id\s*='
  if ($hadEncId -and -not $keepsEncId) {
    Write-Output "FAIL would-lose-enc-id $dir"
    continue
  }

  Set-Content -Path $toml -Value $new -Encoding UTF8 -ErrorAction SilentlyContinue
  Write-Output "PATCHED $dir (prev='$prevKey')"
  $changed = $true
}

if (-not $touched) {
  Write-Output 'FAIL no-service-config-dir (RustDesk no instalado o servicio nunca arrancado)'
  exit 1
}

# Reiniciar para que re-registre en el hbbs con la key nueva. Sin esto sigue
# anunciandose con la anterior y el error persiste. No basta con `$changed`:
# el TOML puede haberlo escrito otro paso (p.ej. `--config` del setup) sin que
# el proceso del servicio se reiniciara, y RustDesk solo lee la config al
# arrancar. Si el servicio arranco ANTES de la ultima escritura del TOML, sigue
# con la key vieja en memoria -> reiniciar igual.
$stale = $false
if (-not $changed) {
  $svcProc = Get-CimInstance Win32_Service -Filter "Name='RustDesk'" -ErrorAction SilentlyContinue
  if ($svcProc -and $svcProc.ProcessId -gt 0) {
    $proc = Get-Process -Id $svcProc.ProcessId -ErrorAction SilentlyContinue
    $tomlWrite = ($ServiceConfigDirs | ForEach-Object { Get-Item (Join-Path $_ 'RustDesk2.toml') -ErrorAction SilentlyContinue } | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
    if ($proc -and $tomlWrite -and $proc.StartTime -lt $tomlWrite) {
      Write-Output "STALE service started $($proc.StartTime) before config write $tomlWrite"
      $stale = $true
    }
  }
}
if ($changed -or $stale) {
  $svc = Get-RdSvc
  if ($svc) {
    # Restart-Service ya es sincrono y acotado por el SCM; sin busy-wait extra
    # porque este script corre DENTRO del instalador NSIS (nsExec bloquea) y no
    # debe demorarlo. Si el servicio tarda en re-registrar, no pasa nada: quedo
    # Automatic y termina de arrancar solo.
    Restart-Service -Name $svc.Name -Force -ErrorAction SilentlyContinue
    Write-Output "RESTARTED service=$((Get-RdSvc).Status)"
  } else {
    Write-Output 'WARN no-service-to-restart'
  }
}

# La config de USUARIO tambien importa: es la que usa el rustdesk.exe que se
# lanza para CONECTAR hacia otra caja.
$userCfg = Join-Path $env:APPDATA 'RustDesk\config\RustDesk2.toml'
if (Test-Path $userCfg) {
  $uc = Get-Content $userCfg -Raw -ErrorAction SilentlyContinue
  if ($null -ne $uc) {
    $uc = Set-TomlOption -Content $uc -Name 'key' -Value $RdKey
    $uc = Set-TomlOption -Content $uc -Name 'custom-rendezvous-server' -Value $RdHost
    Set-Content -Path $userCfg -Value $uc -Encoding UTF8 -ErrorAction SilentlyContinue
    Write-Output 'PATCHED user-config'
  }
}

# 2b-bis) Forzar CONTRASENA PERMANENTE en la config del SERVICIO. Si la caja
# quedo en "one-time password", cada conexion pide un codigo que SOLO se ve en
# la GUI -> sin la app abierta no se puede entrar. Con permanent-password la
# clave desatendida (paso 3) vale siempre. Se aplica aunque la key ya estuviera
# al dia (el bloque de arriba hace 'continue' en ese caso).
foreach ($dir in $ServiceConfigDirs) {
  if (-not (Test-Path $dir)) { continue }
  $toml = Join-Path $dir 'RustDesk2.toml'
  $content = ''
  if (Test-Path $toml) { $content = Get-Content $toml -Raw -ErrorAction SilentlyContinue }
  if ($null -eq $content) { $content = '' }
  if ($content -match "(?m)^\s*verification-method\s*=\s*['`"]use-permanent-password['`"]") { continue }
  $new = Set-TomlOption -Content $content -Name 'verification-method' -Value 'use-permanent-password'
  $hadEncId = $content -match '(?m)^\s*enc_id\s*='
  $keepsEncId = $new -match '(?m)^\s*enc_id\s*='
  if ($hadEncId -and -not $keepsEncId) { continue }
  Set-Content -Path $toml -Value $new -Encoding UTF8 -ErrorAction SilentlyContinue
  Write-Output "PATCHED verification-method $dir"
  $changed = $true
}

# 2c) Endurecer el SERVICIO para soporte DESATENDIDO (sin la app abierta).
# Sintoma real: "si no tienes RustDesk abierto no conecta". Causa: el que
# registra en el hbbs y acepta la conexion es el SERVICIO, no la GUI. Si el
# servicio no queda Automatic + Running (o muere y nadie lo levanta), solo hay
# ID cuando alguien abre la app/tray a mano. Forzamos arranque automatico,
# recuperacion ante caidas y que este Running ya mismo.
$svc = Get-RdSvc
if ($svc) {
  $svcName = $svc.Name
  # Arranque automatico y que sobreviva reinicios/caidas.
  & sc.exe config "$svcName" start= auto | Out-Null
  # Auto-restart: 5s, 10s, 30s; ventana de conteo de fallos 1 dia.
  & sc.exe failure "$svcName" reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
  $svc = Get-RdSvc
  if ($svc -and $svc.Status -ne 'Running') {
    Start-Service -Name $svcName -ErrorAction SilentlyContinue
  }
  Write-Output "SERVICE hardened start=auto status=$((Get-RdSvc).Status)"
} else {
  Write-Output 'WARN no-service-to-harden'
}

# 3) Fijar la clave desatendida. `--password` habla por IPC con el servicio y
# lo persiste en la config del SERVICIO (la que valida las conexiones), pero el
# servicio SOLO acepta ese IPC si quien lo invoca es EXACTAMENTE su mismo exe
# (auth por ruta del ejecutable). Correrlo desde una copia/portable -> el
# servicio lo rechaza ("executable mismatch") y la clave nunca se fija: por eso
# antes cada caja pedia clave al conectar. Hay que usar el exe instalado en
# Program Files y esperar a que el servicio este Running.
$Installed = 'C:\Program Files\RustDesk\rustdesk.exe'
if ((Test-Path $Installed) -and $RdPassword) {
  $svc = Get-RdSvc
  if (-not $svc -or $svc.Status -ne 'Running') {
    $svcName = if ($svc) { $svc.Name } else { 'RustDesk' }
    Start-Service -Name $svcName -ErrorAction SilentlyContinue
  }
  # NON-BLOCKING a proposito: este script corre dentro del instalador NSIS
  # (nsExec::ExecToLog BLOQUEA hasta que termina). `--password` con -Wait podia
  # colgar el instalador -> la caja quedaba sin acceso directo. Se dispara sin
  # -Wait un par de veces con esperas cortas; el modo permanente + la clave ya
  # quedaron en el TOML por archivo, y el arranque de la app reintenta.
  Start-Process -FilePath $Installed -ArgumentList '--password', $RdPassword -WindowStyle Hidden -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Start-Process -FilePath $Installed -ArgumentList '--password', $RdPassword -WindowStyle Hidden -ErrorAction SilentlyContinue
  Write-Output 'PASSWORD set-attempted'
}

# 4) Diagnostico para la app (ProgramData, legible sin elevar): el ID con el
# que registra el SERVICIO puede NO ser el del perfil del usuario (enc_id
# distinto segun el metodo de instalacion historico) — por eso habia cajas
# "sin registrar" cuyo servicio SI estaba en linea, bajo otro ID. La app cruza
# estos candidatos contra el hbbs y reporta el que de verdad responde.
try {
  $diag = @{ at = (Get-Date -Format o) }
  $svc2 = Get-RdSvc
  $diag.service = if ($svc2) { "$($svc2.Status)" } else { 'missing' }
  foreach ($dir in $ServiceConfigDirs) {
    $toml = Join-Path $dir 'RustDesk.toml'
    if (Test-Path $toml) {
      $m = Select-String -Path $toml -Pattern "^\s*id\s*=\s*'([0-9]{6,})'" | Select-Object -First 1
      if ($m) { $diag.tomlId = $m.Matches[0].Groups[1].Value }
      $diag.hasEncId = [bool](Select-String -Path $toml -Pattern '^\s*enc_id\s*=' -Quiet)
    }
  }
  if (Test-Path $Installed) {
    $out = (& $Installed --get-id 2>$null | Out-String)
    $m2 = [regex]::Match($out, '\d{6,}')
    if ($m2.Success) { $diag.getId = $m2.Value }
  }
  $dir2 = 'C:\ProgramData\TitanioPOS'
  New-Item -ItemType Directory -Force -Path $dir2 | Out-Null
  $diag | ConvertTo-Json -Compress | Set-Content -Path (Join-Path $dir2 'rustdesk-diag.json') -Encoding utf8
  Write-Output "DIAG written service=$($diag.service) tomlId=$($diag.tomlId) getId=$($diag.getId)"
} catch { Write-Output "DIAG error: $($_.Exception.Message)" }

Write-Output 'DONE'
exit 0
