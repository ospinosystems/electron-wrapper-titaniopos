# Reparacion del soporte remoto SIN privilegios: deja la config de USUARIO de
# RustDesk correcta y levanta el par en segundo plano.
#
# POR QUE EXISTE: reparar el SERVICIO exige admin (su config vive bajo
# C:\Windows\ServiceProfiles) y la flota NO tiene cuentas con derechos de
# administrador — medido el 15-sep-2026: la tarea de highest no se pudo crear en
# 164 de 166 cajas. Pero el par de RustDesk tambien corre como proceso de
# USUARIO y registra igual contra el hbbs (de hecho las cajas rotas "solo
# registraban al abrir la ventana de RustDesk").
#
# POR QUE NO SE USA EL CLI: `--config` y `--password` estan cerrados tras
# `is_installed() && is_root()` en core_main.rs — con cuenta estandar imprimen
# "Installation and administrative privileges required!" y no hacen NADA. Por eso
# aqui se escriben directamente los TOML de %APPDATA%, que son del propio usuario
# y no piden permiso alguno.
#
# LA CLAVE: se escribe en TEXTO PLANO y RustDesk la cifra sola al arrancar. Es el
# camino soportado; copiar una clave ya cifrada de otra maquina NO sirve, porque
# va atada al hardware de cada equipo.
#
# `--server` no tiene control de root y corre SIN ventana (verificado en
# core_main.rs), asi que no aparece nada en la pantalla del cajero.
param(
  [Parameter(Mandatory = $true)] [string]$RdHost,
  [Parameter(Mandatory = $true)] [string]$RdKey,
  [Parameter(Mandatory = $true)] [string]$RdPassword,
  [Parameter(Mandatory = $true)] [string]$ExePath
)

$ErrorActionPreference = 'Continue'

if (-not (Test-Path $ExePath)) { Write-Output "FAIL no-exe $ExePath"; exit 1 }

$cfgDir = Join-Path $env:APPDATA 'RustDesk\config'
try {
  New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
} catch {
  Write-Output "FAIL no-config-dir $($_.Exception.Message)"
  exit 1
}

# Setea `name = 'value'` dentro de [options], creando clave o seccion si faltan.
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

# Setea una clave de RAIZ (fuera de cualquier seccion), como `password`. Se
# inserta ARRIBA para no caer dentro de una seccion por accidente.
function Set-TomlRoot {
  param([string]$Content, [string]$Name, [string]$Value)
  $escaped = [regex]::Escape($Name)
  $line = "$Name = '$Value'"
  if ($Content -match "(?m)^\s*$escaped\s*=") {
    return [regex]::Replace($Content, "(?m)^\s*$escaped\s*=.*$", $line)
  }
  return "$line`n" + $Content
}

function Read-TextOrEmpty {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return '' }
  $c = Get-Content $Path -Raw -ErrorAction SilentlyContinue
  if ($null -eq $c) { return '' }
  return $c
}

# 1) RustDesk2.toml -> servidor self-host + key + clave permanente.
$toml2 = Join-Path $cfgDir 'RustDesk2.toml'
$c2 = Read-TextOrEmpty $toml2
if (Test-Path $toml2) { Copy-Item -Force $toml2 "$toml2.bak" -ErrorAction SilentlyContinue }
$c2 = Set-TomlOption -Content $c2 -Name 'key' -Value $RdKey
$c2 = Set-TomlOption -Content $c2 -Name 'custom-rendezvous-server' -Value $RdHost
$c2 = Set-TomlOption -Content $c2 -Name 'verification-method' -Value 'use-permanent-password'
Set-Content -Path $toml2 -Value $c2 -Encoding UTF8 -ErrorAction SilentlyContinue
Write-Output 'PATCHED user-RustDesk2.toml'

# 2) RustDesk.toml -> clave permanente en texto plano (RustDesk la cifra al
# arrancar). OJO: preservar `id`/`enc_id`; si se pierden, la caja estrena ID.
$toml1 = Join-Path $cfgDir 'RustDesk.toml'
$c1 = Read-TextOrEmpty $toml1
$hadEncId = $c1 -match '(?m)^\s*enc_id\s*='
if (Test-Path $toml1) { Copy-Item -Force $toml1 "$toml1.bak" -ErrorAction SilentlyContinue }
$new1 = Set-TomlRoot -Content $c1 -Name 'password' -Value $RdPassword
$keepsEncId = $new1 -match '(?m)^\s*enc_id\s*='
if ($hadEncId -and -not $keepsEncId) {
  Write-Output 'FAIL would-lose-enc-id (no se toca RustDesk.toml)'
} else {
  Set-Content -Path $toml1 -Value $new1 -Encoding UTF8 -ErrorAction SilentlyContinue
  Write-Output 'PATCHED user-RustDesk.toml (password en claro; RustDesk lo cifra al arrancar)'
}

# 3) Levantar el par en segundo plano si no hay ya un rustdesk de ESTE usuario.
# No se mata nada: el proceso del SERVICIO corre como LocalService y no es
# nuestro. Si ya hay uno del usuario, se deja (la config nueva la toma al
# reiniciarse) para no cortar una sesion de soporte en curso.
$mine = @(Get-Process -Name 'rustdesk' -ErrorAction SilentlyContinue |
  Where-Object { $_.SessionId -eq (Get-Process -Id $PID).SessionId })
if ($mine.Count -gt 0) {
  Write-Output "OK ya-corriendo pid=$($mine[0].Id)"
  exit 0
}

try {
  Start-Process -FilePath $ExePath -ArgumentList '--server' -WindowStyle Hidden -ErrorAction Stop
  Start-Sleep -Seconds 2
  $now = @(Get-Process -Name 'rustdesk' -ErrorAction SilentlyContinue)
  if ($now.Count -gt 0) {
    Write-Output 'OK server-iniciado (modo usuario, sin ventana)'
  } else {
    Write-Output 'WARN server-no-quedo-vivo'
  }
} catch {
  Write-Output "FAIL no-se-pudo-iniciar $($_.Exception.Message)"
  exit 1
}
exit 0
