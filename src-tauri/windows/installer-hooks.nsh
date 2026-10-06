!ifndef GUILLECODE_INSTALLER_HOOKS
!define GUILLECODE_INSTALLER_HOOKS
!define GC_ENGINE_CLEANUP "${__FILEDIR__}\stop-installed-engine.ps1"

!macro NSIS_HOOK_PREINSTALL
  ; Let Tauri close the app first, including manual upgrades from older builds.
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  Push $R0
  Push $R1
  InitPluginsDir
  File /oname=$PLUGINSDIR\stop-installed-engine.ps1 "${GC_ENGINE_CLEANUP}"
  ; -File arguments keep install paths (spaces/apostrophes included) out of code.
  nsExec::ExecToStack /TIMEOUT=30000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop-installed-engine.ps1" -InstallDir "$INSTDIR"'
  Pop $R0
  Pop $R1
  ${If} $R0 != 0
    DetailPrint "$R1"
    MessageBox MB_OK|MB_ICONSTOP "No se pudo liberar el motor de GuilleCode. Cerrá GuilleCode y reintentá la actualización." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  Pop $R1
  Pop $R0
!macroend

!endif
