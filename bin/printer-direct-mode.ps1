# Pone la tickera de TitanioPOS en "Imprimir directamente en la impresora"
# (PRINTER_ATTRIBUTE_DIRECT) y le quita "Conservar documentos impresos".
#
# POR QUE: Electron entrega cada ticket al spooler de Windows, que lo guarda en
# disco (spool\PRINTERS) y lo borra al terminar. Si por lo que sea no lo borra
# (apagon, bajon, archivos retenidos), al reiniciar el spooler vuelve a mandar
# todo lo guardado: la "pila de tickets viejos" al encender la caja (VLP1 y
# Calabozo 2, oct 2026). En modo directo Windows no guarda nada en disco, asi
# que no queda nada que reenviar. Vaciar la cola desde la app (printer-queue.js)
# llega tarde: el spooler suelta la pila durante el arranque de Windows, antes
# de que exista la app.
#
# SEGURIDAD:
#  - Solo toca la tickera configurada en TitanioPOS y solo si imprime en RAW
#    (method direct/escpos, el helper winspool). Una impresora "normal/digital"
#    (method native, va por el driver) se deja como esta.
#  - No cambia driver, puerto, papel ni nada mas: un solo atributo de la
#    impresora (y quita "conservar documentos", que reimprime igual).
#  - ORDEN: primero se vacia la cola, despues se cambia el atributo. Con un
#    trabajo atascado en la cola (puerto que no responde) printui se queda
#    colgado esperando al puerto — visto en pruebas — y SetPrinter tambien.
#    Por eso: con -CleanSpool (instalador) se detiene el spooler, se borra lo
#    guardado y se arranca ANTES de tocar nada; sin -CleanSpool (tarea SYSTEM
#    en horario de venta) solo se limpia si TODOS los trabajos en cola llevan
#    mas de 10 min (cola atascada, nadie espera ese papel); si hay trabajos
#    recientes se pospone a la siguiente pasada. printui corre con tope de 20 s.
#  - Reversible: `-Revert`, o `"spoolMode": "spooled"` en la seccion
#    thermalPrinter de titaniopos-settings.json (la tarea SYSTEM lo respeta y
#    revierte sola en su siguiente pasada).
#  - El spooler SIEMPRE queda arrancado al final (reintentos; si no se detuvo
#    por las buenas se mata spoolsv.exe y se arranca de nuevo).
#  - Idempotente, nunca aborta la instalacion: exit 0 siempre.
#
# REQUIERE ADMIN para cambiar; sin admin solo informa (y confirma "already").
# Lo corre el instalador NSIS (elevado) en cada instalacion con -CleanSpool, y
# la tarea SYSTEM de soporte remoto (rustdesk-apply-config.ps1) lo reaplica sin
# -CleanSpool. Deja el resultado real en C:\ProgramData\TitanioPOS\printer-direct.json.
#
# Uso manual en una caja (PowerShell como administrador):
#   powershell -NoProfile -ExecutionPolicy Bypass -File printer-direct-mode.ps1 [-PrinterName "XP-58"] [-CleanSpool] [-Revert] [-DryRun]
param(
  # Impresora(s) a tocar (separadas por coma). Vacio = la tickera RAW de
  # titaniopos-settings.json de cada usuario del equipo.
  [string[]]$PrinterName = @(),
  # Detener el spooler, borrar lo guardado en spool\PRINTERS y arrancarlo de
  # nuevo ANTES de cambiar el modo. SOLO en la instalacion (post-cierre, nada
  # imprimiendo): en horario de venta borraria un ticket que este saliendo.
  [switch]$CleanSpool,
  # Volver al modo normal de Windows (en cola) en vez de directo.
  [switch]$Revert,
  # Solo informar, sin cambiar nada.
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'

$ATTR_QUEUED = 0x0001
$ATTR_DIRECT = 0x0002
$ATTR_KEEPPRINTEDJOBS = 0x0100
$PRINTUI_TIMEOUT_MS = 20000
$STUCK_JOB_MINUTES = 10
$PrintersKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Print\Printers'
$ResultDir = 'C:\ProgramData\TitanioPOS'
$ResultFile = Join-Path $ResultDir 'printer-direct.json'

$result = @{
  at = (Get-Date -Format o)
  dryRun = [bool]$DryRun
  revert = [bool]$Revert
  cleanSpool = [bool]$CleanSpool
  printers = @()
  spool = $null
  errors = @()
}

function Get-PrinterAttributes([string]$name) {
  $reg = Get-ItemProperty -Path (Join-Path $PrintersKey $name) -ErrorAction SilentlyContinue
  if ($null -eq $reg -or $null -eq $reg.Attributes) { return $null }
  return [int]$reg.Attributes
}

function Describe-Attributes([int]$a) {
  $flags = @()
  if ($a -band $ATTR_QUEUED) { $flags += 'queued' }
  if ($a -band $ATTR_DIRECT) { $flags += 'direct' }
  if ($a -band $ATTR_KEEPPRINTEDJOBS) { $flags += 'keepprintedjobs' }
  return ('0x{0:X} [{1}]' -f $a, ($flags -join ','))
}

# Trabajos en cola de una impresora: { count, oldestMinutes, newestMinutes }.
function Get-QueueState([string]$name) {
  $jobs = @(Get-PrintJob -PrinterName $name -ErrorAction SilentlyContinue)
  $state = @{ count = $jobs.Count; oldestMinutes = $null; newestMinutes = $null }
  if ($jobs.Count -gt 0) {
    $now = Get-Date
    $ages = $jobs | ForEach-Object { if ($_.SubmittedTime) { ($now - $_.SubmittedTime).TotalMinutes } else { 0 } }
    $state.oldestMinutes = [int]($ages | Measure-Object -Maximum).Maximum
    $state.newestMinutes = [int]($ages | Measure-Object -Minimum).Minimum
  }
  return $state
}

# Tickeras configuradas en TitanioPOS: el settings vive en Documentos del
# usuario (titaniopos-settings-file.js). Como esto corre elevado o como SYSTEM,
# se miran los Documentos de todos los usuarios, no solo los del proceso.
# Devuelve objetos { name, method, spoolMode, file }.
function Find-ConfiguredPrinters {
  $found = @()
  $candidates = @()
  try { $candidates += Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'TitanioPOS-Settings\titaniopos-settings.json' } catch {}
  if ($env:USERPROFILE) { $candidates += Join-Path $env:USERPROFILE 'Documents\TitanioPOS-Settings\titaniopos-settings.json' }
  $candidates += Get-ChildItem -Path 'C:\Users\*\Documents\TitanioPOS-Settings\titaniopos-settings.json' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
  $candidates += Get-ChildItem -Path 'C:\Users\*\OneDrive\Documents\TitanioPOS-Settings\titaniopos-settings.json' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
  foreach ($file in ($candidates | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $file)) { continue }
    try {
      $json = Get-Content -LiteralPath $file -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
      $tp = $json.thermalPrinter
      $name = [string]$tp.printerName
      if (-not $name -or $name.Trim() -eq '') { continue }
      $name = $name.Trim()
      if ($found | Where-Object { $_.name -eq $name }) { continue }
      $found += @{
        name = $name
        method = ([string]$tp.method).Trim().ToLower()
        spoolMode = ([string]$tp.spoolMode).Trim().ToLower()
        file = $file
      }
    } catch {
      $script:result.errors += "settings $file : $($_.Exception.Message)"
    }
  }
  return $found
}

