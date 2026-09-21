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
$RdKey = 'cpyYPJtZXVO4W3P28t3K1M5RiQxdpBZ+n9p81FmWVIU='
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
Start-Process -FilePath $rd -ArgumentList '--config', "host=$RdHost,key=$RdKey"
Start-Sleep -Seconds 2
# La clave se fija en el paso 2b (apply-config), desde el exe INSTALADO y con el
# servicio Running: `--password` solo lo acepta el servicio si el invocador es su
# mismo exe (auth por ruta). Aqui se deja un intento temprano por compatibilidad,
# pero el fiable es el de apply-config.

# 2b) `--config` solo escribe la config del USUARIO. La del SERVICIO (que es la
# que decide con que key se registra la caja en el hbbs) se parchea aparte; sin
# esto, una caja ya instalada conserva la key vieja y falla con "Key mismatch"
# por mas que se actualice la app.
$applyCfg = Join-Path $PSScriptRoot 'rustdesk-apply-config.ps1'
if (Test-Path $applyCfg) {
  & $applyCfg -RdHost $RdHost -RdKey $RdKey -RdPassword $RdPassword
} else {
  Write-Output 'WARN no-apply-config-script'
}

# 2c) DEJAR PLANTADA LA AUTO-REPARACION PERMANENTE (tarea SYSTEM).
# El instalador NSIS corre elevado, asi que ESTE es el momento fiable de toda la
# vida de la caja donde se puede registrar una tarea con principal
# NT AUTHORITY\SYSTEM (crearla exige un token ya elevado; el bus, con el token
# filtrado del cajero, no puede — por eso fallaba en 164 de 166). Una vez creada,
# corre como SYSTEM en cada arranque/inicio de sesion y cada 2h, sin aviso y sin
# cajero: reimpone servidor+key+clave y levanta el servicio si se cayo. Es lo que
# vuelve la caja autonoma tras UN solo toque elevado (este install, o una
# reinstalacion que haga soporte por RustDesk). Un fallo aqui NO aborta el setup.
$healTask = Join-Path $PSScriptRoot 'rustdesk-heal-task.ps1'
if (Test-Path $healTask) {
  try {
    & $healTask -Mode system -ApplyScript $applyCfg
  } catch {
    Write-Output "WARN heal-task-system: $($_.Exception.Message)"
  }
} else {
  Write-Output 'WARN no-heal-task-script'
}

$svc = Get-RdSvc
if ($svc) {
  Write-Output "OK service=$($svc.Status)"
  exit 0
}
Write-Output 'FAIL no-service'
exit 1
