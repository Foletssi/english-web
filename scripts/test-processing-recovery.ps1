param([Parameter(Mandatory=$true)][string]$SupabaseCli, [switch]$Installed, [string]$CheckpointPath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$parts = @('begin;', "set local lock_timeout='3s';", "set local statement_timeout='60s';")
if (-not $Installed) {
    foreach ($name in @('20260919020000_admin_cover_preview.sql', '20260919021000_voice_registration_linear.sql', '20260919022000_retry_resume_position.sql')) {
        $migration = Get-Content -LiteralPath (Join-Path $projectRoot "supabase/migrations/$name") -Raw
        $parts += ($migration -replace '(?m)^begin;\s*$', '' -replace '(?m)^commit;\s*$', '')
    }
}
$parts += @'
create function pg_temp.expect_failure(p_sql text,p_expected text) returns void language plpgsql as $$
begin
  begin execute p_sql;
  exception when others then
    if sqlerrm=p_expected then return; end if;
    raise;
  end;
  raise exception 'Expected error %, but operation succeeded',p_expected;
end $$;
'@
$parts += Get-Content -LiteralPath (Join-Path $projectRoot 'audit/processing_recovery_transaction_test.sql') -Raw
$parts += Get-Content -LiteralPath (Join-Path $projectRoot 'audit/teaching_contract_versions_transaction_test.sql') -Raw
if ($CheckpointPath) {
    $checkpoint = Get-Content -LiteralPath $CheckpointPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($checkpoint.version -ne 1 -or -not $checkpoint.result -or -not $checkpoint.manifest) {
        throw 'Invalid final-output checkpoint fixture.'
    }
    $payload = @{result=$checkpoint.result; manifest=$checkpoint.manifest} | ConvertTo-Json -Depth 100 -Compress
    $parts += 'create temporary table full_commit_payload(payload jsonb) on commit drop;'
    $parts += "insert into full_commit_payload values ('$($payload.Replace("'", "''"))'::jsonb);"
    $parts += Get-Content -LiteralPath (Join-Path $projectRoot 'audit/processing_full_commit_transaction_test.sql') -Raw
}
$parts += 'rollback;'
$tempPath = [System.IO.Path]::GetTempFileName()
try {
    [System.IO.File]::WriteAllText($tempPath, ($parts -join [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))
    & $SupabaseCli db query --linked --file $tempPath --output json
    if ($LASTEXITCODE -ne 0) { throw 'Processing recovery SQL regression failed.' }
    Write-Output 'Cover access, retry state, teaching quality and voice registration passed; fixtures rolled back.'
} finally {
    Remove-Item -LiteralPath $tempPath -Force
}
