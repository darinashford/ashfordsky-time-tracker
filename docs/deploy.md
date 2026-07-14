# Deploying the review dashboard (Railway)

**Only the dashboard is hosted.** The ActivityWatch ingestor and the screenshot
sidecar must keep running on your machine — they read your local ActivityWatch
API and screen, which a cloud server can't see. The Windows scheduled task
(`scripts/run-pipeline.cmd`) already does that. The hosted dashboard reads the
same Supabase, so it shows your live data from anywhere.

## One-time Railway setup
1. Repo is on GitHub (private): https://github.com/darinashford/ashfordsky-time-tracker
2. Railway → **New Project → Deploy from GitHub repo → ashfordsky-time-tracker**
   (authorize Railway's GitHub app for the repo if prompted).
3. Railway reads [`railway.json`](../railway.json) and runs:
   - **build:** `pnpm install --frozen-lockfile && pnpm --filter @tt/dashboard build`
   - **start:** `next start -p $PORT`
4. Railway → the service → **Variables** → add:
   - `DATABASE_URL` = your Supabase **Session pooler** connection string (the same
     value as your local `.env`). This is the only required variable.
   - (optional) `TIMEZONE`, `TIME_TRACKER_SCHEMA` — only if you change the defaults
     (`America/Denver`, `time_tracker`).
5. Railway → **Settings → Networking → Generate Domain** for a public URL.

## Redeploys
Railway auto-deploys on every push to `main`:

```
git add -A && git commit -m "..." && git push
```

## Security
- Keep `DATABASE_URL` only in Railway's **Variables** — it is git-ignored locally
  and must never be committed.
- The repo is private. The capture pipeline (ingestor/sidecar) stays entirely on
  your machine; hosting changes nothing about it.
