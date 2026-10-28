@echo off
rem Lanzador de Flufy en modo dev (doble clic).
rem Llama a run.ps1 saltando la policy de PowerShell para que no pida permisos.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1"

if errorlevel 1 (
  echo.
  echo Flufy fallo. Revisa el mensaje de arriba.
  pause
)
