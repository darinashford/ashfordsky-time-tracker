<#
  One screenshot cycle for a TEAMMATE machine (token mode): if the current window
  is an email window, capture + OCR it LOCALLY and POST only the extracted text to
  the dashboard's /api/ingest/ocr with the token in .env. The image never leaves
  this machine; no database credentials are used. The Scheduled Task runs this every
  ~2 min, windowless (screenshot-hidden.vbs -> run-screenshot.ps1). Code is kept up
  to date by run-agent.ps1's git pull. Output -> .data\screenshot.log (git-ignored).

  Run by hand:  powershell -ExecutionPolicy Bypass -File scripts\run-screenshot.ps1
#>
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'

$dataDir = Join-Path $root '.data'
if (-not (Test-Path -LiteralPath $dataDir)) { New-Item -ItemType Directory -Force -Path $dataDir | Out-Null }
$log = Join-Path $dataDir 'screenshot.log'

corepack pnpm exec tsx 'services/screenshot-sidecar/src/agent.ts' 2>&1 | Add-Content -LiteralPath $log
"$(Get-Date -Format o)  shot exit=$LASTEXITCODE" | Add-Content -LiteralPath $log
