-- Separate non-billable from "unresolved" in the coverage report.
-- The original view counted any null-client interval (which includes bucketed
-- non-billable time) as "unresolved", making the coverage bar read e.g. "57%
-- unresolved" when most of that was correctly-categorized non-billable.
-- Now: unresolved = no resolution (sub-min flickers) or status 'unresolved';
-- non-billable is its own column. New column is appended at the end so
-- CREATE OR REPLACE VIEW is valid (it cannot reorder/rename existing columns).
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
  sum(i.duration_seconds) filter (where r.status = 'nonbillable') as nonbillable_seconds
from time_tracker.intervals i
left join time_tracker.resolutions r on r.interval_id = i.id
where not i.is_afk
group by ((i.start_ts at time zone 'America/Denver')::date);
