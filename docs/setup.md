# Setup

## 1. Toolchain

- Node 20+ (you have 24).
- pnpm via Corepack. One-time `corepack enable` (admin terminal on Windows). If you can't
  run it as admin, prefix commands with `corepack pnpm@9.12.3` — it works without enabling.

## 2. Install

```bash
corepack pnpm@9.12.3 install
```

## 3. Environment (`.env`)

A prefilled `.env` is included (Supabase URL + anon key for the `Agent-os` project). You
must add one secret:

- `DATABASE_URL` — Supabase Dashboard → **Project Settings → Database → Connection string**.
  Choose **Session pooler** (or **Direct connection**); it already contains the password.
  Example shape: `postgresql://postgres.<your-project-ref>:<pw>@<host>:5432/postgres?sslmode=require`

All settings (`.env.example` documents each):

| Var | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | — | **Required.** Postgres connection to `Agent-os` |
| `TIME_TRACKER_SCHEMA` | `time_tracker` | Schema holding our tables |
| `SENSOR_MODE` | `mock` | `mock` (fixture) or `live` (ActivityWatch) |
| `ACTIVITYWATCH_URL` | `http://localhost:5600` | AW REST endpoint |
| `TIMEZONE` | `America/Denver` | Local day/clock bucketing |
| `INTERNAL_DOMAINS` | `ashfordsky.com` | Never attributed to a client |
| `FREEMAIL_DOMAINS` | gmail,yahoo,… | Domain-match disallowed (exact email still ok) |
| `AUTO_FINALIZE_THRESHOLD` | `0.85` | ≥ this auto-finalizes |
| `REVIEW_THRESHOLD` | `0.5` | < this → needs review |
| `MIN_INTERVAL_SECONDS` | `20` | Ignore tiny window flickers |
| `SCREENSHOTS_ENABLED` | `false` | Master switch for capture |
| `SCREENSHOT_DIR` | `./.data/screenshots` | Local storage path |
| `SCREENSHOT_STABLE_SECONDS` | `20` | Window must be stable this long |
| `SCREENSHOT_RETENTION_DAYS` | `14` | Auto-purge after |

## 4. Database

The `time_tracker` schema is already applied to `Agent-os`. To recreate it elsewhere, run
[`database/migrations/0001_time_tracker_init.sql`](../database/migrations/0001_time_tracker_init.sql).

## 5. ActivityWatch (for live capture)

1. Install from https://activitywatch.net and let it run (it exposes `localhost:5600`).
2. Set `SENSOR_MODE=live` in `.env`.
3. The ingestor auto-discovers the window / afk / web buckets.

## 6. Daily workflow

```bash
pnpm ingest --days 1     # or --days 7 to backfill a week
pnpm resolve --days 1
pnpm dashboard           # review at http://localhost:3000
```

## 7. Automating it (Windows Task Scheduler)

Create a Basic Task that runs every ~15 min:

- Program: `cmd.exe`
- Arguments: `/c cd /d "C:\Users\darin\OneDrive - Ashford Sky CPA LLC\Claude Code\Time Tracker" && corepack pnpm@9.12.3 ingest && corepack pnpm@9.12.3 resolve`

(Optionally add `&& corepack pnpm@9.12.3 screenshots` once you enable screenshots.)

### Auto-run the whole thing on boot

Three layers, all windowless, no admin:

1. **Sensor** — ActivityWatch ships an autostart shortcut (`shell:startup` → `ActivityWatch.lnk`).
   If missing, open the aw-qt tray icon and enable "open on login".
2. **Capture + resolve** — register the 10-min sync task once:
   `powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1`
3. **Dashboard** — start `localhost:3000` at every logon:
   `powershell -ExecutionPolicy Bypass -File scripts\register-dashboard-task.ps1`
   (logs to `.data\dashboard.log`; remove with
   `Unregister-ScheduledTask -TaskName "AshfordSky-TimeTracker-Dashboard" -Confirm:$false`).

The older `schtasks`-based `install-task.cmd` task (`AshfordSkyTimeTracker`) duplicates the
sync task and flashes a console window — prefer the two PowerShell registrars above.

## Troubleshooting

- **`pnpm` not found / `corepack enable` EPERM** — use `corepack pnpm@9.12.3 <cmd>`.
- **`DATABASE_URL is not set`** — you left the `__paste...__` placeholder in `.env`.
- **Dashboard shows "Could not load data"** — check `DATABASE_URL`, then run `pnpm seed`/`pnpm resolve`.
- **Slow installs in OneDrive** — exclude `node_modules` from OneDrive sync, or move the repo
  to a non-synced path.
- **TLS errors connecting to Supabase** — ensure `?sslmode=require` is on the connection string.
