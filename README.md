# Ashford Sky — Client Time Attribution (MVP)

Local-first system that **automatically figures out which client you were working on**
across Windows apps, browsers, email, CCH Axcess, Google Sheets, SharePoint/Drive,
QuickBooks Online, Financial Cents, Excel, Missive, ChatGPT/Claude, and more — then lets
you review and correct it. Every correction becomes a durable rule, so it gets more
autonomous over time.

It is **not** a generic time tracker. It reuses your existing Supabase **client graph**
(the `Agent-os` project) as the source of truth and only *reads* it; all of its own data
lives in an additive `time_tracker` schema.

```
ActivityWatch ──► ingestor ──► time_tracker.intervals
                                     │
                          resolver runner  ◄── client graph (public.*)  +  learned rules
                                     │
                 resolutions + audit + review queue + screenshot intents
                                     │
                          Next.js review dashboard ──► confirm / correct / map-forever ──► rules
                                     │
                          billing CSV  +  accuracy report
```

## What's already done

- The `time_tracker` schema (13 tables + 2 views) is **already applied** to your `Agent-os`
  Supabase project. Migration SQL is in [`database/migrations/0001_time_tracker_init.sql`](database/migrations/0001_time_tracker_init.sql).
- Resolver logic is unit-tested (`pnpm test`) and the whole workspace typechecks.

## Prerequisites

- **Node 20+** (you have 24).
- **pnpm** via Corepack. One-time: `corepack enable` (needs an admin terminal on Windows).
  If that fails, just prefix every command with `corepack pnpm@9.12.3` instead of `pnpm`.
- A **Supabase connection string** for the `Agent-os` project (the one secret you must paste).
- *(Optional for live capture)* **ActivityWatch** running locally — https://activitywatch.net.

## Setup

1. Install dependencies:
   ```bash
   corepack pnpm@9.12.3 install
   ```
2. The repo ships a prefilled `.env` (URL + anon key). Open it and paste your DB string:
   - Supabase Dashboard → **Project Settings → Database → Connection string → Session pooler**
   - Put it in `DATABASE_URL=` (it already contains the password).

   `.env` is git-ignored. Never commit real keys.

## Run it (demo, no ActivityWatch needed)

```bash
pnpm seed        # generates a realistic demo day in time_tracker from your real graph
pnpm resolve     # attributes the intervals to clients
pnpm dashboard   # open http://localhost:3000
```

> `seed` writes only to `time_tracker` (your machine, your DB). No real client data is
> committed to this repo.

## Run it (real activity)

```bash
# 1. set SENSOR_MODE=live in .env (ActivityWatch must be running)
pnpm ingest                 # pull today's events -> intervals  (use --days 7 for a week)
pnpm resolve                # attribute them
pnpm screenshots            # optional; only if SCREENSHOTS_ENABLED=true
pnpm --filter @tt/resolver-service run llm   # optional LLM pass; only if LLM_ENABLED=true
pnpm dashboard              # review at http://localhost:3000
```

The **LLM pass** is a final, opt-in judgement over whatever the deterministic rules
left residual — blocks that are unresolved, or fell into an ambiguous bucket like
AI-assistant / developer / email time. It reads each block's window title, on-screen
OCR (when a screenshot exists), and the nearest client before/after, then decides:
**this client** (always written as *suggested* for you to confirm — never auto-billed),
a **non-billable** category (including `firm_tooling` for building the firm's own
software/AI), or **unknown**. Off unless `LLM_ENABLED=true` and `ANTHROPIC_API_KEY`
are set in `.env`; runs locally only (the key is **not** needed on Railway). Default
model is Opus 4.8 — set `LLM_MODEL=claude-haiku-4-5` to cut per-block cost ~5×.

There is also a bundled offline fixture: with `SENSOR_MODE=mock`, `pnpm ingest` replays
[`services/activitywatch-ingestor/fixtures/demo-day.json`](services/activitywatch-ingestor/fixtures/demo-day.json)
(synthetic, fake clients) so you can exercise the ingest path with no AW installed.

## Keep today current automatically

ActivityWatch records continuously, but the dashboard only shows what's been
**ingested + resolved** — if that pipeline never runs, "today" stays empty. Run it in
one shot (no `pnpm` on PATH needed — these use `npm`, which is):

```bash
npm run sync           # ingest -> screenshots -> resolve -> LLM pass (today; run any time)
npm run sync:catchup   # same, but the last 7 days (use after the machine was off a while)
```

(The screenshot and LLM steps no-op unless `SCREENSHOTS_ENABLED` / `LLM_ENABLED` are set.)

