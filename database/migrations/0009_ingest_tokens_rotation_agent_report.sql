-- 0009_ingest_tokens_rotation_agent_report.sql
-- Remote fleet management: rotate tokens through the sync channel (no PowerShell
-- on the teammate machine) and let each agent report its own health.
--   Rotation flow: admin clicks Rotate in Settings -> rotate_requested=true ->
--   next /api/ingest response carries a fresh plaintext token (hash stored in
--   pending_token_hash) -> the agent rewrites its own .env -> the new token's
--   first authenticated use promotes it (old token stops matching). No outage:
--   the old token keeps working until the new one is first used.
alter table time_tracker.ingest_tokens
  add column if not exists rotate_requested   boolean not null default false,
  add column if not exists pending_token_hash text,
  add column if not exists rotated_at         timestamptz,
  add column if not exists agent_sha          text,
  add column if not exists agent_report       jsonb,
  add column if not exists agent_reported_at  timestamptz;
comment on column time_tracker.ingest_tokens.rotate_requested is 'Admin asked for rotation; next sync response carries a fresh token, agent adopts it, first use promotes it.';
comment on column time_tracker.ingest_tokens.pending_token_hash is 'Hash of the not-yet-adopted replacement token.';
comment on column time_tracker.ingest_tokens.agent_report is 'Self-reported machine health (code sha, scheduled tasks, last errors) from the latest sync.';
