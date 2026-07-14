<#
  Ashford Sky Time Tracker - one-shot sync (ingest -> resolve).

  Default (no args): syncs ONLY today's calendar day (local time), so a finished
  day is never re-touched. This matters because re-ingesting deletes + reinserts
  intervals (to mirror ActivityWatch), which cascade-deletes their resolutions;
  if we reached back into yesterday we'd strip yesterday's attribution. Keeping
  the window to "today" leaves past days frozen with their final attribution.

  The Windows Scheduled Task "AshfordSky-TimeTracker-Sync" runs this every few
  minutes so the dashboard's today stays current.

  Run manually:        powershell -ExecutionPolicy Bypass -File scripts\sync.ps1
  Backfill N days:     powershell -ExecutionPolicy Bypass -File scripts\sync.ps1 -Days 7
                       (rolling N-day window; use after the machine was off a while)

  Output is appended to .data\sync.log (git-ignored).
#>
param([int]$Days = 0)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'

$dataDir = Join-Path $root '.data'
if (-not (Test-Path -LiteralPath $dataDir)) { New-Item -ItemType Directory -Force -Path $dataDir | Out-Null }
$log = Join-Path $dataDir 'sync.log'
function Log([string]$m) { "$(Get-Date -Format o)  $m" | Add-Content -LiteralPath $log }

# Build the ingest/resolve args. Day boundary uses the app's timezone (Denver).
$ingestArgs = @()
$resolveArgs = @()
if ($Days -gt 0) {
  $ingestArgs = @('--days', "$Days")
  $resolveArgs = @('--days', "$Days")
  Log "==== sync start (rolling ${Days}d) ===="
} else {
  $tz = [System.TimeZoneInfo]::FindSystemTimeZoneById('Mountain Standard Time')  # America/Denver (+DST)
  $nowLocal = [System.TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $tz)
  $today = $nowLocal.ToString('yyyy-MM-dd')
  $sinceUtc = [System.TimeZoneInfo]::ConvertTimeToUtc($nowLocal.Date, $tz)
  $since = $sinceUtc.ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'")
  $ingestArgs = @('--since', $since)
  $resolveArgs = @('--date', $today)
  Log "==== sync start (today $today, since $since) ===="
}

corepack pnpm exec tsx 'services/activitywatch-ingestor/src/index.ts' @ingestArgs 2>&1 | Add-Content -LiteralPath $log
Log "ingest exit=$LASTEXITCODE"
# Capture + OCR fresh email windows BEFORE resolve, so a sender read off the
# screen attributes that email the same cycle. Today mode only (capturing "now"
# is meaningless for a historical backfill). Respects SCREENSHOTS_ENABLED.
if ($Days -le 0) {
  corepack pnpm exec tsx 'services/screenshot-sidecar/src/index.ts' --max 5 2>&1 | Add-Content -LiteralPath $log
  Log "screenshots exit=$LASTEXITCODE"
}
corepack pnpm exec tsx 'services/resolver-service/src/index.ts' @resolveArgs 2>&1 | Add-Content -LiteralPath $log
Log "resolve exit=$LASTEXITCODE"
# LLM pass: final judgement on the blocks deterministic rules left residual
# (unresolved, or ambiguous AI/dev/email time). No-ops unless LLM_ENABLED=true and
# ANTHROPIC_API_KEY is set. Runs after resolve so it only sees what's left over.
corepack pnpm exec tsx 'services/resolver-service/src/llm.ts' @resolveArgs 2>&1 | Add-Content -LiteralPath $log
Log "llm exit=$LASTEXITCODE"
Log "==== sync done ===="
