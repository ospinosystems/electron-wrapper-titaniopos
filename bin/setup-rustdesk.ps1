# Instala/configura RustDesk como servicio desatendido apuntando al self-host.
# Lo llama el instalador NSIS (ya elevado) durante el setup de TitanioPOS, y es
# idempotente: si ya esta instalado solo re-aplica servidor + clave.
#
# Debe mantenerse consistente con remote-support-handlers.js (host/key/clave).
param(
  [string]$ExePath = (Join-Path $PSScriptRoot 'rustdesk.exe')
)

$ErrorActionPreference = 'Continue'
$RdHost = 'rustdesk.titanio-pos.com'
$RdKey = 'B3i+MLo1jsm0VTNX0Rhtph2EHYGXwmZcI+caFGkMvGU='
# Clave de acceso desatendido (comillas simples: literal, no expandir $$).
$RdPassword = 'Jaja2712$$'
$Installed = 'C:\Program Files\RustDesk\rustdesk.exe'

function Get-RdSvc {
  foreach ($n in 'RustDesk', 'rustdesk') {
    $s = Get-Service -Name $n -ErrorAction SilentlyContinue
    if ($s) { return $s }
  }
  return $null
}

# 1) Instalar si falta. El nombre del exe "bakea" host/key (metodo oficial de
#    mass-deployment): RustDesk los aplica a la config del SERVICIO al instalar.
if (-not (Test-Path $Installed)) {
  if (-not (Test-Path $ExePath)) { Write-Output "NO_SOURCE $ExePath"; exit 1 }
  $cfgName = "rustdesk-host=$RdHost,key=$RdKey.exe"
  $tmpExe = Join-Path $env:TEMP $cfgName
  Copy-Item -Force $ExePath $tmpExe
  Start-Process -FilePath $tmpExe -ArgumentList '--silent-install'
  $deadline = (Get-Date).AddSeconds(45)
  while ((Get-Date) -lt $deadline -and -not (Test-Path $Installed) -and -not (Get-RdSvc)) {
    Start-Sleep -Milliseconds 800
  }
}

$rd = if (Test-Path $Installed) { $Installed } else { $ExePath }

# 1b) Exe presente pero sin servicio: registrarlo aparte (belt-and-suspenders).
if (-not (Get-RdSvc) -and (Test-Path $Installed)) {
  Start-Process -FilePath $rd -ArgumentList '--install-service'
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline -and -not (Get-RdSvc)) { Start-Sleep -Milliseconds 800 }
}

# 2) Apuntar al self-host + fijar clave (idempotente; tambien en reinstalaciones).
#    Se anota la key que TENIA el servicio: si cambio (rotacion de key del hbbs)
#    hay que reiniciarlo, porque si no sigue registrado con la vieja y las
#    conexiones fallan con "Key mismatch" aunque el servicio este corriendo.
$ServiceConfigDirs = @(
  'C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\RustDesk\config',
  'C:\Windows\System32\config\systemprofile\AppData\Roaming\RustDesk\config'
)
$prevKey = ''
foreach ($dir in $ServiceConfigDirs) {
  $toml = Join-Path $dir 'RustDesk2.toml'
  if (Test-Path $toml) {
    $m = [regex]::Match((Get-Content $toml -Raw), "(?m)^\s*key\s*=\s*['`"]([^'`"]*)['`"]")
    if ($m.Success) { $prevKey = $m.Groups[1].Value; break }
  }
}

Start-Process -FilePath $rd -ArgumentList '--config', "host=$RdHost,key=$RdKey"
Start-Sleep -Seconds 2
Start-Process -FilePath $rd -ArgumentList '--password', $RdPassword
Start-Sleep -Seconds 3

# 2b) Key rotada sobre una instalacion previa: reiniciar para re-registrar.
$svc = Get-RdSvc
if ($svc -and $prevKey -and $prevKey -ne $RdKey) {
  Write-Output "KEY_ROTATED restarting-service"
  Restart-Service -Name $svc.Name -Force -ErrorAction SilentlyContinue
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    $svc = Get-RdSvc
    if ($svc -and $svc.Status -eq 'Running') { break }
    Start-Sleep -Milliseconds 800
  }
}

$svc = Get-RdSvc
if ($svc) {
  Write-Output "OK service=$($svc.Status)"
  exit 0
}
Write-Output 'FAIL no-service'
exit 1