To make it hands-off, a Windows **Scheduled Task** can run the sync every 10 minutes while
you're logged in — windowless ([`scripts/sync-hidden.vbs`](scripts/sync-hidden.vbs) →
[`scripts/sync.ps1`](scripts/sync.ps1)), logging to `.data/sync.log`. Register it once
(from the repo root, no admin needed):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1
```

That registers [`scripts/register-task.ps1`](scripts/register-task.ps1)'s task and kicks off
a first run. Remove it with
`Unregister-ScheduledTask -TaskName "AshfordSky-TimeTracker-Sync" -Confirm:$false`.

## Hosting the dashboard (Railway) + Microsoft 365 login

The dashboard is the only web-facing piece — host it (e.g. **Railway**) for a URL you can
open anywhere. The **sync keeps running on your PC** (ActivityWatch is local, so the host
can't reach it); both sides talk to the same Supabase DB.

Because `.env` is git-ignored, the host needs its **own** copy of these (Railway → Variables):

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | ✅ | Supabase connection string (same as local `.env`) |
| `TIMEZONE` | ✅ | display + day-boundary zone, e.g. `America/Denver`. **Set this** — if unset/UTC the timeline clock shows the wrong zone |
| `AUTH_URL` | ✅ | public site URL, e.g. `https://ttdashboard-production.up.railway.app` (no trailing slash). Without it, sign-in points at `localhost:$PORT` |
| `AUTH_SECRET` | ✅ | random 32+ chars — `openssl rand -base64 32` |
| `AUTH_MICROSOFT_ENTRA_ID_ID` | ✅ | Entra "Application (client) ID" |
| `AUTH_MICROSOFT_ENTRA_ID_SECRET` | ✅ | Entra client secret **Value** |
| `AUTH_MICROSOFT_ENTRA_ID_ISSUER` | ✅ | `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| `AUTH_ALLOWED_DOMAIN` | – | defaults to `ashfordsky.com` |

Access is locked to **Microsoft 365** (Auth.js + Entra ID, single-tenant). Until the
`AUTH_*` vars are set the site fails **closed** (HTTP 503) so client data is never exposed;
set `DASHBOARD_PUBLIC=true` only for local no-auth dev.

**One-time Entra app registration** — Azure Portal → *Microsoft Entra ID → App registrations
→ New registration*:
1. **Supported account types:** *Accounts in this organizational directory only* (single tenant).
2. **Redirect URI** (Web): `https://<your-railway-domain>/api/auth/callback/microsoft-entra-id`
   (also add `http://localhost:3000/api/auth/callback/microsoft-entra-id` for local login).
3. Copy the **Application (client) ID** and **Directory (tenant) ID**.
4. **Certificates & secrets → New client secret** → copy the **Value**.
5. Fill the env vars above (issuer uses the tenant id), then redeploy.

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install the workspace |
| `pnpm test` | Run resolver + util unit tests (Vitest) |
| `pnpm typecheck` | Typecheck every package/service |
| `pnpm seed` | Seed a demo day into `time_tracker` |
| `pnpm ingest [--days N] [--rebase]` | Pull ActivityWatch (or mock) → intervals |
| `pnpm resolve [--date YYYY-MM-DD] [--days N]` | Run attribution over intervals |
| `pnpm --filter @tt/resolver-service run llm [--date YYYY-MM-DD] [--days N]` | LLM pass over residual blocks (opt-in; needs `LLM_ENABLED=true` + `ANTHROPIC_API_KEY`) |
| `npm run sync` / `npm run sync:catchup` | Ingest → resolve → LLM in one command (trailing 24h / last 7 days) — no `pnpm` on PATH needed |
| `pnpm screenshots [--max N]` | Capture conditional screenshots + purge expired |
| `pnpm dashboard` | Next.js review UI on :3000 |

To run a service directly without enabling pnpm globally:
`corepack pnpm@9.12.3 resolve` etc.

## Repo layout

```
apps/dashboard                 Next.js review dashboard (timeline, actions, CSV, accuracy)
services/activitywatch-ingestor  Pull AW events -> normalized intervals (adapter, mockable)
services/resolver-service        Run resolver chain + context engine -> resolutions
services/screenshot-sidecar      Policy-gated capture (local storage adapter, OCR stub)
packages/shared                Types, text/time utils, config loader
packages/db                    pg access: client-graph loader + time_tracker queries
packages/resolvers             Pure, tested resolver chain + context engine + corrections
database/migrations            time_tracker SQL
docs/                          architecture, setup, resolver design, screenshots, accuracy
```

## How it gets autonomous

Every correction in the dashboard can create a **durable rule** in
`time_tracker.attribution_rules` (e.g. *"map this Google Sheet ID / domain / folder to
this client forever"*). Rules are the highest-priority resolver, so the next time that
signal appears it resolves automatically. The **top-unresolved** report shows you exactly
what to map next. See [docs/resolver-design.md](docs/resolver-design.md).

## Privacy / security

- No secrets in code. `DATABASE_URL` and keys come from `.env` (git-ignored).
- The `time_tracker` schema is **not** exposed via PostgREST; it's reached only through a
  direct Postgres connection.
- Screenshots are **off by default** and never taken of high-confidence or excluded
  activity. See [docs/screenshot-policy.md](docs/screenshot-policy.md).

## Docs

- [Architecture](docs/architecture.md)
- [Setup](docs/setup.md)
- [Resolver design](docs/resolver-design.md)
- [Screenshot policy](docs/screenshot-policy.md)
- [Accuracy testing](docs/accuracy-testing.md)