# rundll32 printui.dll,PrintUIEntry /Xs /n "impresora" attributes +direct
# Con tope: con la cola atascada printui se cuelga esperando al puerto.
function Invoke-PrintUi([string]$name, [string]$attributes) {
  $args = ('printui.dll,PrintUIEntry /Xs /n "{0}" attributes {1}' -f $name, $attributes)
  $p = Start-Process -FilePath 'rundll32.exe' -ArgumentList $args -PassThru -WindowStyle Hidden -ErrorAction Stop
  if (-not $p.WaitForExit($PRINTUI_TIMEOUT_MS)) {
    try { $p.Kill() } catch {}
    throw "printui no respondio en $([int]($PRINTUI_TIMEOUT_MS / 1000)) s (cola atascada?)"
  }
  return $p.ExitCode
}

# Aplica (o revierte) el modo a UNA impresora local. Nunca lanza.
function Set-PrinterMode([string]$name, [bool]$wantDirect) {
  $entry = @{ name = $name; wantDirect = $wantDirect; before = $null; after = $null; changed = $false; ok = $false; via = $null; error = $null; queue = $null }
  if ($name -match '"') {
    $entry.error = 'nombre con comillas, omitido'
    return $entry
  }
  $before = Get-PrinterAttributes $name
  if ($null -eq $before) {
    $entry.error = 'no instalada en este equipo (o es una conexion de red)'
    return $entry
  }
  $entry.before = Describe-Attributes $before
  $isOk = {
    param($a)
    if ($wantDirect) { return (($a -band $ATTR_DIRECT) -ne 0) -and (($a -band $ATTR_KEEPPRINTEDJOBS) -eq 0) }
    return (($a -band $ATTR_DIRECT) -eq 0)
  }
  if (& $isOk $before) {
    $entry.after = $entry.before
    $entry.ok = $true
    $entry.via = 'already'
    return $entry
  }
  if ($DryRun) {
    $wanted = if ($wantDirect) { ($before -bor $ATTR_DIRECT) -band (-bnot $ATTR_KEEPPRINTEDJOBS) } else { $before -band (-bnot $ATTR_DIRECT) }
    $entry.after = Describe-Attributes $wanted
    $entry.via = 'dry-run'
    return $entry
  }
  # Con trabajos en cola no se toca: el cambio se cuelga esperando al puerto.
  # (La cola ya se limpio antes si correspondia; si quedo algo, se pospone.)
  $q = Get-QueueState $name
  $entry.queue = $q.count
  if ($q.count -gt 0) {
    $entry.after = $entry.before
    $entry.via = 'deferred'
    $entry.error = "hay $($q.count) trabajo(s) en cola; se reintenta en la proxima pasada"
    return $entry
  }
  $timedOut = $false
  try {
    if ($wantDirect) {
      if (-not ($before -band $ATTR_DIRECT)) { [void](Invoke-PrintUi $name '+direct') }
      if ($before -band $ATTR_KEEPPRINTEDJOBS) { [void](Invoke-PrintUi $name '-keepprintedjobs') }
    } else {
      [void](Invoke-PrintUi $name '-direct')
    }
    $entry.via = 'printui'
  } catch {
    $entry.error = "printui: $($_.Exception.Message)"
    $timedOut = $_.Exception.Message -match 'no respondio'
  }
  $now = Get-PrinterAttributes $name
  if (-not (& $isOk $now) -and -not $timedOut) {
    # Fallback: WMI expone Direct/KeepPrintedJobs como propiedades escribibles.
    # No se intenta tras un timeout: es la misma llamada al spooler y se colgaria igual.
    try {
      $esc = $name -replace "'", "\'"
      $w = Get-CimInstance -ClassName Win32_Printer -Filter "Name='$esc'" -ErrorAction Stop
      if ($w) {
        $props = if ($wantDirect) { @{ Direct = $true; KeepPrintedJobs = $false } } else { @{ Direct = $false } }
        Set-CimInstance -InputObject $w -Property $props -ErrorAction Stop
        $entry.via = 'wmi'
        $now = Get-PrinterAttributes $name
      }
    } catch {
      $entry.error = (@($entry.error, "wmi: $($_.Exception.Message)") | Where-Object { $_ }) -join '; '
    }
  }
  $entry.after = Describe-Attributes $now
  $entry.changed = ($now -ne $before)
  $entry.ok = [bool](& $isOk $now)
  if (-not $entry.ok -and -not $entry.error) { $entry.error = 'el atributo no quedo aplicado (sin permisos de administrador?)' }
  return $entry
}

