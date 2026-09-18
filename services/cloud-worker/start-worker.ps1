$ErrorActionPreference = 'Stop'

$createdNew = $false
$workerMutex = [Threading.Mutex]::new($true, 'Global\EastudyCloudWorker', [ref]$createdNew)
if (-not $createdNew) {
    Write-Output 'Eastudy Worker is already running; this launch will exit.'
    exit 0
}

$repository = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repository
$runtime = Join-Path $repository 'tmp\cloud-worker-runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$logPath = Join-Path $runtime 'worker.log'
foreach ($name in @('worker.log', 'worker-error.log')) {
    $currentLog = Join-Path $runtime $name
    if ((Test-Path -LiteralPath $currentLog) -and (Get-Item -LiteralPath $currentLog).Length -gt 0) {
        $archive = Join-Path $runtime ("{0}-{1}.log" -f [IO.Path]::GetFileNameWithoutExtension($name), (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
        Move-Item -LiteralPath $currentLog -Destination $archive
    }
}

if (-not $env:EASTUDY_ASR_DEVICE) { $env:EASTUDY_ASR_DEVICE = 'cuda' }
if (-not $env:EASTUDY_ASR_COMPUTE) { $env:EASTUDY_ASR_COMPUTE = 'float16' }
if (-not $env:EASTUDY_AI_CONCURRENCY) { $env:EASTUDY_AI_CONCURRENCY = '3' }
if (-not $env:EASTUDY_AI_ATTEMPTS) { $env:EASTUDY_AI_ATTEMPTS = '3' }
if (-not $env:EASTUDY_UPLOAD_CONCURRENCY) { $env:EASTUDY_UPLOAD_CONCURRENCY = '6' }
# Scheduled tasks can retain an older environment snapshot. Refresh only the
# persisted data and ASR overrides; leave credentials in their existing channel.
foreach ($settingName in @('EASTUDY_WORK_ROOT', 'EASTUDY_ASR_MODEL_DIR', 'EASTUDY_ASR_MODEL', 'EASTUDY_ASR_DEVICE', 'EASTUDY_ASR_COMPUTE')) {
    $configuredValue = [Environment]::GetEnvironmentVariable($settingName, 'User')
    if ($configuredValue) { [Environment]::SetEnvironmentVariable($settingName, $configuredValue, 'Process') }
}
if ($env:EASTUDY_WORK_ROOT) {
    $workerTemp = Join-Path $env:EASTUDY_WORK_ROOT 'temporary'
    New-Item -ItemType Directory -Force -Path $workerTemp | Out-Null
    $env:TEMP = $workerTemp
    $env:TMP = $workerTemp
}

try {
    $python = (& py -3.12 -c 'import sys; print(sys.executable)').Trim()
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $python)) { throw 'Python 3.12 is unavailable.' }
    $env:PYTHONUNBUFFERED = '1'
    $process = Start-Process -FilePath $python -ArgumentList @('-u', 'services\cloud-worker\worker.py') `
        -WorkingDirectory $repository -WindowStyle Hidden -PassThru -Wait `
        -RedirectStandardOutput $logPath -RedirectStandardError (Join-Path $runtime 'worker-error.log')
    $workerExitCode = $process.ExitCode
    Add-Content -LiteralPath $logPath -Value ("[{0}] worker exit code: {1}" -f (Get-Date -Format o), $workerExitCode)
    exit $workerExitCode
}
finally {
    try { $workerMutex.ReleaseMutex() } catch {}
    $workerMutex.Dispose()
}
