; TitanioPOS NSIS installer customizations.
; electron-builder oneClick NSIS runs elevated (UAC prompt at install time),
; so we have admin rights HERE — use them to do the things the runtime app
; cannot do without admin: register Defender exclusions and pin the box to
; the High Performance power plan.
;
; All commands are wrapped in IfErrors so a failure (e.g. Defender disabled
; in Group Policy, powercfg locked down) does not abort the install.

!macro customInstall
  DetailPrint "TitanioPOS: applying POS performance profile..."

  ; --- 1. Force Windows to "High Performance" power scheme. -------------
  ; Built-in GUID identical across every Windows install since Vista.
  ; On Balanced, Celeron clocks down to ~800 MHz on idle and first paint
  ; takes >1 s. High Performance keeps it pinned at base clock.
  nsExec::ExecToLog 'powercfg /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'
  Pop $0
  ${If} $0 == 0
    DetailPrint "  Power plan -> High Performance: OK"
  ${Else}
    DetailPrint "  Power plan switch failed (exit $0) — continuing"
  ${EndIf}

  ; --- 2. Defender exclusions. ------------------------------------------
  ; Real-time scanning of fiscal-server (Python reading/writing TXT every
  ; few seconds) and Electron's V8 cache murders disk IO on Celeron HDDs.
  ; Excluding the install dir + the per-user app data dir kills both.
  ; If Defender is absent/replaced, Add-MpPreference fails silently — fine.
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-MpPreference -ExclusionPath \"$INSTDIR\" -ErrorAction SilentlyContinue"'
  Pop $0
  ${If} $0 == 0
    DetailPrint "  Defender exclusion ($INSTDIR): OK"
  ${Else}
    DetailPrint "  Defender exclusion failed (exit $0) — continuing"
  ${EndIf}

  ; Exclude the executable explicitly too — Defender treats process-based
  ; and path-based exclusions independently.
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-MpPreference -ExclusionProcess \"TitanioPOS.exe\" -ErrorAction SilentlyContinue"'
  Pop $0

  ; Exclude per-user AppData where Electron stores its cache + IndexedDB.
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-MpPreference -ExclusionPath \"$APPDATA\TitanioPOS\" -ErrorAction SilentlyContinue"'
  Pop $0

  DetailPrint "TitanioPOS: performance profile applied."

  ; --- 3. RustDesk (soporte remoto desatendido). -------------------------
  ; Se instala AQUI, con los permisos de admin del instalador, para que la
  ; caja quede lista sin descargar ni activar nada desde la app. El script
  ; es idempotente (si ya esta instalado solo re-aplica servidor + clave) y
  ; un fallo NO aborta la instalacion de TitanioPOS.
  ${If} ${FileExists} "$INSTDIR\resources\bin\rustdesk.exe"
    DetailPrint "TitanioPOS: instalando soporte remoto (RustDesk)..."
    nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\bin\setup-rustdesk.ps1" -ExePath "$INSTDIR\resources\bin\rustdesk.exe"'
    Pop $0
    ${If} $0 == 0
      DetailPrint "  Soporte remoto: OK"
    ${Else}
      DetailPrint "  Soporte remoto fallo (exit $0) - la app lo reintentara al iniciar"
    ${EndIf}
  ${Else}
    DetailPrint "TitanioPOS: rustdesk.exe no incluido en este build - se omite"
  ${EndIf}
!macroend

!macro customUnInstall
  ; CLAVE PARA UPDATES RÁPIDOS: una actualización oneClick corre el desinstalador
  ; de la versión vieja ANTES de extraer la nueva. Si aquí quitáramos la exclusión
  ; de Defender (como se hacía antes SIEMPRE), la versión nueva se extraería SIN
  ; exclusión y Defender re-escanearía los ~3000 archivos estáticos (vpos 268 MB,
  ; python) en cada update — el grueso del tiempo. `${isUpdated}` es true cuando
  ; el desinstalador corre como parte de un update: en ese caso NO tocamos la
  ; exclusión, que persiste y hace la extracción de la nueva versión instantánea
  ; para Defender. Solo en una desinstalación REAL limpiamos la regla para no
  ; dejarla apuntando a un directorio que ya no existe. No agrega ningún cambio
  ; nuevo a la caja: mantiene la misma exclusión que el install ya dejó puesta.
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-MpPreference -ExclusionPath \"$INSTDIR\" -ErrorAction SilentlyContinue"'
    Pop $0
    nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-MpPreference -ExclusionProcess \"TitanioPOS.exe\" -ErrorAction SilentlyContinue"'
    Pop $0
    nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-MpPreference -ExclusionPath \"$APPDATA\TitanioPOS\" -ErrorAction SilentlyContinue"'
    Pop $0
  ${endIf}
!macroend
