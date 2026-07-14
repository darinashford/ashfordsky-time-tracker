<#
  Ashford Sky Time Tracker - start the review dashboard (long-running).

  Serves http://localhost:3000. The Scheduled Task
  "AshfordSky-TimeTracker-Dashboard" runs this windowless at every logon so the
  dashboard is always up after you boot. Output is appended to
  .data\dashboard.log (git-ignored).

  Run by hand:  powershell -ExecutionPolicy Bypass -File scripts\start-dashboard.ps1
  Stop it:      close the hidden powershell (Task Manager) or just reboot.

  Lower-overhead alternative: swap the `... run dev` line below for a one-time
  `corepack pnpm --filter @tt/dashboard run build` plus `... run start` (prod
  server, no file-watcher) if idle CPU from dev mode bothers you.
#>
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'

$dataDir = Join-Path $root '.data'
if (-not (Test-Path -LiteralPath $dataDir)) { New-Item -ItemType Directory -Force -Path $dataDir | Out-Null }
$log = Join-Path $dataDir 'dashboard.log'

# Don't start a second server if one is already listening on :3000
# (e.g. you ran `pnpm dashboard` by hand). Keeps logon idempotent.
$busy = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  "$(Get-Date -Format o)  port 3000 already in use - not starting a second dashboard." | Add-Content -LiteralPath $log
  return
}

"$(Get-Date -Format o)  ==== dashboard start ====" | Add-Content -LiteralPath $log
corepack pnpm --filter @tt/dashboard run dev *>> $log
"$(Get-Date -Format o)  ==== dashboard exited (code=$LASTEXITCODE) ====" | Add-Content -LiteralPath $log