# Detiene el spooler, borra lo guardado en spool\PRINTERS y lo arranca de nuevo.
# El spooler SIEMPRE queda arrancado al final.
function Clear-SpoolFolder([string]$why) {
  $spool = Join-Path $env:SystemRoot 'System32\spool\PRINTERS'
  $info = @{ why = $why; found = 0; removed = 0; error = $null; spoolerRunning = $null; forcedKill = $false }
  try {
    [void](Get-Service -Name Spooler -ErrorAction Stop)
    try { Stop-Service -Name Spooler -Force -ErrorAction Stop } catch { }
    $deadline = (Get-Date).AddSeconds(25)
    while ((Get-Date) -lt $deadline -and (Get-Service -Name Spooler).Status -ne 'Stopped') { Start-Sleep -Milliseconds 500 }
    if ((Get-Service -Name Spooler).Status -ne 'Stopped') {
      # Un puerto colgado puede dejar el servicio en StopPending para siempre.
      $info.forcedKill = $true
      Stop-Process -Name spoolsv -Force -ErrorAction SilentlyContinue
      $deadline = (Get-Date).AddSeconds(15)
      while ((Get-Date) -lt $deadline -and (Get-Service -Name Spooler).Status -ne 'Stopped') { Start-Sleep -Milliseconds 500 }
    }
    if ((Get-Service -Name Spooler).Status -ne 'Stopped') { throw 'el spooler no se detuvo; no se borra nada' }
    $files = @(Get-ChildItem -Path $spool -Force -File -ErrorAction SilentlyContinue)
    $info.found = $files.Count
    foreach ($f in $files) {
      try { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop; $info.removed++ } catch {}
    }
  } catch {
    $info.error = $_.Exception.Message
  } finally {
    for ($i = 0; $i -lt 4; $i++) {
      try { Start-Service -Name Spooler -ErrorAction Stop } catch {}
      $deadline = (Get-Date).AddSeconds(15)
      while ((Get-Date) -lt $deadline -and (Get-Service -Name Spooler).Status -ne 'Running') { Start-Sleep -Milliseconds 500 }
      if ((Get-Service -Name Spooler).Status -eq 'Running') { break }
      Start-Sleep -Seconds 2
    }
    $info.spoolerRunning = ((Get-Service -Name Spooler -ErrorAction SilentlyContinue).Status -eq 'Running')
    if (-not $info.spoolerRunning) { $info.error = (@($info.error, 'EL SPOOLER NO ARRANCO: reiniciar el equipo') | Where-Object { $_ }) -join '; ' }
  }
  return $info
}

