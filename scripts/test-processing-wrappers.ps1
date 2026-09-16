param([Parameter(Mandatory=$true)][string]$SupabaseCli, [switch]$BeforeFix, [switch]$Installed)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$fixture = Get-Content -LiteralPath (Join-Path $projectRoot 'audit/processing_wrapper_sql_fixture.sql') -Raw
$migration = Get-Content -LiteralPath (Join-Path $projectRoot 'supabase/migrations/20260917130000_processing_wrapper_variable_names.sql') -Raw
$parts = @('begin;', "set local lock_timeout='3s';", "set local statement_timeout='20s';")
if ($BeforeFix) {
    $parts += "set local eastudy.audit_expect_ambiguity='on';"
} elseif (-not $Installed) {
    $parts += ($migration -replace '(?m)^begin;\s*$', '' -replace '(?m)^commit;\s*$', '')
}
$parts += $fixture
$parts += 'rollback;'
# Generated SQL test payload. The committed fixture and migration remain unchanged.
$tempPath = [System.IO.Path]::GetTempFileName()
try {
    [System.IO.File]::WriteAllText($tempPath, ($parts -join "`n"), [System.Text.UTF8Encoding]::new($false))
    & $SupabaseCli db query --linked --file $tempPath --output json
    if ($LASTEXITCODE -ne 0) { throw 'Processing wrapper rollback regression failed.' }
    Write-Output 'Processing wrapper regression passed; all fixture changes rolled back.'
} finally {
    Remove-Item -LiteralPath $tempPath -Force
}
