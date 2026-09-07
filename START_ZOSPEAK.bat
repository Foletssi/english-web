@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo Eastudy 本地学生端
echo ------------------
echo 正在启动本地网页，请稍候...
echo.

set "PY_CMD="
where py >nul 2>&1 && set "PY_CMD=py"
if not defined PY_CMD where python >nul 2>&1 && set "PY_CMD=python"
if not defined PY_CMD (
  echo 启动失败：电脑没有找到 Python。
  pause
  exit /b 1
)

powershell -NoProfile -Command "try { $r=Invoke-WebRequest 'http://127.0.0.1:8080/' -UseBasicParsing -TimeoutSec 1; if($r.StatusCode -eq 200){exit 0}; exit 1 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
  start "Eastudy Local Server - Keep Open" /D "%~dp0" cmd /k "%PY_CMD% -m http.server 8080 --bind 127.0.0.1"
)

for /l %%I in (1,1,15) do (
  powershell -NoProfile -Command "try { $r=Invoke-WebRequest 'http://127.0.0.1:8080/' -UseBasicParsing -TimeoutSec 1; if($r.StatusCode -eq 200){exit 0}; exit 1 } catch { exit 1 }" >nul 2>&1 && goto server_ready
  timeout /t 1 /nobreak >nul
)

echo 启动失败：本地网页服务没有正常响应。
pause
exit /b 1

:server_ready
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"

echo 启动成功：http://127.0.0.1:8080/
if exist "%CHROME%" (
  start "" "%CHROME%" "http://127.0.0.1:8080/?local=beta6.21.2"
) else (
  start "" "http://127.0.0.1:8080/?local=beta6.21.2"
)
endlocal
exit /b 0
