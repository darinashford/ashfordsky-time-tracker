<#
  Remote maintenance for teammate machines — THE channel for fixing their setup
  without anyone touching PowerShell on that machine.

  run-agent.ps1 executes this every 10-minute cycle, always from the freshly
  synced repo — so any change pushed to main lands on every teammate machine
  within ~10 minutes. Everything here MUST be idempotent (it runs constantly).

  Current duties:
    1. Ensure the screenshot OCR task exists (machines installed before it shipped).
    2. Ensure both scheduled tasks are enabled (someone clicking "Disable" in Task
       Scheduler would otherwise silently kill tracking).
  Add future machine-side fixes here; never ask a teammate to run anything.
#>
$ErrorActionPreference = 'Continue'
$scripts = $PSScriptRoot

# 1) Screenshot task exists?
if (-not (Get-ScheduledTask -TaskName 'AshfordSky-TimeTracker-Screenshot' -ErrorAction SilentlyContinue)) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts 'register-screenshot-task.ps1')
  Write-Output 'maintenance: registered missing screenshot task'
}

# 2) Both tasks enabled?
foreach ($name in @('AshfordSky-TimeTracker-Agent', 'AshfordSky-TimeTracker-Screenshot')) {
  $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($t -and $t.State -eq 'Disabled') {
    Enable-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue | Out-Null
    Write-Output "maintenance: re-enabled $name"
  }
}
