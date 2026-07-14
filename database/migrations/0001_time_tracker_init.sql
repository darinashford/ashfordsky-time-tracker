-- =============================================================================
-- 0001_time_tracker_init.sql
-- Additive schema for the Ashford Sky time tracker.
--
-- Design rules:
--   * Everything lives in the `time_tracker` schema. Nothing in `public` is
--     altered. The only coupling is FK references TO public.clients /
--     public.client_groups (ON DELETE SET NULL / CASCADE on our side only).
--   * Raw sensor data is stored separately from resolved attribution so that
--     classification can be re-run later without re-ingesting.
--   * The time_tracker schema is intentionally NOT exposed to PostgREST; all
--     access is via a direct Postgres connection (DATABASE_URL).
-- =============================================================================

create schema if not exists time_tracker;

-- ---------- enums -----------------------------------------------------------
do $$ begin
  create type time_tracker.attribution_status as enum
    ('unresolved','suggested','needs_review','auto_finalized','confirmed','nonbillable','rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type time_tracker.screenshot_status as enum
    ('not_needed','optional','needed','available','blocked','deleted');
exception when duplicate_object then null; end $$;

do $$ begin
  create type time_tracker.ocr_status as enum ('none','pending','done','failed');
exception when duplicate_object then null; end $$;

-- ---------- raw sensor events (immutable, re-classifiable) -------------------
create table if not exists time_tracker.raw_events (
  id              uuid primary key default gen_random_uuid(),
  source          text not null default 'activitywatch',
  hostname        text,
  bucket          text,
  event_type      text,                 -- window | afk | web
  app             text,
  window_title    text,
  url             text,
  afk             boolean,
  ts              timestamptz not null,
  duration_seconds numeric not null default 0,
  data            jsonb not null default '{}'::jsonb,
  dedupe_key      text unique,
  created_at      timestamptz not null default now()
);
create index if not exists raw_events_ts_idx   on time_tracker.raw_events (ts);
create index if not exists raw_events_type_idx on time_tracker.raw_events (event_type);

-- ---------- normalized intervals (merged, AFK-aware) ------------------------
create table if not exists time_tracker.intervals (
  id              uuid primary key default gen_random_uuid(),
  source          text not null default 'activitywatch',
  hostname        text,
  start_ts        timestamptz not null,
  end_ts          timestamptz not null,
  duration_seconds numeric not null,
  app             text,
  window_title    text,
  url             text,
  browser         text,
  is_afk          boolean not null default false,
  raw_event_ids   uuid[] not null default '{}',
  dedupe_key      text unique,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint intervals_time_order check (end_ts >= start_ts)
);
create index if not exists intervals_start_idx on time_tracker.intervals (start_ts);
create index if not exists intervals_app_idx   on time_tracker.intervals (app);

-- ---------- current resolution per interval (one row per interval) ----------
create table if not exists time_tracker.resolutions (
  id              uuid primary key default gen_random_uuid(),
  interval_id     uuid not null unique references time_tracker.intervals(id) on delete cascade,
  client_id       uuid references public.clients(id) on delete set null,
  client_group_id uuid references public.client_groups(id) on delete set null,
  status          time_tracker.attribution_status not null default 'unresolved',
  confidence      numeric not null default 0,
  resolver_type   text,
  is_billable     boolean not null default true,
  needs_review    boolean not null default false,
  evidence        jsonb not null default '{}'::jsonb,
  resolver_version text,
  resolved_at     timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists resolutions_client_idx      on time_tracker.resolutions (client_id);
create index if not exists resolutions_status_idx      on time_tracker.resolutions (status);
create index if not exists resolutions_resolved_at_idx on time_tracker.resolutions (resolved_at);

-- ---------- full resolver audit trail (append-only, every vote) -------------
create table if not exists time_tracker.resolution_audit (
  id            uuid primary key default gen_random_uuid(),
  interval_id   uuid not null references time_tracker.intervals(id) on delete cascade,
  resolver_type text not null,
  client_id     uuid,
  confidence    numeric not null default 0,
  matched       boolean not null default false,
  evidence      jsonb not null default '{}'::jsonb,
  ran_at        timestamptz not null default now()
);
create index if not exists resolution_audit_interval_idx on time_tracker.resolution_audit (interval_id);

-- ---------- review queue ----------------------------------------------------
create table if not exists time_tracker.review_queue (
  id          uuid primary key default gen_random_uuid(),
  interval_id uuid not null unique references time_tracker.intervals(id) on delete cascade,
  reason      text,
  priority    int not null default 0,
  status      text not null default 'open',     -- open | resolved | dismissed
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists review_queue_status_idx on time_tracker.review_queue (status, priority desc);

-- ---------- durable rules learned from corrections (the learning store) -----
create table if not exists time_tracker.attribution_rules (
  id            uuid primary key default gen_random_uuid(),
  rule_type     text not null,   -- email_domain|email|google_sheet_id|google_drive_folder|
                                  -- sharepoint_folder|cch_client_id|qbo_company|qbo_realm|
                                  -- financial_cents_id|url_host|url_pattern|title_pattern|app
  match_kind    text not null default 'exact',  -- exact|contains|prefix|suffix|regex|domain
  pattern       text not null,
  normalized    text,
  client_id     uuid references public.clients(id) on delete cascade,
  client_group_id uuid references public.client_groups(id) on delete set null,
  source_system text,            -- optional: maps to public.source_systems.key
  confidence    numeric not null default 0.97,
  is_billable   boolean,
  enabled       boolean not null default true,
  priority      int not null default 100,
  created_from_correction_id uuid,
  hit_count     int not null default 0,
  last_hit_at   timestamptz,
  created_by    text not null default 'darin@ashfordsky.com',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists attribution_rules_uniq
  on time_tracker.attribution_rules (rule_type, match_kind, normalized);
create index if not exists attribution_rules_lookup_idx
  on time_tracker.attribution_rules (rule_type, enabled);

-- ---------- corrections (every user action, with provenance) ----------------
create table if not exists time_tracker.corrections (
  id            uuid primary key default gen_random_uuid(),
  interval_id   uuid references time_tracker.intervals(id) on delete set null,
  action        text not null,   -- confirm|change_client|nonbillable|split|merge|create_rule|
                                  -- map_sheet|map_folder|map_url|map_domain|map_missive|
                                  -- map_cch|map_qbo|delete_screenshot|never_screenshot
  old_client_id uuid,
  new_client_id uuid references public.clients(id) on delete set null,
  note          text,
  payload       jsonb not null default '{}'::jsonb,
  created_rule_id uuid references time_tracker.attribution_rules(id) on delete set null,
  created_by    text not null default 'darin@ashfordsky.com',
  created_at    timestamptz not null default now()
);
create index if not exists corrections_interval_idx on time_tracker.corrections (interval_id);

-- ---------- screenshots (conditional evidence) ------------------------------
create table if not exists time_tracker.screenshots (
  id            uuid primary key default gen_random_uuid(),
  interval_id   uuid references time_tracker.intervals(id) on delete set null,
  status        time_tracker.screenshot_status not null default 'not_needed',
  reason        text,
  storage_kind  text not null default 'local',  -- local | sharepoint
  storage_path  text,
  file_url      text,
  sha256        text,
  width         int,
  height        int,
  bytes         bigint,
  app           text,
  window_title  text,
  captured_at   timestamptz,
  ocr_status    time_tracker.ocr_status not null default 'none',
  ocr_text      text,
  ocr_ran_at    timestamptz,
  deleted_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists screenshots_interval_idx on time_tracker.screenshots (interval_id);
create index if not exists screenshots_status_idx   on time_tracker.screenshots (status);

-- ---------- screenshot policies ---------------------------------------------
create table if not exists time_tracker.screenshot_policies (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null unique,
  enabled                 boolean not null default true,
  only_below_confidence   numeric not null default 0.5,  -- capture only when conf < this
  min_stable_seconds      int not null default 20,
  capture_interval_seconds int not null default 120,
  retention_days          int not null default 14,
  applies_scope           text not null default 'low_confidence', -- low_confidence|app|domain|title|all
  applies_pattern         text,
  created_at              timestamptz not null default now()
);
insert into time_tracker.screenshot_policies
  (name, enabled, only_below_confidence, min_stable_seconds, capture_interval_seconds, retention_days, applies_scope)
values ('default', true, 0.5, 20, 120, 14, 'low_confidence')
on conflict (name) do nothing;

-- ---------- exclusions (attribution + screenshot) ---------------------------
create table if not exists time_tracker.exclusions (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,                       -- no_screenshot | nonbillable | ignore
  field       text not null default 'app',         -- app | domain | url | title
  match_kind  text not null default 'contains',    -- exact|contains|prefix|suffix|regex|domain
  pattern     text not null,
  normalized  text,
  reason      text,
  enabled     boolean not null default true,
  created_by  text not null default 'darin@ashfordsky.com',
  created_at  timestamptz not null default now()
);
create index if not exists exclusions_kind_idx on time_tracker.exclusions (kind, enabled);

-- ---------- rolling current-client anchors (auditable context) --------------
create table if not exists time_tracker.current_client_state (
  id                uuid primary key default gen_random_uuid(),
  as_of             timestamptz not null,
  client_id         uuid references public.clients(id) on delete set null,
  client_group_id   uuid references public.client_groups(id) on delete set null,
  confidence        numeric not null default 0,
  anchor_resolver_type text,
  source_interval_id uuid references time_tracker.intervals(id) on delete set null,
  created_at        timestamptz not null default now()
);
create index if not exists current_client_state_asof_idx on time_tracker.current_client_state (as_of desc);

-- ---------- accuracy snapshots (track day-1 vs day-7 improvement) -----------
create table if not exists time_tracker.accuracy_snapshots (
  id            uuid primary key default gen_random_uuid(),
  snapshot_date date not null,
  window_label  text,
  metrics       jsonb not null,
  created_at    timestamptz not null default now()
);

-- ---------- editable settings (thresholds, etc.) ----------------------------
create table if not exists time_tracker.settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------- reporting views -------------------------------------------------
-- Per-day, per-client rollup (local time = America/Denver). Used by billing CSV.
create or replace view time_tracker.daily_client_summary as
select
  (i.start_ts at time zone 'America/Denver')::date as day,
  r.client_id,
  r.client_group_id,
  c.name as client_name,
  sum(i.duration_seconds) as total_seconds,
  sum(i.duration_seconds) filter (where r.is_billable and r.status in ('auto_finalized','confirmed','suggested')) as billable_seconds,
  sum(i.duration_seconds) filter (where (not r.is_billable) or r.status = 'nonbillable') as nonbillable_seconds,
  sum(i.duration_seconds) filter (where r.needs_review or r.status = 'needs_review') as needs_review_seconds,
  sum(i.duration_seconds * r.confidence) as confidence_weighted_seconds,
  count(*) as interval_count
from time_tracker.intervals i
join time_tracker.resolutions r on r.interval_id = i.id
left join public.clients c on c.id = r.client_id
where not i.is_afk
group by 1,2,3,4;

-- Per-day coverage/accuracy rollup. Used by the accuracy report.
create or replace view time_tracker.coverage_report as
select
  (i.start_ts at time zone 'America/Denver')::date as day,
  sum(i.duration_seconds) as active_seconds,
  sum(i.duration_seconds) filter (where r.status = 'auto_finalized') as auto_finalized_seconds,
  sum(i.duration_seconds) filter (where r.status = 'confirmed')      as confirmed_seconds,
  sum(i.duration_seconds) filter (where r.status = 'suggested')      as suggested_seconds,
  sum(i.duration_seconds) filter (where r.needs_review or r.status = 'needs_review') as needs_review_seconds,
  sum(i.duration_seconds) filter (where r.status = 'unresolved' or r.client_id is null) as unresolved_seconds,
  sum(i.duration_seconds) filter (where exists (
      select 1 from time_tracker.screenshots s
      where s.interval_id = i.id and s.status = 'available')) as screenshot_supported_seconds
from time_tracker.intervals i
left join time_tracker.resolutions r on r.interval_id = i.id
where not i.is_afk
group by 1;
