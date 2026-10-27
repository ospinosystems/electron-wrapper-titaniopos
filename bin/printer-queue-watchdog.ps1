# Vigilante de la cola de la tickera en modo directo. Lo corre la tarea SYSTEM
# "TitanioPOS Tickera" cada minuto (la registra rustdesk-apply-config.ps1).
#
# POR QUE: en modo directo (printer-direct-mode.ps1) el ticket va al puerto USB
# en el momento. Si la impresora deja de responder un instante (papel, tapa,
# un tirón del cable), Electron corta el envío a los 15 s y el trabajo queda
# HUÉRFANO en la cola, sosteniendo el puerto: todos los tickets siguientes
# esperan detrás aunque la impresora ya esté bien (caja 1, 2026-10-27: 32
# trabajos trabados, impresora conectada y "Normal"). En el modo normal Windows
# reintentaba solo; en el directo nadie limpiaba.
#
# QUÉ HACE: si la tickera configurada está en modo directo y tiene trabajos con
# más de $MIN_AGE_SEC segundos (en directo un ticket sano termina en segundos),
# los borra; si no se dejan borrar (puerto trabado), reinicia el spooler y
# limpia spool\PRINTERS. Sin trabajos viejos no hace nada. Nunca toca una
# impresora en modo normal. Resultado en C:\ProgramData\TitanioPOS\printer-watchdog.json
# (solo se reescribe cuando actúa, para no gastar disco cada minuto).
#
# Uso manual (PowerShell como administrador):
#   powershell -NoProfile -ExecutionPolicy Bypass -File printer-queue-watchdog.ps1 [-MinAgeSec 60] [-DryRun]
param(
  [int]$MinAgeSec = 60,
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$ATTR_DIRECT = 0x0002
$PrintersKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Print\Printers'
$ResultFile = 'C:\ProgramData\TitanioPOS\printer-watchdog.json'

function Get-ConfiguredDirectPrinters {
  $names = @()
  $files = @()
  $files += Get-ChildItem -Path 'C:\Users\*\Documents\TitanioPOS-Settings\titaniopos-settings.json' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
  $files += Get-ChildItem -Path 'C:\Users\*\OneDrive\Documents\TitanioPOS-Settings\titaniopos-settings.json' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
  foreach ($file in ($files | Select-Object -Unique)) {
    try {
      $json = Get-Content -LiteralPath $file -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
      $name = ([string]$json.thermalPrinter.printerName).Trim()
      $enabled = $false
      try { $enabled = ($json.printerDirectMode.enabled -eq $true) } catch {}
      if ($name -and $enabled -and ($names -notcontains $name)) { $names += $name }
    } catch {}
  }
  return $names
}

function Test-DirectAttribute([string]$name) {
  try {
    $reg = Get-ItemProperty -LiteralPath (Join-Path $PrintersKey $name) -ErrorAction Stop
    return (([int]$reg.Attributes) -band $ATTR_DIRECT) -ne 0
  } catch { return $false }
}

function Get-StaleJobs([string]$name, [int]$minAge) {
  $now = Get-Date
  return @(Get-PrintJob -PrinterName $name -ErrorAction SilentlyContinue | Where-Object {
    $_.SubmittedTime -and (($now - $_.SubmittedTime).TotalSeconds -ge $minAge)
  })
}

function Restart-SpoolerClean {
  $info = @{ forcedKill = $false; removedFiles = 0; running = $false; error = $null }
  try {
    try { Stop-Service -Name Spooler -Force -ErrorAction Stop } catch {}
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline -and (Get-Service -Name Spooler).Status -ne 'Stopped') { Start-Sleep -Milliseconds 500 }
    if ((Get-Service -Name Spooler).Status -ne 'Stopped') {
      $info.forcedKill = $true
      Stop-Process -Name spoolsv -Force -ErrorAction SilentlyContinue
      $deadline = (Get-Date).AddSeconds(10)
      while ((Get-Date) -lt $deadline -and (Get-Service -Name Spooler).Status -ne 'Stopped') { Start-Sleep -Milliseconds 500 }
    }
    if ((Get-Service -Name Spooler).Status -eq 'Stopped') {
      foreach ($f in @(Get-ChildItem -Path (Join-Path $env:SystemRoot 'System32\spool\PRINTERS') -Force -File -ErrorAction SilentlyContinue)) {
        try { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop; $info.removedFiles++ } catch {}
      }
    } else {
      $info.error = 'el spooler no se detuvo'
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
    $info.running = ((Get-Service -Name Spooler -ErrorAction SilentlyContinue).Status -eq 'Running')
  }
  return $info
}

# ── Principal ────────────────────────────────────────────────────────────────
$actions = @()
foreach ($name in @(Get-ConfiguredDirectPrinters)) {
  if (-not (Test-DirectAttribute $name)) { continue }   # en modo normal Windows se encarga
  $stale = @(Get-StaleJobs $name $MinAgeSec)
  if ($stale.Count -eq 0) { continue }

  $entry = @{ printer = $name; stale = $stale.Count; oldestSec = [int](((Get-Date) - (($stale | Sort-Object SubmittedTime | Select-Object -First 1).SubmittedTime)).TotalSeconds); removed = 0; restarted = $null; remaining = $null }
  if ($DryRun) { $entry.dryRun = $true; $actions += $entry; continue }

  foreach ($job in $stale) {
    try { Remove-PrintJob -InputObject $job -ErrorAction Stop; $entry.removed++ } catch {}
  }
  Start-Sleep -Seconds 3
  $left = @(Get-StaleJobs $name $MinAgeSec)
  if ($left.Count -gt 0) {
    # Un trabajo trabado en el puerto no se deja borrar: solo reiniciar el spooler lo suelta.
    $entry.restarted = Restart-SpoolerClean
    $left = @(Get-StaleJobs $name $MinAgeSec)
  }
  $entry.remaining = $left.Count
  $actions += $entry
}

if ($actions.Count -gt 0) {
  $result = @{ at = (Get-Date -Format o); minAgeSec = $MinAgeSec; actions = $actions }
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path $ResultFile) | Out-Null
    $result | ConvertTo-Json -Depth 5 | Set-Content -Path $ResultFile -Encoding utf8
  } catch {}
  foreach ($a in $actions) { Write-Output ("WATCHDOG {0}: {1} trabajo(s) trabados, borrados {2}, quedan {3}" -f $a.printer, $a.stale, $a.removed, $a.remaining) }
}
exit 0
