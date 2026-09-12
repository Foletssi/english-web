[CmdletBinding(SupportsShouldProcess)]
param()
$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$taskName = 'Eastudy Cloud Worker'
$launcher = Join-Path $repository 'START_EASTUDY_CLOUD_WORKER.vbs'
if (-not (Test-Path -LiteralPath $launcher)) { throw 'Hidden launcher is missing.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument "//B `"$launcher`"" -WorkingDirectory $repository
$login = New-ScheduledTaskTrigger -AtLogOn -User $identity
# Retry a stopped process even after the three crash retries expire.
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
if ($PSCmdlet.ShouldProcess($taskName, 'Install hidden logon and one-minute recovery task')) {
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) {
        $runtime = Join-Path $repository 'tmp\cloud-worker-runtime'
        New-Item -ItemType Directory -Force -Path $runtime | Out-Null
        Export-ScheduledTask -TaskName $taskName | Set-Content -LiteralPath (Join-Path $runtime ("task-backup-{0}.xml" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))) -Encoding UTF8
    }
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($login, $watchdog) `
        -Settings $settings -Principal $principal -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    Write-Output 'Eastudy hidden worker enabled: starts at login and recovers within one minute while this user is logged in.'
}
