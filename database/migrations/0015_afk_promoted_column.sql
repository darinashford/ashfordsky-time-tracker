-- 0015_afk_promoted_column.sql
--
-- Root fix for the idle tug-of-war. The 15-minute idle grace is enforced by the
-- RESOLVER (it promotes short no-input runs back to "worked"), but it persisted
-- that promotion by writing is_afk=false into the SAME column the SENSOR owns.
-- Every 10-minute agent sync re-posted the sensor's is_afk=true over it (the
-- ingest upsert sets is_afk = excluded.is_afk), so promotions flapped: whoever
-- wrote last won. Keith's day showed 82 minutes of sub-grace pauses as "not
-- worked" because his agent had synced after the last resolve.
--
-- Fix: promotion becomes its own column. The sensor keeps is_afk; the resolver
-- keeps afk_promoted; the ingest upsert NEVER touches afk_promoted. Worked time
-- everywhere = (not is_afk OR afk_promoted).
alter table time_tracker.intervals
  add column if not exists afk_promoted boolean not null default false;

-- ⚠ Recreating either view below? Keep ALL of:
--   1. worked = (not i.is_afk or i.afk_promoted)          (this migration)
--   2. client_group_id + client_name from public.clients  (0007/0013)
--   3. billable includes needs_review, client_id not null (0009/0013)
create or replace view time_tracker.daily_client_summary as
with classified as (
  select (i.start_ts at time zone 'America/Denver')::date as day,
         i.hostname,
         r.client_id,
         c.client_group_id,
         c.name as client_name,
         i.duration_seconds as secs,
         case
           when r.status = 'nonbillable'::time_tracker.attribution_status or coalesce(r.is_billable, true) = false then 'nonbillable'
           when r.status = 'needs_review'::time_tracker.attribution_status or coalesce(r.needs_review, false) then 'needs_review'
           when r.status = 'auto_finalized'::time_tracker.attribution_status then 'auto_finalized'
           when r.status = 'confirmed'::time_tracker.attribution_status then 'confirmed'
           when r.status = 'suggested'::time_tracker.attribution_status then 'suggested'
           else 'unresolved'
         end as bucket
  from time_tracker.intervals i
  left join time_tracker.resolutions r on r.interval_id = i.id
  left join public.clients c on c.id = r.client_id
  where (not i.is_afk or i.afk_promoted)
)
select day, hostname, client_id, client_group_id, client_name,
       sum(secs) as total_seconds,
       sum(secs) filter (where bucket = 'auto_finalized') as auto_finalized_seconds,
       sum(secs) filter (where bucket = 'confirmed')      as confirmed_seconds,
       sum(secs) filter (where bucket = 'suggested')      as suggested_seconds,
       sum(secs) filter (where bucket = 'needs_review')   as needs_review_seconds,
       sum(secs) filter (where bucket = 'unresolved')     as unresolved_seconds,
       sum(secs) filter (where bucket = 'nonbillable')    as nonbillable_seconds,
       sum(secs) filter (where client_id is not null
                           and bucket = any (array['auto_finalized','confirmed','suggested','needs_review']))
                                                          as billable_seconds,
       count(*) as interval_count
from classified
group by day, hostname, client_id, client_group_id, client_name;

create or replace view time_tracker.coverage_report as
select (i.start_ts at time zone 'America/Denver')::date as day,
  sum(i.duration_seconds) as active_seconds,
  sum(i.duration_seconds) filter (where r.status = 'auto_finalized') as auto_finalized_seconds,
  sum(i.duration_seconds) filter (where r.status = 'confirmed') as confirmed_seconds,
  sum(i.duration_seconds) filter (where r.status = 'suggested') as suggested_seconds,
  sum(i.duration_seconds) filter (where r.status = 'needs_review') as needs_review_seconds,
  sum(i.duration_seconds) filter (where r.id is null or r.status = 'unresolved') as unresolved_seconds,
  sum(i.duration_seconds) filter (where exists (
    select 1 from time_tracker.screenshots s
    where s.interval_id = i.id and s.status = 'available')) as screenshot_supported_seconds,
  sum(i.duration_seconds) filter (where r.status = 'nonbillable') as nonbillable_seconds,
  i.hostname
from time_tracker.intervals i
left join time_tracker.resolutions r on r.interval_id = i.id
where (not i.is_afk or i.afk_promoted)
group by ((i.start_ts at time zone 'America/Denver')::date), i.hostname;
