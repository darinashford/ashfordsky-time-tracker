-- 0013_restore_client_group_source.sql
--
-- REGRESSION FIX. One client (e.g. "DealNow") rendered as SEVERAL rows in
-- "Hours by client", each with a slice of the time.
--
-- History: 0007 fixed exactly this by sourcing client_group_id from the canonical
-- public.clients row. 0009 (billable_includes_needs_review) then recreated the
-- view starting from 0004's older text and silently reverted 0007 — reintroducing
-- resolutions.client_group_id, which is stamped per-resolution and is null on some
-- rows and set on others for the SAME client. Grouping on that shatters a client
-- into one row per distinct group value.
--
-- This restores 0007's canonical source AND keeps 0009's billable rule.
--
-- ⚠ If you ever recreate this view again, keep BOTH:
--     1. client_group_id + client_name come from public.clients (c.*), never r.*
--     2. billable_seconds includes needs_review, guarded by client_id is not null
create or replace view time_tracker.daily_client_summary as
with classified as (
  select (i.start_ts at time zone 'America/Denver')::date as day,
         i.hostname,
         r.client_id,
         -- CANONICAL source: one client -> exactly one group -> exactly one row.
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
       sum(secs) filter (where bucket = 'confirmed')      as confirmed_seconds,
       sum(secs) filter (where bucket = 'suggested')      as suggested_seconds,
       sum(secs) filter (where bucket = 'needs_review')   as needs_review_seconds,
       sum(secs) filter (where bucket = 'unresolved')     as unresolved_seconds,
       sum(secs) filter (where bucket = 'nonbillable')    as nonbillable_seconds,
       -- 0009: any client-attributed time is billable, including low-confidence.
       sum(secs) filter (where client_id is not null
                           and bucket = any (array['auto_finalized','confirmed','suggested','needs_review']))
                                                          as billable_seconds,
       count(*) as interval_count
from classified
group by day, hostname, client_id, client_group_id, client_name;
