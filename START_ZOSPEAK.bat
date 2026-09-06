@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo ZoSpeak Production Front-End
echo ----------------------------
echo Opening http://localhost:8080/
echo Keep this window open while using ZoSpeak.
echo Press Ctrl+C to stop.
echo.
start "" "http://localhost:8080/"
where py >nul 2>&1
if %errorlevel%==0 (
  py -m http.server 8080
) else (
  python -m http.server 8080
)
