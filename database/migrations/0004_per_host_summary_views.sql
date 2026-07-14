-- Multi-user support: make the summary views machine-aware so several people
-- (one machine each) can share the DB and be viewed separately. hostname joins
-- the grain of both views; the report functions re-aggregate across hosts for
-- the firm-wide view or filter to one host for a per-person view.
drop view if exists time_tracker.daily_client_summary;
create view time_tracker.daily_client_summary as
with classified as (
  select
    (i.start_ts at time zone 'America/Denver')::date as day,
    i.hostname,
    r.client_id,
    r.client_group_id,
    c.name as client_name,
    i.duration_seconds as secs,
    case
      when r.status = 'nonbillable' or coalesce(r.is_billable, true) = false then 'nonbillable'
      when r.status = 'needs_review' or coalesce(r.needs_review, false)       then 'needs_review'
      when r.status = 'auto_finalized'                                        then 'auto_finalized'
      when r.status = 'confirmed'                                             then 'confirmed'
      when r.status = 'suggested'                                             then 'suggested'
      else 'unresolved'
    end as bucket
  from time_tracker.intervals i
  left join time_tracker.resolutions r on r.interval_id = i.id
  left join public.clients c on c.id = r.client_id
  where not i.is_afk
)
select
  day, hostname, client_id, client_group_id, client_name,
  sum(secs)                                              as total_seconds,
  sum(secs) filter (where bucket = 'auto_finalized')     as auto_finalized_seconds,
  sum(secs) filter (where bucket = 'confirmed')          as confirmed_seconds,
  sum(secs) filter (where bucket = 'suggested')          as suggested_seconds,
  sum(secs) filter (where bucket = 'needs_review')       as needs_review_seconds,
  sum(secs) filter (where bucket = 'unresolved')         as unresolved_seconds,
  sum(secs) filter (where bucket = 'nonbillable')        as nonbillable_seconds,
  sum(secs) filter (where bucket in ('auto_finalized','confirmed','suggested')) as billable_seconds,
  count(*)                                               as interval_count
from classified
group by 1, 2, 3, 4, 5;

drop view if exists time_tracker.coverage_report;
create view time_tracker.coverage_report as
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
where not i.is_afk
group by ((i.start_ts at time zone 'America/Denver')::date), i.hostname;
