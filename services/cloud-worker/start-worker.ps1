$ErrorActionPreference = 'Stop'

$repository = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repository

if (-not $env:EASTUDY_ASR_DEVICE) { $env:EASTUDY_ASR_DEVICE = 'cuda' }
if (-not $env:EASTUDY_ASR_COMPUTE) { $env:EASTUDY_ASR_COMPUTE = 'float16' }
if (-not $env:EASTUDY_AI_CONCURRENCY) { $env:EASTUDY_AI_CONCURRENCY = '3' }
if (-not $env:EASTUDY_AI_ATTEMPTS) { $env:EASTUDY_AI_ATTEMPTS = '3' }
if (-not $env:EASTUDY_UPLOAD_CONCURRENCY) { $env:EASTUDY_UPLOAD_CONCURRENCY = '6' }

& py -3.12 services\cloud-worker\worker.py
exit $LASTEXITCODE
