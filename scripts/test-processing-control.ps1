param([Parameter(Mandatory=$true)][string]$SupabaseCli, [switch]$Installed)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$fixture = Get-Content -LiteralPath (Join-Path $projectRoot 'audit/processing_control_sql_fixture.sql') -Raw
$parts = @('begin;', "set local lock_timeout='3s';", "set local statement_timeout='30s';")
if (-not $Installed) {
    $migration = Get-Content -LiteralPath (Join-Path $projectRoot 'supabase/migrations/20260917160000_processing_control_commands.sql') -Raw
    $parts += ($migration -replace '(?m)^begin;\s*$', '' -replace '(?m)^commit;\s*$', '')
}
$parts += $fixture
$parts += 'rollback;'
$tempPath = [System.IO.Path]::GetTempFileName()
try {
    # Only the generated transaction payload is temporary; source uses the fixture.
    [System.IO.File]::WriteAllText($tempPath, ($parts -join "`n"), [System.Text.UTF8Encoding]::new($false))
    & $SupabaseCli db query --linked --file $tempPath --output json
    if ($LASTEXITCODE -ne 0) { throw 'Processing control rollback regression failed.' }
    Write-Output 'Processing control regression passed; all fixture changes rolled back.'
} finally {
    Remove-Item -LiteralPath $tempPath -Force
}
