param([Parameter(Mandatory=$true)][string]$ProjectRoot)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location -LiteralPath $ProjectRoot

function Invoke-Checked {
    param([string]$Program, [string[]]$Argv)
    & $Program @Argv
    if ($LASTEXITCODE -ne 0) { throw "Release check failed: $Program (exit $LASTEXITCODE)" }
}

foreach ($suite in @('audit','contract-test','deletion-test','auth-test','learning-test','test:m08')) {
    Invoke-Checked -Program 'npm.cmd' -Argv @('run',$suite)
}
foreach ($file in @(
    'audit/cloud_content_contract_test.mjs','audit/cloud_video_processing_test.mjs',
    'audit/player_loop_contract_test.mjs','audit/studio_client_contract_test.mjs',
    'audit/studio_v2_contract_test.mjs','audit/media_player_contract_test.mjs'
)) { Invoke-Checked -Program 'node' -Argv @($file) }
foreach ($directory in @('services/local-studio','services/cloud-worker')) {
    Invoke-Checked -Program 'py' -Argv @('-3.12','-m','unittest','discover','-s',$directory,'-p','test_*.py','-v')
}
Invoke-Checked -Program 'deno' -Argv @('check','supabase/functions/video-processing/index.ts')
Invoke-Checked -Program 'git' -Argv @('diff','--check')
Write-Output 'Release candidate local checks passed.'
