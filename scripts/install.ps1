<#
  Ashford Sky Time Tracker - one-line teammate installer.

  A teammate runs THIS single line in any PowerShell window:

    irm https://raw.githubusercontent.com/darinashford/ashfordsky-time-tracker/main/scripts/install.ps1 | iex

  It installs ActivityWatch + Git + Node (via winget), clones the app, launches
  ActivityWatch, then runs setup-agent.ps1 - which asks for your token, configures
  the sync, sends a test, and schedules it to run every 10 minutes.

  This machine NEVER gets database access - only a per-person token that can send
  activity to the firm dashboard. Nothing else to do, ever.

  (Optional: set $env:TT_TOKEN before running to skip the token prompt.)
#>
$ErrorActionPreference = 'Stop'
function Info($m) { Write-Host $m -ForegroundColor Cyan }
function Ok($m)   { Write-Host $m -ForegroundColor Green }

Info '== Ashford Sky Time Tracker - installer =='

# 0) winget (App Installer) is required to install the prerequisites.
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  throw "winget is required but not found. Install 'App Installer' from the Microsoft Store, then paste the line again."
}

# Native tools (git, winget) print progress to STDERR even on success; with
# ErrorActionPreference=Stop, PowerShell 5.1 turns redirected stderr into a
# terminating NativeCommandError (this killed a real install mid-clone). Route
# native output through cmd and judge by exit code, never by stderr.
function Run-Git([string]$gitArgs) {
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  cmd /c "git $gitArgs 2>&1" | Out-Host
  $ErrorActionPreference = $eap
  if ($LASTEXITCODE -ne 0) { throw "git $gitArgs failed (exit $LASTEXITCODE)" }
}

# 1) Prerequisites - idempotent. winget exits nonzero for benign outcomes like
# "already installed / no newer version", so it never throws.
function Ensure-Pkg($id, $label) {
  Info "Installing $label ..."
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  cmd /c "winget install -e --id $id --accept-source-agreements --accept-package-agreements --silent 2>&1" | Out-Host
  $ErrorActionPreference = $eap
}
Ensure-Pkg 'ActivityWatch.ActivityWatch' 'ActivityWatch'
Ensure-Pkg 'Git.Git' 'Git'
Ensure-Pkg 'OpenJS.NodeJS.LTS' 'Node.js LTS'

# 2) Make freshly-installed git/node usable in THIS same session (no reboot/reopen).
$env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [System.Environment]::GetEnvironmentVariable('Path', 'User')

# 3) Clone (or update) the app.
$dir  = Join-Path $HOME 'ashfordsky-time-tracker'
$repo = 'https://github.com/darinashford/ashfordsky-time-tracker.git'
if (Test-Path (Join-Path $dir '.git')) {
  # Teammate clones are read-only mirrors of main — nothing local is ever worth
  # keeping except untracked files (.env, .data), which a hard reset preserves.
  # fetch + reset also self-heals a DIVERGED clone, where a plain pull aborts
  # ("Not possible to fast-forward") and the installer used to die here.
  Info "App already present at $dir - updating ..."
  Run-Git "-C `"$dir`" fetch origin main"
  Run-Git "-C `"$dir`" reset --hard origin/main"
} else {
  if (Test-Path $dir) {
    # Leftover from an interrupted install (folder exists but isn't a clone).
    Info "Removing incomplete install at $dir ..."
    Remove-Item -Recurse -Force $dir
  }
  Info "Cloning to $dir ..."
  Run-Git "clone $repo `"$dir`""
}

# 4) Launch ActivityWatch (it then auto-starts on login) and wait until it is up.
if (-not (Get-Process aw-qt -ErrorAction SilentlyContinue)) {
  $awExe = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\ActivityWatch\aw-qt.exe'),
    (Join-Path $env:ProgramFiles  'ActivityWatch\aw-qt.exe')
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($awExe) { Info 'Starting ActivityWatch ...'; Start-Process $awExe }
}
Info 'Waiting for ActivityWatch to come online ...'
for ($i = 0; $i -lt 15; $i++) {
  try { Invoke-WebRequest 'http://localhost:5600/api/0/info' -TimeoutSec 2 -UseBasicParsing | Out-Null; break }
  catch { Start-Sleep -Seconds 2 }
}

# 5) Hand off to setup-agent: asks for the token, writes .env (token mode - NO db),
#    installs deps, sends a test sync, and schedules the 10-min background sync.
$setup = Join-Path $dir 'scripts\setup-agent.ps1'
$tokenArg = @()
if ($env:TT_TOKEN) { $tokenArg = @('-Token', $env:TT_TOKEN) }
Info 'Running setup (you will be asked to paste your token) ...'
& powershell -NoProfile -ExecutionPolicy Bypass -File $setup @tokenArg

Ok ''
Ok 'All set. Your time now syncs every 10 minutes in the background.'
Ok 'Dashboard: https://time.ashfordsky.com - sign in with your Microsoft account and pick your name in "Whose time".'
