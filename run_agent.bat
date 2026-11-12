@echo off
title OS Telemetry Agent - Task Manager Monitor
echo ========================================================
echo   KHOI DONG OS AGENT - HE DIEU HANH TELEMETRY DAEMON
echo ========================================================
echo Dang kiem tra Python va thu vien psutil...
python -m pip install --quiet psutil
echo.
echo Khoi dong OS Agent lay so lieu that 100% tu Windows...
python system_agent.py
pause
