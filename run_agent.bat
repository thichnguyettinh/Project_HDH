@echo off
cd /d "%~dp0"
title OS Agent - Giam sat he thong
echo ========================================================
echo   OS AGENT - LAY SO LIEU THAT CUA HE DIEU HANH
echo ========================================================

set "PY=python"
where py >nul 2>nul && set "PY=py -3"

echo Dang kiem tra thu vien trong requirements.txt...
%PY% -m pip install --disable-pip-version-check -q -r requirements.txt
if errorlevel 1 (
  echo.
  echo [LOI] Khong cai duoc thu vien. Kiem tra lai Python va ket noi mang.
  pause
  exit /b 1
)

echo.
%PY% system_agent.py
pause
