param([Parameter(Mandatory=$true)][string]$SupabaseCli, [switch]$Installed)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$parts = @('begin;', "set local lock_timeout='3s';", "set local statement_timeout='30s';")
if (-not $Installed) {
    $migrations = @(
        '20260917220000_local_first_inputs.sql',
        '20260917221000_local_input_recovery.sql',
        '20260917221500_local_source_consumers.sql',
        '20260917222000_processing_commit_receipts.sql',
        '20260917223000_local_storage_status.sql'
    )
    foreach ($name in $migrations) {
        $migration = Get-Content -LiteralPath (Join-Path $projectRoot ('supabase/migrations/' + $name)) -Raw
        $parts += ($migration -replace '(?m)^begin;\s*$', '' -replace '(?m)^commit;\s*$', '')
    }
}
$parts += Get-Content -LiteralPath (Join-Path $projectRoot 'audit/local_input_recovery_sql_fixture.sql') -Raw
$parts += Get-Content -LiteralPath (Join-Path $projectRoot 'audit/processing_commit_receipt_sql_fixture.sql') -Raw
$parts += Get-Content -LiteralPath (Join-Path $projectRoot 'audit/processing_control_sql_fixture.sql') -Raw
$parts += Get-Content -LiteralPath (Join-Path $projectRoot 'audit/processing_wrapper_sql_fixture.sql') -Raw
$parts += 'rollback;'
$tempPath = [System.IO.Path]::GetTempFileName()
try {
    [System.IO.File]::WriteAllText($tempPath, ($parts -join "`n"), [System.Text.UTF8Encoding]::new($false))
    & $SupabaseCli db query --linked --file $tempPath --output json
    if ($LASTEXITCODE -ne 0) { throw 'Local input rollback regression failed.' }
    Write-Output 'Local input recovery, commit receipt, control and wrapper checks passed; fixture changes rolled back.'
} finally {
    Remove-Item -LiteralPath $tempPath -Force
}
