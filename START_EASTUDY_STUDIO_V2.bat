@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where py >nul 2>&1 || (
  echo 启动失败：未找到 Python Launcher。
  pause
  exit /b 1
)
where ffmpeg >nul 2>&1 || (
  echo 启动失败：未找到 FFmpeg。请将 ffmpeg 和 ffprobe 加入 PATH。
  pause
  exit /b 1
)
py -3.14 -c "import faster_whisper" >nul 2>&1 || (
  echo 启动失败：Python 3.14 中未安装 faster-whisper。
  echo 请运行：py -3.14 -m pip install faster-whisper
  pause
  exit /b 1
)

powershell -NoProfile -Command "try { Invoke-WebRequest 'http://127.0.0.1:8788/health' -UseBasicParsing -TimeoutSec 1 ^| Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 start "Eastudy Studio Worker - 请保持开启" /D "%~dp0services\local-studio" cmd /k "py -3.14 server.py"

powershell -NoProfile -Command "try { Invoke-WebRequest 'http://127.0.0.1:8080/' -UseBasicParsing -TimeoutSec 1 ^| Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 start "Eastudy Web - 请保持开启" /D "%~dp0" cmd /k "py -3.14 -m http.server 8080 --bind 127.0.0.1"

for /l %%I in (1,1,20) do (
  powershell -NoProfile -Command "try { Invoke-WebRequest 'http://127.0.0.1:8788/health' -UseBasicParsing -TimeoutSec 1 ^| Out-Null; Invoke-WebRequest 'http://127.0.0.1:8080/admin/' -UseBasicParsing -TimeoutSec 1 ^| Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1 && goto ready
  timeout /t 1 /nobreak >nul
)
echo 启动失败：本地网页或智能处理服务没有响应。
pause
exit /b 1

:ready
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME%" (
  start "" "%CHROME%" "http://127.0.0.1:8080/admin/?studio=v2"
) else (
  start "" "http://127.0.0.1:8080/admin/?studio=v2"
)
echo Eastudy Studio V2 已启动。
endlocal
