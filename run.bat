@echo off
rem Lanzador de GuilleCode en modo dev (doble clic).
rem Llama a run.ps1 saltando la policy de PowerShell para que no pida permisos.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1"

if errorlevel 1 (
  echo.
  echo GuilleCode fallo. Revisa el mensaje de arriba.
  pause
)
