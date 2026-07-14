<#
  One-time setup: register the "AshfordSky-TimeTracker-Sync" Windows Scheduled Task
  so the dashboard stays current automatically. Runs every 10 minutes while you're
  logged in, windowless (wscript -> sync-hidden.vbs -> sync.ps1), no admin / no
  stored password. Re-running is safe (idempotent via -Force).

  Defined via Task Scheduler XML so it doesn't depend on version-specific
  New-ScheduledTaskTrigger repetition parameters (which vary across Windows builds).

  Remove it with:
    Unregister-ScheduledTask -TaskName "AshfordSky-TimeTracker-Sync" -Confirm:$false
#>
$ErrorActionPreference = 'Stop'
$name = 'AshfordSky-TimeTracker-Sync'
$vbs  = Join-Path $PSScriptRoot 'sync-hidden.vbs'

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Ashford Sky Time Tracker: every 10 min, pull ActivityWatch -> intervals + run attribution so the dashboard stays current (runs scripts\sync.ps1 windowless).</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>2024-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT10M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$env:USERDOMAIN\$env:USERNAME</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>"$vbs"</Arguments>
    </Exec>
  </Actions>
</Task>
"@

Register-ScheduledTask -TaskName $name -Xml $xml -Force | Out-Null
Start-ScheduledTask -TaskName $name
$t = Get-ScheduledTask -TaskName $name
Write-Output "Registered '$name' - state: $($t.State); repeats every 10 min while logged in. First run started; see .data\sync.log."
