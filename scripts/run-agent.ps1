<#
  One sync cycle for a TEAMMATE machine (token / agent mode): read local
  ActivityWatch and POST it to the firm dashboard's /api/ingest using the token in
  .env. Holds NO database credentials. The Scheduled Task runs this every 10 min,
  windowless (agent-hidden.vbs -> run-agent.ps1). Output is appended to
  .data\agent.log (git-ignored).

  Run by hand:  powershell -ExecutionPolicy Bypass -File scripts\run-agent.ps1
#>
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'

$dataDir = Join-Path $root '.data'
if (-not (Test-Path -LiteralPath $dataDir)) { New-Item -ItemType Directory -Force -Path $dataDir | Out-Null }
$log = Join-Path $dataDir 'agent.log'
function Log([string]$m) { "$(Get-Date -Format o)  $m" | Add-Content -LiteralPath $log }

Log '==== agent start ===='

# Auto-update: fast-forward to the admin's latest pushed code, and reinstall deps
# only if they changed. Best-effort — if git is missing, offline, or the working
# copy has diverged, we log it and keep running the current code (never block the
# sync). Requires the repo to be a git clone (see team-onboarding.md).
if (Test-Path (Join-Path $root '.git')) {
  if (Get-Command git -ErrorAction SilentlyContinue) {
    $before = (git rev-parse HEAD 2>$null)
    # Mirror origin/main exactly. reset --hard keeps untracked files (.env, .data)
    # and recovers from a diverged clone — pull --ff-only refused those, and the
    # agent then silently ran stale code forever (no updates, no new tasks).
    git fetch origin main 2>&1 | Add-Content -LiteralPath $log
    git reset --hard origin/main 2>&1 | Add-Content -LiteralPath $log
    $after = (git rev-parse HEAD 2>$null)
    if ($before -and $after -and $before -ne $after) {
      Log "updated $before -> $after; installing deps"
      corepack pnpm install 2>&1 | Add-Content -LiteralPath $log
    }
  } else {
    Log 'git not found on PATH; skipping auto-update'
  }
}

# Remote maintenance: idempotent fixes shipped via git (register/enable tasks, any
# future machine-side repair). Runs from the freshly synced repo every cycle, so a
# push to main fixes every teammate machine within ~10 minutes — no PowerShell asks.
try {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'agent-maintenance.ps1') 2>&1 | Add-Content -LiteralPath $log
} catch { Log "maintenance failed: $($_.Exception.Message)" }

# Health report for the dashboard (sent with the sync; visible in Settings): which
# code we run, task states, and the most recent error lines from the local logs.
try {
  $tasks = @{}
  foreach ($name in @('AshfordSky-TimeTracker-Agent', 'AshfordSky-TimeTracker-Screenshot')) {
    $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    $tasks[$name -replace 'AshfordSky-TimeTracker-', ''] = if ($t) { "$($t.State)" } else { 'missing' }
  }
  $errs = @()
  foreach ($lf in @($log, (Join-Path $dataDir 'screenshot.log'))) {
    if (Test-Path -LiteralPath $lf) {
      $errs += @(Get-Content -LiteralPath $lf -Tail 200 | Where-Object { $_ -match 'failed|error|fatal' } | Select-Object -Last 3)
    }
  }
  $report = @{ generatedAt = (Get-Date -Format o); tasks = $tasks; recentErrors = @($errs | ForEach-Object { "$_".Substring(0, [Math]::Min(300, "$_".Length)) }) }
  $report | ConvertTo-Json -Depth 4 -Compress | Set-Content -LiteralPath (Join-Path $dataDir 'agent-report.json') -Encoding UTF8
} catch { Log "report build failed: $($_.Exception.Message)" }

corepack pnpm exec tsx 'services/activitywatch-ingestor/src/agent.ts' 2>&1 | Add-Content -LiteralPath $log
Log "agent exit=$LASTEXITCODE"
