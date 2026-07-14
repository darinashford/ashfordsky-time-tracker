# Onboarding a teammate

The teammate's machine only needs **ActivityWatch** + a **token**. It never gets
database credentials — it sends activity to the dashboard's `/api/ingest` with a
per-person token, and the server records it under their name. You (admin) view
everyone from the one firm dashboard via the **"Whose time"** switcher.

The installer does everything else (installs ActivityWatch, Git, and Node; clones
the app; schedules the sync) and the agent **auto-updates** — every change you push
reaches them on their next sync, with nothing to reinstall.

Assumes the teammate is on **Windows** (like the admin). On a Mac the agent runs
but the scheduled-task step differs — ask before onboarding a Mac.

---

## Admin steps (you, once per teammate)

1. **Mint their token in the dashboard:** open <https://time.ashfordsky.com/settings> →
   **Add a person** → short id (e.g. `jane`) + full name → **Add person**. The short id
   is how their time shows in the "Whose time" switcher. The `ttk_…` token is shown
   **once** — send it via a password manager / secure channel (not email or chat).

   <details><summary>CLI alternative</summary>

   From your repo root (where `.env` has the DB connection):
   ```
   corepack pnpm exec tsx services/activitywatch-ingestor/src/mint-token.ts --host jane --label "Jane Smith"
   ```
   </details>

2. **Send them** the token plus the one-line install command below (the Settings page
   shows both together). That's it — the repo is public, so there's no GitHub account
   or invite to deal with.

3. **Dashboard access:** their `@ashfordsky.com` Microsoft account already works at
   <https://time.ashfordsky.com> — nothing to change.

Revoke someone later: Settings → **revoke** next to their name.

---

## Teammate steps (them, once — ~5 minutes)

1. Open **PowerShell** and paste this one line:
   ```
   irm https://raw.githubusercontent.com/darinashford/ashfordsky-time-tracker/main/scripts/install.ps1 | iex
   ```
2. **Paste your `ttk_…` token** when it asks. (Approve the Windows install prompt if one appears.)
3. **View it:** open <https://time.ashfordsky.com>, sign in with your Microsoft account, and pick your name in the **"Whose time"** switcher.

That's the whole job. The line installs ActivityWatch + Git + Node, grabs the app,
starts ActivityWatch, sends a test sync, and schedules the sync to run every 10
minutes in the background. Nothing else to run, ever.

> **Manual alternative** (if you prefer not to run the one-liner): install
> [ActivityWatch](https://activitywatch.net), [Git](https://git-scm.com/download/win),
> and [Node LTS](https://nodejs.org); then
> `git clone https://github.com/darinashford/ashfordsky-time-tracker.git`,
> `cd ashfordsky-time-tracker`, and
> `powershell -ExecutionPolicy Bypass -File scripts\setup-agent.ps1`. If it says Node
> was just installed, open a new PowerShell and run that last command again.

---

## Cloud attribution (no laptop dependency)

Attribution (the resolver that matches everyone's blocks to clients) also runs **in the
cloud every 10 minutes**, so nobody's time waits on the admin's PC being awake. One-time
Railway setup:

1. Railway project → **New service → GitHub repo** → pick this same repo.
2. Service **Settings → Config-as-code / Config file path** → `services/resolver-service/railway.json`
   (sets the start command, `*/10 * * * *` cron, and no-restart policy).
3. Service **Variables**: add `DATABASE_URL` (same value as the dashboard service — or use a
   shared variable), `TIME_TRACKER_SCHEMA=time_tracker`, `TIMEZONE=America/Denver`.
   Do **NOT** set `ANTHROPIC_API_KEY` here — the AI pass stays on the admin machine.
4. Deploy. Each run processes today for every person and exits; check the service logs for
   `[resolver] done`.

The admin machine keeps running its own richer local loop (ingest + screenshots + resolve +
AI pass); the cloud resolver is idempotent alongside it — same code, same rules, whoever
runs first wins and the other confirms.

---

## Updates (hands-off)

- **Dashboard / attribution / rules:** you `git push` → Railway redeploys → teammates just refresh. No action on their end.
- **The agent on their machine:** each run does a `git pull` first, so your pushes reach every teammate within ~10 minutes automatically (deps reinstall only if they changed). You never have to walk anyone through an update.
- Because updates auto-apply, **test a push before you rely on it** — a broken commit would reach every agent on the next cycle (each machine's log is `.data\agent.log`).

---

## How it stays safe

- The teammate machine holds **no database credentials** — only a token that can *send* activity, nothing else.
- The token is stored **hashed**; the server stamps identity from the token, so no one can post as someone else.
- The agent runs locally (ActivityWatch is local); only the processed activity leaves the machine, to your dashboard.
- Troubleshooting log on their machine: `.data\agent.log`.
