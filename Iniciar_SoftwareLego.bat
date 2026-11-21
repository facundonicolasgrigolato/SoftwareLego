@echo off
chcp 65001 >nul
title SoftwareLego
setlocal

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch_windows.ps1"
if errorlevel 1 (
  echo.
  echo Ocurrio un problema al iniciar SoftwareLego. Revisa el mensaje de arriba.
  pause
  exit /b 1
)
