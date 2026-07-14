-- 0007_fix_daily_summary_client_group_source.sql
-- Bug: the per-client summary (and the week/month/year rollups that read it) showed
-- a single client as several rows. Cause: daily_client_summary selected & grouped by
-- resolutions.client_group_id, which is stamped per-resolution and can be
-- inconsistent for one client_id (different groups, or null) — e.g. from tangled
-- aliases or manual edits. Grouping on that shattered one client into multiple rows.
--
-- Fix: take client_group_id from the canonical public.clients row (by client_id) so
-- one client is always exactly one row. View-only change; no app code or data change.
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
  where not i.is_afk
)
select day, hostname, client_id, client_group_id, client_name,
       sum(secs) as total_seconds,
       sum(secs) filter (where bucket = 'auto_finalized') as auto_finalized_seconds,
       sum(secs) filter (where bucket = 'confirmed') as confirmed_seconds,
       sum(secs) filter (where bucket = 'suggested') as suggested_seconds,
       sum(secs) filter (where bucket = 'needs_review') as needs_review_seconds,
       sum(secs) filter (where bucket = 'unresolved') as unresolved_seconds,
       sum(secs) filter (where bucket = 'nonbillable') as nonbillable_seconds,
       sum(secs) filter (where bucket = any (array['auto_finalized','confirmed','suggested'])) as billable_seconds,
       count(*) as interval_count
from classified
group by day, hostname, client_id, client_group_id, client_name;
