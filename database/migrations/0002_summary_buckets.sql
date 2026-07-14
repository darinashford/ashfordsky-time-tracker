-- =============================================================================
-- 0002_summary_buckets.sql
-- Make daily_client_summary tie out: every non-AFK second lands in EXACTLY one
-- disposition bucket, so the per-client columns sum to total_seconds and the
-- grand total ties to coverage_report.active_seconds.
--
-- What changed vs 0001:
--   * LEFT JOIN resolutions (was INNER) so intervals with no resolution still
--     count toward total — they show up as `unresolved`. Previously they were
--     silently dropped, so the table never reached the Active total.
--   * Buckets are now a MECE partition via a single priority CASE:
--       nonbillable > needs_review > auto_finalized > confirmed > suggested > unresolved
--     (precedence resolves the old double-count where a `suggested` row that was
--     also flagged needs_review landed in both billable and needs_review.)
--   * Exposed auto_finalized / confirmed / suggested / unresolved as columns.
--   * Dropped confidence_weighted_seconds (a diagnostic that didn't partition
--     total and confused the tie-out). billable_seconds is kept as a convenience
--     = auto_finalized + confirmed + suggested.
--
-- Reversible: 0001 holds the prior definition; re-running it restores it.
-- (DROP + CREATE rather than CREATE OR REPLACE because the column list is
-- reordered/renamed, which CREATE OR REPLACE VIEW forbids. The view has no
-- dependents — only the app reads it directly.)
-- =============================================================================

drop view if exists time_tracker.daily_client_summary;

create view time_tracker.daily_client_summary as
with classified as (
  select
    (i.start_ts at time zone 'America/Denver')::date as day,
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
      else 'unresolved'   -- unresolved, rejected, or no resolution row at all
    end as bucket
  from time_tracker.intervals i
  left join time_tracker.resolutions r on r.interval_id = i.id
  left join public.clients c on c.id = r.client_id
  where not i.is_afk
)
select
  day,
  client_id,
  client_group_id,
  client_name,
  sum(secs)                                              as total_seconds,
  sum(secs) filter (where bucket = 'auto_finalized')     as auto_finalized_seconds,
  sum(secs) filter (where bucket = 'confirmed')          as confirmed_seconds,
  sum(secs) filter (where bucket = 'suggested')          as suggested_seconds,
  sum(secs) filter (where bucket = 'needs_review')       as needs_review_seconds,
  sum(secs) filter (where bucket = 'unresolved')         as unresolved_seconds,
  sum(secs) filter (where bucket = 'nonbillable')        as nonbillable_seconds,
  -- convenience: the part you can bill = finalized + confirmed + suggested
  sum(secs) filter (where bucket in ('auto_finalized','confirmed','suggested')) as billable_seconds,
  count(*)                                               as interval_count
from classified
group by 1, 2, 3, 4;
