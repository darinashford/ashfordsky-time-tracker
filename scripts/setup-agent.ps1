<#
  Teammate setup for the Ashford Sky Time Tracker (token / agent mode).
  Run ONCE from the repo root, in a normal PowerShell window:

    powershell -ExecutionPolicy Bypass -File scripts\setup-agent.ps1

  It installs Node.js if missing, writes a .env (you paste your token; it holds NO
  database access), installs dependencies, does a test sync, and schedules the sync
  to run every 10 minutes in the background. You only run this once.

  Uninstall later with:
    Unregister-ScheduledTask -TaskName "AshfordSky-TimeTracker-Agent" -Confirm:$false
#>
param(
  [string]$IngestUrl = 'https://time.ashfordsky.com/api/ingest',
  [string]$Token = '',
  [string]$Timezone = 'America/Denver'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

Write-Host '== Ashford Sky Time Tracker - teammate setup ==' -ForegroundColor Cyan

# Safety: don't clobber an admin machine's full .env (which has DATABASE_URL).
$envPath = Join-Path $root '.env'
if ((Test-Path -LiteralPath $envPath) -and (Select-String -LiteralPath $envPath -Pattern '^DATABASE_URL=.+' -Quiet)) {
  throw 'This .env already has a DATABASE_URL (looks like the admin machine). setup-agent is for teammate machines only. Use a fresh clone.'
}

# 1) Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js not found - installing via winget...'
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    Write-Host ''
    Write-Host 'Node.js installed. Close this window, open a NEW PowerShell, and run this script again to finish.' -ForegroundColor Yellow
    return
  }
  throw 'winget is not available. Install Node.js LTS from https://nodejs.org then re-run this script.'
}
Write-Host ("Node.js: " + (node -v))

# 1b) Git — enables hands-off auto-updates (the agent fast-forwards each run).
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host 'Git not found - installing via winget...'
    winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
  } else {
    Write-Warning 'Git not found and winget unavailable. Install Git from https://git-scm.com to get auto-updates. Continuing.'
  }
} else {
  Write-Host ("Git: " + (git --version))
}
if (-not (Test-Path (Join-Path $root '.git'))) {
  Write-Warning 'This folder is not a git clone - auto-updates will be OFF. For updates, install with: git clone <repo-url>'
}

# 2) Token
if (-not $Token) { $Token = (Read-Host 'Paste your ingest token (starts with ttk_)').Trim() }
if (-not $Token) { throw 'A token is required - ask your admin to run mint-token and send you one.' }

# 3) ActivityWatch - must be running so the agent can read local activity.
function Test-AW { try { Invoke-WebRequest -Uri 'http://localhost:5600/api/0/info' -TimeoutSec 5 -UseBasicParsing | Out-Null; return $true } catch { return $false } }
if (Test-AW) {
  Write-Host 'ActivityWatch: running.'
} else {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host 'ActivityWatch not detected - installing via winget...'
    # Via cmd: winget writes progress to stderr, which ErrorActionPreference=Stop
    # would otherwise turn into a fatal NativeCommandError.
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    cmd /c 'winget install -e --id ActivityWatch.ActivityWatch --accept-source-agreements --accept-package-agreements --silent 2>&1' | Out-Host
    $ErrorActionPreference = $eap
  } else {
    Write-Warning 'winget unavailable - install ActivityWatch from https://activitywatch.net'
  }
  if (-not (Get-Process aw-qt -ErrorAction SilentlyContinue)) {
    $awExe = @(
      (Join-Path $env:LOCALAPPDATA 'Programs\ActivityWatch\aw-qt.exe'),
      (Join-Path $env:ProgramFiles  'ActivityWatch\aw-qt.exe')
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($awExe) { Write-Host 'Starting ActivityWatch...'; Start-Process $awExe }
  }
  Write-Host 'Waiting for ActivityWatch to come online...'
  for ($i = 0; $i -lt 15; $i++) { if (Test-AW) { break }; Start-Sleep -Seconds 2 }
  if (Test-AW) { Write-Host 'ActivityWatch: running.' }
  else { Write-Warning 'ActivityWatch still not reachable - open it once from the Start menu; the scheduled sync will pick it up.' }
}

# 4) .env (token mode - NO database credentials)
@"
# Ashford Sky Time Tracker - teammate agent (token mode). NO database credentials.
INGEST_URL=$IngestUrl
INGEST_TOKEN=$Token
ACTIVITYWATCH_URL=http://localhost:5600
TIMEZONE=$Timezone
SENSOR_MODE=live
"@ | Set-Content -LiteralPath $envPath -Encoding UTF8
Write-Host '.env written (token mode).'

# 5) Dependencies
Write-Host 'Installing dependencies (first run can take a few minutes)...'
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
corepack pnpm install | Out-Host

# 6) Test one sync
Write-Host 'Sending a test sync to the server...'
corepack pnpm exec tsx 'services/activitywatch-ingestor/src/agent.ts' | Out-Host

# 7) Schedule every 10 min, windowless (mirrors the main sync task).
$name = 'AshfordSky-TimeTracker-Agent'
$vbs  = Join-Path $PSScriptRoot 'agent-hidden.vbs'
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Ashford Sky Time Tracker agent: every 10 min, send this machine's ActivityWatch activity to the firm dashboard (token mode; runs scripts\run-agent.ps1 windowless).</Description></RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>2024-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition><Interval>PT10M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>$env:USERDOMAIN\$env:USERNAME</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>"$vbs"</Arguments></Exec></Actions>
</Task>
"@
Register-ScheduledTask -TaskName $name -Xml $xml -Force | Out-Null
Start-ScheduledTask -TaskName $name

# 8) Screenshot loop (~2 min): OCRs the current email window locally to help
#    identify the client, sending only the extracted text. Image stays on this PC.
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'register-screenshot-task.ps1')
Start-ScheduledTask -TaskName 'AshfordSky-TimeTracker-Screenshot' -ErrorAction SilentlyContinue
Write-Host 'Screenshot OCR task scheduled (every ~2 min; text-only, image stays local).'

Write-Host ''
Write-Host 'Done! Your time now syncs every 10 minutes in the background.' -ForegroundColor Green
Write-Host 'Open the firm dashboard, sign in with your Microsoft account, and pick your name in the "Whose time" switcher.'
Write-Host 'Sync log: .data\agent.log'
