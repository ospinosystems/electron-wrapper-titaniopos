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
!macroend

!macro customUnInstall
  ; Clean up Defender exclusions on uninstall so we don't leave a dangling
  ; rule pointing at a missing path. Power plan stays — the user may want
  ; High Performance anyway.
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-MpPreference -ExclusionPath \"$INSTDIR\" -ErrorAction SilentlyContinue"'
  Pop $0
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-MpPreference -ExclusionProcess \"TitanioPOS.exe\" -ErrorAction SilentlyContinue"'
  Pop $0
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-MpPreference -ExclusionPath \"$APPDATA\TitanioPOS\" -ErrorAction SilentlyContinue"'
  Pop $0
!macroend
