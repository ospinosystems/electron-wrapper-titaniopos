# Registra una TAREA PROGRAMADA que repara el soporte remoto SIN cajero ni UAC.
#
# EL PROBLEMA QUE RESUELVE: la reparacion del servicio de RustDesk necesita
# admin (escribe en C:\Windows\ServiceProfiles\..., reinicia el servicio). La
# app corre como usuario (instalador per-user), asi que el unico camino era un
# Start-Process -Verb RunAs = prompt de UAC que casi ningun cajero acepta: por
# eso ~1 de cada 4 cajas quedaba "sin registrar" para siempre.
#
# LA SOLUCION: una tarea con RunLevel=Highest. En una cuenta ADMIN local se
# ejecuta ELEVADA sin mostrar UAC (asi auto-eleva Windows las tareas); y
# registrar una tarea de highest para el usuario actual NO requiere elevacion,
# asi que la app la crea sola al arrancar. En cuenta estandar la tarea corre
# sin elevar (no molesta a nadie) y hace falta un bootstrap SYSTEM aparte.
#
# -Mode user   : principal = usuario interactivo actual, RunLevel Highest.
#                Lo registra la app SIN elevacion (auto-repara cajas admin).
# -Mode system : principal = NT AUTHORITY\SYSTEM. Permanente e independiente de
#                la cuenta. Solo se puede crear desde un contexto YA elevado
#                (lo hace la propia tarea admin en su primera corrida, o la
#                reparacion elevada manual).
param(
  [ValidateSet('user', 'system')] [string]$Mode = 'user',
  [string]$ApplyScript = (Join-Path $PSScriptRoot 'rustdesk-apply-config.ps1'),
  [string]$TaskName = 'TitanioPOS Soporte Remoto'
)

$ErrorActionPreference = 'Continue'

if (-not (Test-Path $ApplyScript)) {
  Write-Output "FAIL no-apply-script $ApplyScript"
  exit 1
}

# -WaitForPassword: la tarea NO es el instalador NSIS, así que apply-config
# puede esperar al servicio y fijar la clave por defecto de forma bloqueante
# (si no, la caja se queda con la clave aleatoria de RustDesk que nadie conoce).
$psArgs = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -WaitForPassword' -f $ApplyScript

# ── Camino principal: cmdlets ScheduledTasks (Win10+) ────────────────────────
$registered = $false
try {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $psArgs

  $triggers = @()
  # Al iniciar sesion (las cajas se abren a diario) + repeticion cada 2h para
  # las que quedan encendidas, arrancando a los 3 min de registrarse.
  try { $triggers += New-ScheduledTaskTrigger -AtLogOn } catch {}
  try { $triggers += New-ScheduledTaskTrigger -AtStartup } catch {}
  $rep = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(3))
  $rep.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 2) -RepetitionDuration (New-TimeSpan -Days 3650)).Repetition
  $triggers += $rep

  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew `
    -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 5)
  try {
    $settings.DisallowStartIfOnBatteries = $false
    $settings.StopIfGoingOnBatteries = $false
  } catch {}

  if ($Mode -eq 'system') {
    $principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  } else {
    $me = "$env:USERDOMAIN\$env:USERNAME"
    $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Highest
  }

  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
    -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
  $registered = $true
  Write-Output "OK task=$TaskName mode=$Mode via=cmdlet"
} catch {
  Write-Output "WARN cmdlet-failed: $($_.Exception.Message)"
}

# ── Fallback: schtasks.exe (mas universal; -Mode user, ONLOGON, HIGHEST) ─────
if (-not $registered) {
  $tr = 'powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -WaitForPassword' -f $ApplyScript
  if ($Mode -eq 'system') {
    & schtasks.exe /create /tn "$TaskName" /tr "$tr" /sc ONLOGON /rl HIGHEST /ru 'SYSTEM' /f 2>&1 | Out-Null
  } else {
    & schtasks.exe /create /tn "$TaskName" /tr "$tr" /sc ONLOGON /rl HIGHEST /f 2>&1 | Out-Null
  }
  if ($LASTEXITCODE -eq 0) {
    $registered = $true
    Write-Output "OK task=$TaskName mode=$Mode via=schtasks"
  } else {
    Write-Output "FAIL no-se-pudo-registrar (exit $LASTEXITCODE)"
    exit 1
  }
}

# Dispararla YA para no esperar al primer trigger: la caja se repara en segundos.
try { & schtasks.exe /run /tn "$TaskName" 2>&1 | Out-Null } catch {}
exit 0
