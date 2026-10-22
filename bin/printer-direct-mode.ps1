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
# REQUIERE ADMIN. Lo corre el instalador NSIS (elevado) en cada instalacion con
# -CleanSpool, y la tarea SYSTEM de soporte remoto (rustdesk-apply-config.ps1)
# lo reaplica sin -CleanSpool por si un driver reinstalado lo quito.
# Idempotente. Nunca aborta la instalacion: exit 0 siempre.
# Deja el resultado real en C:\ProgramData\TitanioPOS\printer-direct.json.
#
# Uso manual en una caja (PowerShell como administrador):
#   powershell -NoProfile -ExecutionPolicy Bypass -File printer-direct-mode.ps1 [-PrinterName "XP-58"] [-CleanSpool] [-DryRun]
param(
  # Impresora(s) a tocar. Vacio = la tickera de titaniopos-settings.json de
  # cada usuario del equipo (seccion thermalPrinter.printerName).
  [string[]]$PrinterName = @(),
  # Detener el spooler, borrar lo guardado en spool\PRINTERS y arrancarlo de
  # nuevo. SOLO en la instalacion (post-cierre, nada imprimiendo): en horario
  # de venta borraria un ticket que este saliendo.
  [switch]$CleanSpool,
  # Solo informar, sin cambiar nada.
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'

$ATTR_QUEUED = 0x0001
$ATTR_DIRECT = 0x0002
$ATTR_KEEPPRINTEDJOBS = 0x0100
$PrintersKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Print\Printers'
$ResultDir = 'C:\ProgramData\TitanioPOS'
$ResultFile = Join-Path $ResultDir 'printer-direct.json'

$result = @{
  at = (Get-Date -Format o)
  dryRun = [bool]$DryRun
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

# Tickeras configuradas en TitanioPOS: el settings vive en Documentos del
# usuario (titaniopos-settings-file.js). Como esto corre elevado o como SYSTEM,
# se miran los Documentos de todos los usuarios, no solo los del proceso.
function Find-ConfiguredPrinters {
  $names = @()
  $candidates = @()
  try { $candidates += Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'TitanioPOS-Settings\titaniopos-settings.json' } catch {}
  if ($env:USERPROFILE) { $candidates += Join-Path $env:USERPROFILE 'Documents\TitanioPOS-Settings\titaniopos-settings.json' }
  $candidates += Get-ChildItem -Path 'C:\Users\*\Documents\TitanioPOS-Settings\titaniopos-settings.json' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
  $candidates += Get-ChildItem -Path 'C:\Users\*\OneDrive\Documents\TitanioPOS-Settings\titaniopos-settings.json' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
  foreach ($file in ($candidates | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $file)) { continue }
    try {
      $json = Get-Content -LiteralPath $file -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
      $name = [string]$json.thermalPrinter.printerName
      if ($name -and $name.Trim() -ne '' -and ($names -notcontains $name.Trim())) { $names += $name.Trim() }
    } catch {
      $script:result.errors += "settings $file : $($_.Exception.Message)"
    }
  }
  return $names
}

function Invoke-PrintUi([string]$name, [string]$attributes) {
  # rundll32 printui.dll,PrintUIEntry /Xs /n "impresora" attributes +direct
  $args = ('printui.dll,PrintUIEntry /Xs /n "{0}" attributes {1}' -f $name, $attributes)
  $p = Start-Process -FilePath 'rundll32.exe' -ArgumentList $args -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop
  return $p.ExitCode
}

function Set-DirectMode([string]$name) {
  $entry = @{ name = $name; before = $null; after = $null; changed = $false; ok = $false; via = $null; error = $null }
  if ($name -match '"') {
    $entry.error = 'nombre con comillas, omitido'
    return $entry
  }
  $before = Get-PrinterAttributes $name
  if ($null -eq $before) {
    $entry.error = 'no instalada en este equipo'
    return $entry
  }
  $entry.before = Describe-Attributes $before
  $wanted = ($before -bor $ATTR_DIRECT) -band (-bnot $ATTR_KEEPPRINTEDJOBS)
  if ($wanted -eq $before) {
    $entry.after = $entry.before
    $entry.ok = $true
    $entry.via = 'already'
    return $entry
  }
  if ($DryRun) {
    $entry.after = Describe-Attributes $wanted
    $entry.via = 'dry-run'
    return $entry
  }
  try {
    if (-not ($before -band $ATTR_DIRECT)) { [void](Invoke-PrintUi $name '+direct') }
    if ($before -band $ATTR_KEEPPRINTEDJOBS) { [void](Invoke-PrintUi $name '-keepprintedjobs') }
    $entry.via = 'printui'
  } catch {
    $entry.error = "printui: $($_.Exception.Message)"
  }
  $now = Get-PrinterAttributes $name
  $isOk = { param($a) ($a -band $ATTR_DIRECT) -and -not ($a -band $ATTR_KEEPPRINTEDJOBS) }
  if (-not (& $isOk $now)) {
    # Fallback: WMI expone Direct/KeepPrintedJobs como propiedades escribibles.
    try {
      $esc = $name -replace "'", "\'"
      $w = Get-CimInstance -ClassName Win32_Printer -Filter "Name='$esc'" -ErrorAction Stop
      if ($w) {
        Set-CimInstance -InputObject $w -Property @{ Direct = $true; KeepPrintedJobs = $false } -ErrorAction Stop
        $entry.via = 'wmi'
        $now = Get-PrinterAttributes $name
      }
    } catch {
      $entry.error = (($entry.error, "wmi: $($_.Exception.Message)") -ne $null) -join '; '
    }
  }
  $entry.after = Describe-Attributes $now
  $entry.changed = ($now -ne $before)
  $entry.ok = [bool](& $isOk $now)
  if (-not $entry.ok -and -not $entry.error) { $entry.error = 'el atributo no quedo aplicado (sin permisos de administrador?)' }
  return $entry
}

function Clear-SpoolFolder {
  $spool = Join-Path $env:SystemRoot 'System32\spool\PRINTERS'
  $info = @{ found = 0; removed = 0; error = $null; spoolerRunning = $null }
  try {
    $svc = Get-Service -Name Spooler -ErrorAction Stop
    Stop-Service -Name Spooler -Force -ErrorAction Stop
    $deadline = (Get-Date).AddSeconds(25)
    while ((Get-Date) -lt $deadline -and (Get-Service -Name Spooler).Status -ne 'Stopped') { Start-Sleep -Milliseconds 500 }
    if ((Get-Service -Name Spooler).Status -ne 'Stopped') { throw 'el spooler no se detuvo' }
    $files = @(Get-ChildItem -Path $spool -Force -File -ErrorAction SilentlyContinue)
    $info.found = $files.Count
    foreach ($f in $files) {
      try { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop; $info.removed++ } catch {}
    }
  } catch {
    $info.error = $_.Exception.Message
  } finally {
    # Pase lo que pase, el spooler vuelve a arrancar: sin el no imprime nada.
    for ($i = 0; $i -lt 3; $i++) {
      try { Start-Service -Name Spooler -ErrorAction Stop } catch {}
      $deadline = (Get-Date).AddSeconds(15)
      while ((Get-Date) -lt $deadline -and (Get-Service -Name Spooler).Status -ne 'Running') { Start-Sleep -Milliseconds 500 }
      if ((Get-Service -Name Spooler).Status -eq 'Running') { break }
    }
    $info.spoolerRunning = ((Get-Service -Name Spooler -ErrorAction SilentlyContinue).Status -eq 'Running')
  }
  return $info
}

# ── Principal ────────────────────────────────────────────────────────────────
# Con `-File`, PowerShell entrega "-PrinterName a,b" como UNA cadena: se parte aqui.
$targets = @($PrinterName | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' } | Select-Object -Unique)
if ($targets.Count -eq 0) { $targets = @(Find-ConfiguredPrinters) }

if ($targets.Count -eq 0) {
  Write-Output 'NO_PRINTER sin tickera configurada en este equipo'
} else {
  foreach ($t in $targets) {
    $e = Set-DirectMode $t
    $result.printers += $e
    if ($e.via -eq 'dry-run') {
      Write-Output ("DRY {0} before={1} would-be={2}" -f $e.name, $e.before, $e.after)
    } elseif ($e.ok) {
      Write-Output ("OK {0} {1} via={2}" -f $e.name, $e.after, $e.via)
    } else {
      Write-Output ("WARN {0} before={1} after={2} error={3}" -f $e.name, $e.before, $e.after, $e.error)
    }
  }
}

if ($CleanSpool -and -not $DryRun -and $targets.Count -gt 0) {
  $result.spool = Clear-SpoolFolder
  if ($result.spool.error) {
    Write-Output ("WARN spool error={0} spoolerRunning={1}" -f $result.spool.error, $result.spool.spoolerRunning)
  } else {
    Write-Output ("OK spool removed={0}/{1} spoolerRunning={2}" -f $result.spool.removed, $result.spool.found, $result.spool.spoolerRunning)
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
