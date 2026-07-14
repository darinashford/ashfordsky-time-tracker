<#
  One-time setup: register the "AshfordSky-TimeTracker-Dashboard" Scheduled Task
  so the review dashboard (http://localhost:3000) starts automatically every time
  you log in. Windowless (wscript -> dashboard-hidden.vbs -> start-dashboard.ps1),
  no admin, no stored password. Re-running is safe (idempotent via -Force).

  Remove it with:
    Unregister-ScheduledTask -TaskName "AshfordSky-TimeTracker-Dashboard" -Confirm:$false
#>
$ErrorActionPreference = 'Stop'
$name = 'AshfordSky-TimeTracker-Dashboard'
$vbs  = Join-Path $PSScriptRoot 'dashboard-hidden.vbs'

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Ashford Sky Time Tracker: start the review dashboard (localhost:3000) windowless at logon so it is always available after boot.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$env:USERDOMAIN\$env:USERNAME</UserId>
      <Delay>PT30S</Delay>
    </LogonTrigger>
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
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
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
$t = Get-ScheduledTask -TaskName $name
Write-Output "Registered '$name' - state: $($t.State); starts the dashboard ~30s after each logon. Logs: .data\dashboard.log"
