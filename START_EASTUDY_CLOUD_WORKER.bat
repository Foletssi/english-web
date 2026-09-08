@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul || (echo Python launcher not found.& pause & exit /b 1)
py -3.12 services\cloud-worker\worker.py --check >nul 2>nul
if errorlevel 1 (
  echo Installing Eastudy Worker dependencies...
  py -3.12 -m pip install -r services\cloud-worker\requirements.txt || (pause & exit /b 1)
)
py -3.12 services\cloud-worker\worker.py
if errorlevel 1 pause
