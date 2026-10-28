# Registers a hidden logon task that runs start_tunnel.ps1. Run once:
#   powershell -ExecutionPolicy Bypass -File "D:\Antigravity project\AI automation\clip_story\tunnel\register_task.ps1"
$script = Join-Path $PSScriptRoot 'start_tunnel.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'ClipStoryTunnel' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'ClipStoryTunnel'
Write-Host 'ClipStoryTunnel registered and started.'
