<#
  Register (idempotently) the ~2-minute, windowless Scheduled Task that runs the
  OWNER screenshot cycle (full sidecar, DB mode). Mirrors the teammate task —
  before this, the owner machine only captured once per 10-minute sync, so short
  email checks were never on screen at capture time.

  Run once:  powershell -ExecutionPolicy Bypass -File scripts\register-owner-screenshot-task.ps1
  Remove:    Unregister-ScheduledTask -TaskName "AshfordSky-TimeTracker-OwnerShot" -Confirm:$false
#>
$ErrorActionPreference = 'Stop'
$scripts = $PSScriptRoot
$vbs = Join-Path $scripts 'owner-screenshot-hidden.vbs'
$name = 'AshfordSky-TimeTracker-OwnerShot'
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Ashford Sky Time Tracker: every ~2 min on the owner machine, capture + OCR the active window when its block needs attribution evidence (runs scripts\run-owner-screenshot.ps1 windowless).</Description></RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>2024-01-01T00:01:00</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition><Interval>PT2M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>$env:USERDOMAIN\$env:USERNAME</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>"$vbs"</Arguments></Exec></Actions>
</Task>
"@
Register-ScheduledTask -TaskName $name -Xml $xml -Force | Out-Null
Write-Host "Registered $name (every 2 min)."