# ── Principal ────────────────────────────────────────────────────────────────
# Con `-File`, PowerShell entrega "-PrinterName a,b" como UNA cadena: se parte aqui.
$manual = @($PrinterName | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' } | Select-Object -Unique)
$plan = @()
if ($manual.Count -gt 0) {
  # Manual (soporte): se hace lo que se pide, sin mirar el settings.
  foreach ($m in $manual) { $plan += @{ name = $m; wantDirect = (-not $Revert); why = 'manual' } }
} else {
  foreach ($cfg in @(Find-ConfiguredPrinters)) {
    if ($Revert -or $cfg.spoolMode -eq 'spooled') {
      $plan += @{ name = $cfg.name; wantDirect = $false; why = $(if ($Revert) { 'revert' } else { 'spoolMode=spooled' }) }
    } elseif ($cfg.method -eq 'native') {
      # Impresora normal/digital por driver: el modo directo cambia como imprime. No se toca.
      $result.printers += @{ name = $cfg.name; skipped = 'native'; ok = $true }
      Write-Output ("SKIP {0} method=native (se deja como esta)" -f $cfg.name)
    } else {
      $plan += @{ name = $cfg.name; wantDirect = $true; why = "method=$($cfg.method)" }
    }
  }
}

if ($plan.Count -eq 0 -and $result.printers.Count -eq 0) {
  Write-Output 'NO_PRINTER sin tickera configurada en este equipo'
}

# 1) Limpiar la cola ANTES de cambiar el modo (ver SEGURIDAD arriba).
$toDirect = @($plan | Where-Object { $_.wantDirect })
if (-not $DryRun -and $toDirect.Count -gt 0) {
  $pending = @()
  foreach ($p in $toDirect) {
    if ($null -eq (Get-PrinterAttributes $p.name)) { continue }
    $a = Get-PrinterAttributes $p.name
    if (($a -band $ATTR_DIRECT) -and -not ($a -band $ATTR_KEEPPRINTEDJOBS)) { continue } # ya esta: nada que limpiar
    $q = Get-QueueState $p.name
    if ($q.count -gt 0) { $pending += @{ name = $p.name; queue = $q } }
  }
  $why = $null
  if ($CleanSpool) {
    $why = 'install'
  } elseif ($pending.Count -gt 0 -and -not ($pending | Where-Object { $_.queue.newestMinutes -lt $STUCK_JOB_MINUTES })) {
    $why = 'stuck-queue'   # todo lo que hay en cola lleva > 10 min: nadie espera ese papel
  }
  if ($why) {
    $result.spool = Clear-SpoolFolder $why
    if ($result.spool.error) {
      Write-Output ("WARN spool ({0}) error={1} spoolerRunning={2}" -f $why, $result.spool.error, $result.spool.spoolerRunning)
    } else {
      Write-Output ("OK spool ({0}) removed={1}/{2} spoolerRunning={3} forcedKill={4}" -f $why, $result.spool.removed, $result.spool.found, $result.spool.spoolerRunning, $result.spool.forcedKill)
    }
  }
}

# 2) Cambiar el modo (se pospone sola si aun quedan trabajos en cola).
foreach ($p in $plan) {
  $e = Set-PrinterMode $p.name $p.wantDirect
  $e.why = $p.why
  $result.printers += $e
  if ($e.via -eq 'dry-run') {
    Write-Output ("DRY {0} before={1} would-be={2} ({3})" -f $e.name, $e.before, $e.after, $e.why)
  } elseif ($e.via -eq 'deferred') {
    Write-Output ("DEFER {0} {1} {2}" -f $e.name, $e.before, $e.error)
  } elseif ($e.ok) {
    Write-Output ("OK {0} {1} via={2} ({3})" -f $e.name, $e.after, $e.via, $e.why)
  } else {
    Write-Output ("WARN {0} before={1} after={2} error={3}" -f $e.name, $e.before, $e.after, $e.error)
  }
}

try {
  New-Item -ItemType Directory -Force -Path $ResultDir | Out-Null
  $result | ConvertTo-Json -Depth 4 | Set-Content -Path $ResultFile -Encoding utf8
} catch {
  Write-Output "WARN no se pudo escribir $ResultFile : $($_.Exception.Message)"
}

Write-Output 'DONE'
exit 0
