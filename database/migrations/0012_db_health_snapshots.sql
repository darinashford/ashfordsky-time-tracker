-- Early-warning telemetry for the 2026-07-22 class of failure: the disk-IO
-- budget is a daily burst bucket that shows ~0% right up until a sustained
-- heavy stretch drains it, after which the instance crawls and retry churn
-- keeps it pinned. pg_stat counters let us see the DRIVER (row writes/day,
-- table growth) long before the cliff. The nightly audit cron snapshots these
-- and alerts when the write rate or growth is far above the app's normal.
create table if not exists time_tracker.db_health_snapshots (
  id          uuid primary key default gen_random_uuid(),
  taken_at    timestamptz not null default now(),
  -- sum of n_tup_ins+upd+del across time_tracker tables (cumulative since the
  -- last Postgres stats reset — deltas between snapshots are the signal; a
  -- negative delta means stats reset (restart/resize) and is skipped).
  total_writes bigint not null,
  dead_tuples  bigint not null,
  db_bytes     bigint not null,
  -- per-table breakdown for the alert message ("resolutions wrote 4x normal")
  tables      jsonb not null default '{}'::jsonb
);

create index if not exists db_health_snapshots_taken_idx
  on time_tracker.db_health_snapshots (taken_at desc);

alter table time_tracker.db_health_snapshots enable row level security;
