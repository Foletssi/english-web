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
if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 5MB) {
    $archive = Join-Path $runtime ("worker-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Move-Item -LiteralPath $logPath -Destination $archive
}

if (-not $env:EASTUDY_ASR_DEVICE) { $env:EASTUDY_ASR_DEVICE = 'cuda' }
if (-not $env:EASTUDY_ASR_COMPUTE) { $env:EASTUDY_ASR_COMPUTE = 'float16' }
if (-not $env:EASTUDY_AI_CONCURRENCY) { $env:EASTUDY_AI_CONCURRENCY = '3' }
if (-not $env:EASTUDY_AI_ATTEMPTS) { $env:EASTUDY_AI_ATTEMPTS = '3' }
if (-not $env:EASTUDY_UPLOAD_CONCURRENCY) { $env:EASTUDY_UPLOAD_CONCURRENCY = '6' }

try {
    & py -3.12 services\cloud-worker\worker.py 2>&1 | Tee-Object -FilePath $logPath -Append
    $workerExitCode = $LASTEXITCODE
    Add-Content -LiteralPath $logPath -Value ("[{0}] worker exit code: {1}" -f (Get-Date -Format o), $workerExitCode)
    exit $workerExitCode
}
finally {
    try { $workerMutex.ReleaseMutex() } catch {}
    $workerMutex.Dispose()
}
