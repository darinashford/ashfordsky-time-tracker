<#
  Register (idempotently) the ~2-minute, windowless Scheduled Task that runs the
  teammate screenshot loop. Called by setup-agent.ps1 on install AND by run-agent.ps1
  when the task is missing (so machines installed before screenshots existed pick it
  up automatically on their next sync — no re-install needed).
#>
$ErrorActionPreference = 'Stop'
$scripts = $PSScriptRoot
$vbs = Join-Path $scripts 'screenshot-hidden.vbs'
$name = 'AshfordSky-TimeTracker-Screenshot'
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Ashford Sky Time Tracker: every ~2 min, if the current window is an email window, OCR it locally and send only the text to the firm dashboard (token mode; runs scripts\run-screenshot.ps1 windowless).</Description></RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>2024-01-01T00:02:00</StartBoundary>
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
