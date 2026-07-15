-- Billing rule: any time attributed to a client is billable — including
-- low-confidence (needs_review / "Uncertain") blocks. Previously billable_seconds
-- counted only auto_finalized + confirmed + suggested, so Uncertain client time
-- was dropped from the "Billable" totals on Today, Reporting, and the CSV export.
-- Firm policy (Darin): if it's on a client, it's billed; confidence is a separate
-- review signal, not a billing gate. The `client_id is not null` guard keeps
-- client-less needs_review (rare) out of billable. coverage_report is unchanged —
-- it drives the confidence/accuracy breakdown, which is deliberately distinct.
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
  sum(secs) filter (where client_id is not null
                      and bucket in ('auto_finalized','confirmed','suggested','needs_review')) as billable_seconds,
  count(*)                                               as interval_count
from classified
group by 1, 2, 3, 4, 5;
