<#
  One screenshot cycle for the OWNER machine (DB mode): if the current window's
  block has weak attribution (unresolved / needs-review / carried over) or is an
  email window, capture the ACTIVE WINDOW, OCR it, and store text + image so the
  resolver can read the client off the screen. The Scheduled Task runs this every
  ~2 min, windowless (owner-screenshot-hidden.vbs). Without this task the owner
  only captured once per 10-minute sync — a quick email check between syncs was
  never seen (that's how "Custom Tax Rules" stayed unattributed on 8/17).

  Run by hand:  powershell -ExecutionPolicy Bypass -File scripts\run-owner-screenshot.ps1
#>
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'

$dataDir = Join-Path $root '.data'
if (-not (Test-Path -LiteralPath $dataDir)) { New-Item -ItemType Directory -Force -Path $dataDir | Out-Null }
$log = Join-Path $dataDir 'sidecar.log'

corepack pnpm exec tsx 'services/screenshot-sidecar/src/index.ts' --max 3 2>&1 | Add-Content -LiteralPath $log
"$(Get-Date -Format o)  sidecar exit=$LASTEXITCODE" | Add-Content -LiteralPath $log
