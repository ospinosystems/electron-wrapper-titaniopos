; TitanioPOS NSIS installer customizations.
; electron-builder oneClick NSIS runs elevated (UAC prompt at install time),
; so we have admin rights HERE — use them to do the things the runtime app
; cannot do without admin: register Defender exclusions and pin the box to
; the High Performance power plan.
;
; ADEMÁS (fast updates): el runtime pesado (vpos-rest + python-embed, ~3000
; archivos que nunca cambian entre versiones) NO viaja como archivos sueltos
; sino como una "caja sellada" resources\runtime.7z + su huella resources\
; runtime.version. Aquí se extrae SOLO si falta o si la huella cambió; en un
; update normal se conserva (customRemoveFiles) y se salta → update rápido.

!macro customInstall
  ; ===== 0. RUNTIME (vpos + python): extraer solo si falta o cambió de huella =====
  DetailPrint "TitanioPOS: verificando runtime (vpos + python)..."

  ; Huella que TRAE este instalador (siempre presente en resources\runtime.version).
  StrCpy $R0 ""
  ClearErrors
  FileOpen $R3 "$INSTDIR\resources\runtime.version" r
  ${IfNot} ${Errors}
    FileRead $R3 $R0
    FileClose $R3
  ${EndIf}

  StrCpy $R2 "0" ; needExtract

  ; ¿Faltan las carpetas del runtime? (chequeo por un archivo conocido de cada una)
  ${IfNot} ${FileExists} "$INSTDIR\resources\vpos-rest\VposUniversal.exe"
    StrCpy $R2 "1"
  ${EndIf}
  ${IfNot} ${FileExists} "$INSTDIR\resources\python-embed\python.exe"
    StrCpy $R2 "1"
  ${EndIf}

  ; Si están, comparar la huella instalada (preservada del update) con la que trae este build.
  ${If} $R2 == "0"
    StrCpy $R1 ""
    ClearErrors
    FileOpen $R3 "$INSTDIR\resources\runtime.installed.version" r
    ${IfNot} ${Errors}
      FileRead $R3 $R1
      FileClose $R3
    ${EndIf}
    ${IfNot} "$R0" == "$R1"
      StrCpy $R2 "1"
    ${EndIf}
  ${EndIf}

  ${If} $R2 == "1"
    DetailPrint "  Runtime nuevo o ausente -> extrayendo (una vez)..."
    RMDir /r "$INSTDIR\resources\vpos-rest"
    RMDir /r "$INSTDIR\resources\python-embed"
    ; 7za.exe (portátil, ~1 MB, viaja en resources\) extrae vpos-rest/ y python-embed/
    ; dentro de resources\. No depende de plugins NSIS.
    nsExec::ExecToLog '"$INSTDIR\resources\7za.exe" x "$INSTDIR\resources\runtime.7z" -o"$INSTDIR\resources" -y'
    Pop $0
    ${If} $0 == 0
      ; Sellar el closet: escribir la huella recién instalada.
      FileOpen $R3 "$INSTDIR\resources\runtime.installed.version" w
      FileWrite $R3 "$R0"
      FileClose $R3
      DetailPrint "  Runtime instalado: OK"
    ${Else}
      DetailPrint "  ERROR extrayendo runtime (exit $0)"
    ${EndIf}
  ${Else}
    DetailPrint "  Runtime sin cambios -> conservado (update rapido)"
  ${EndIf}

  ; La caja ya no hace falta en disco (el proximo instalador trae la suya).
  Delete "$INSTDIR\resources\runtime.7z"

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

; customRemoveFiles REEMPLAZA el borrado por defecto del uninstaller. Por defecto
; electron-builder hace RMDir /r $INSTDIR (borra TODO). En un UPDATE eso borraría
; el runtime y forzaría re-extraerlo. Aquí, en update, lo PRESERVAMOS: lo movemos
; fuera de $INSTDIR (Rename = instantáneo, mismo volumen), borramos el resto, y lo
; devolvemos. Si CUALQUIER paso falla (p.ej. un archivo del runtime en uso), no es
; grave: el customInstall de la versión nueva detecta que falta y lo re-extrae
; (lento pero la caja NUNCA queda sin runtime). En desinstalación real, borra todo.
!macro customRemoveFiles
  ${if} ${isUpdated}
    RMDir /r "$INSTDIR\..\TitanioPOS-keep"
    CreateDirectory "$INSTDIR\..\TitanioPOS-keep"
    Rename "$INSTDIR\resources\vpos-rest" "$INSTDIR\..\TitanioPOS-keep\vpos-rest"
    Rename "$INSTDIR\resources\python-embed" "$INSTDIR\..\TitanioPOS-keep\python-embed"
    Rename "$INSTDIR\resources\runtime.installed.version" "$INSTDIR\..\TitanioPOS-keep\runtime.installed.version"
    RMDir /r "$INSTDIR"
    CreateDirectory "$INSTDIR\resources"
    Rename "$INSTDIR\..\TitanioPOS-keep\vpos-rest" "$INSTDIR\resources\vpos-rest"
    Rename "$INSTDIR\..\TitanioPOS-keep\python-embed" "$INSTDIR\resources\python-embed"
    Rename "$INSTDIR\..\TitanioPOS-keep\runtime.installed.version" "$INSTDIR\resources\runtime.installed.version"
    RMDir /r "$INSTDIR\..\TitanioPOS-keep"
  ${else}
    RMDir /r "$INSTDIR"
  ${endif}
!macroend

!macro customUnInstall
  ; CLAVE PARA UPDATES RÁPIDOS: una actualización oneClick corre el desinstalador
  ; de la versión vieja ANTES de extraer la nueva. Si aquí quitáramos la exclusión
  ; de Defender (como se hacía antes SIEMPRE), la versión nueva se extraería SIN
  ; exclusión y Defender re-escanearía el runtime en cada update. `${isUpdated}` es
  ; true cuando el desinstalador corre como parte de un update: en ese caso NO
  ; tocamos la exclusión, que persiste. Solo en una desinstalación REAL limpiamos.
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-MpPreference -ExclusionPath \"$INSTDIR\" -ErrorAction SilentlyContinue"'
    Pop $0
    nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-MpPreference -ExclusionProcess \"TitanioPOS.exe\" -ErrorAction SilentlyContinue"'
    Pop $0
    nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-MpPreference -ExclusionPath \"$APPDATA\TitanioPOS\" -ErrorAction SilentlyContinue"'
    Pop $0
    ; En desinstalación REAL, limpiar también el runtime preservado si quedó suelto.
    RMDir /r "$INSTDIR\..\TitanioPOS-keep"
  ${endIf}
!macroend
