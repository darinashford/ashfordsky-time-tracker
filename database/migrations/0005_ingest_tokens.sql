-- Per-person ingest tokens for the token-auth sync agent. A teammate's agent
-- authenticates with a Bearer token instead of a database credential. Only the
-- SHA-256 hash is stored; the token maps to the hostname the API stamps on that
-- person's data, so nobody can write as someone else.
create table if not exists time_tracker.ingest_tokens (
  id           uuid primary key default gen_random_uuid(),
  token_hash   text not null unique,
  hostname     text not null,
  label        text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked      boolean not null default false
);
comment on table time_tracker.ingest_tokens is 'Per-person ingest tokens (hashed) for the token-auth sync agent.';
