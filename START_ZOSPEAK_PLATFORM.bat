@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo ZoSpeak Composite V1 Alpha
echo ---------------------------
echo Student: http://localhost:8080/
echo Admin:   http://localhost:8080/admin/
echo Keep this window open. Press Ctrl+C to stop.
echo.
start "" "http://localhost:8080/"
start "" "http://localhost:8080/admin/"
where py >nul 2>&1
if %errorlevel%==0 (
  py -m http.server 8080
) else (
  python -m http.server 8080
)
