-- 0006_enable_rls_time_tracker.sql
-- Enable Row-Level Security on all time_tracker tables to close anon-key exposure.
--
-- No policies are added on purpose: the app (dashboard, ingestor, resolver, sync)
-- connects as the table OWNER (`postgres`, via DATABASE_URL), and owners bypass RLS
-- unless it is FORCED. RLS is NOT forced here, so the app path is unchanged. What
-- this blocks is the Supabase `anon`/`authenticated` (PostgREST) roles: with RLS on
-- and no policy, they get default-deny — so the public anon key can no longer read
-- or write these tables.
--
-- If you ever start using supabase-js / the anon key for data access, you'll need to
-- add explicit policies for the roles that should be allowed.
alter table time_tracker.accuracy_snapshots   enable row level security;
alter table time_tracker.attribution_rules    enable row level security;
alter table time_tracker.corrections          enable row level security;
alter table time_tracker.current_client_state enable row level security;
alter table time_tracker.exclusions           enable row level security;
alter table time_tracker.ingest_tokens        enable row level security;
alter table time_tracker.intervals            enable row level security;
alter table time_tracker.llm_usage            enable row level security;
alter table time_tracker.raw_events           enable row level security;
alter table time_tracker.resolution_audit     enable row level security;
alter table time_tracker.resolutions          enable row level security;
alter table time_tracker.review_queue         enable row level security;
alter table time_tracker.screenshot_policies  enable row level security;
alter table time_tracker.screenshots          enable row level security;
alter table time_tracker.settings             enable row level security;
