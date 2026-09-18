param([Parameter(Mandatory=$true)][string]$SupabaseCli, [switch]$Installed)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$parts = @('begin;', "set local lock_timeout='3s';", "set local statement_timeout='60s';")
if (-not $Installed) {
    $migration = Get-Content -LiteralPath (Join-Path $projectRoot 'supabase/migrations/20260918230000_teaching_contract_versions.sql') -Raw
    $parts += ($migration -replace '(?m)^begin;\s*$', '' -replace '(?m)^commit;\s*$', '')
}
$parts += @'
create function pg_temp.expect_failure(p_sql text,p_expected text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm=p_expected then return; end if;
    raise;
  end;
  raise exception 'Expected error %, but operation succeeded',p_expected;
end $$;
'@
$parts += Get-Content -LiteralPath (Join-Path $projectRoot 'audit/teaching_contract_versions_transaction_test.sql') -Raw
$parts += 'rollback;'
$tempPath = [System.IO.Path]::GetTempFileName()
try {
    [System.IO.File]::WriteAllText($tempPath, ($parts -join [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))
    & $SupabaseCli db query --linked --file $tempPath --output json
    if ($LASTEXITCODE -ne 0) { throw 'Teaching contract regression failed.' }
    Write-Output 'Teaching versions, quality, voice and ownership checks passed; all fixture changes rolled back.'
} finally {
    Remove-Item -LiteralPath $tempPath -Force
}
