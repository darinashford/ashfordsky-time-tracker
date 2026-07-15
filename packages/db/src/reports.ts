import type pg from 'pg';
import type { CoverageReportRow, DailyClientSummaryRow } from '@tt/shared';
import { validIdent } from './pool';

// Every report accepts an optional `host` (machine/person). null/undefined =
// firm-wide (all machines); a value scopes to that one person's data. The
// summary views carry a hostname grain, so the view-based reports sum across
// hosts when host is null and filter to one host otherwise.

/** Distinct machines that have reported activity — powers the "whose time" picker. */
export async function getHosts(pool: pg.Pool, schema: string): Promise<string[]> {
  const s = validIdent(schema);
  const res = await pool.query(
    `select distinct hostname from ${s}.intervals where hostname is not null and hostname <> '' order by hostname`,
  );
  return res.rows.map((r) => r.hostname as string);
}

/** One row per interval for a local day, enriched for the review dashboard. */
export interface TimelineRow {
  id: string;
  startTs: string;
  endTs: string;
  durationSeconds: number;
  app: string | null;
  windowTitle: string | null;
  url: string | null;
  browser: string | null;
  isAfk: boolean;
  clientId: string | null;
  clientName: string | null;
  clientGroupId: string | null;
  status: string | null;
  confidence: number | null;
  resolverType: string | null;
  isBillable: boolean | null;
  needsReview: boolean | null;
  evidence: Record<string, unknown> | null;
  category: string | null;
  reviewStatus: string | null;
  screenshotStatus: string | null;
  screenshotId: string | null;
}

export async function getDayTimeline(
  pool: pg.Pool,
  schema: string,
  day: string,
  tz: string,
  host?: string | null,
): Promise<TimelineRow[]> {
  const s = validIdent(schema);
  const res = await pool.query(
    `select i.id, i.start_ts as "startTs", i.end_ts as "endTs",
            i.duration_seconds as "durationSeconds", i.app, i.window_title as "windowTitle",
            i.url, i.browser, i.is_afk as "isAfk",
            r.client_id as "clientId", c.name as "clientName", r.client_group_id as "clientGroupId",
            r.status, r.confidence, r.resolver_type as "resolverType",
            r.is_billable as "isBillable", r.needs_review as "needsReview", r.evidence, r.category,
            rq.status as "reviewStatus",
            ss.status as "screenshotStatus", ss.id as "screenshotId"
       from ${s}.intervals i
       left join ${s}.resolutions r on r.interval_id = i.id
       left join public.clients c on c.id = r.client_id
       left join ${s}.review_queue rq on rq.interval_id = i.id
       left join lateral (
         select id, status from ${s}.screenshots sc
          where sc.interval_id = i.id and sc.status <> 'deleted'
          order by sc.created_at desc limit 1
       ) ss on true
      where (i.start_ts at time zone $2)::date = $1::date
        and ($3::text is null or i.hostname = $3)
      order by i.start_ts asc`,
    [day, tz, host ?? null],
  );
  return res.rows.map((r) => ({
    ...r,
    durationSeconds: Number(r.durationSeconds),
    confidence: r.confidence == null ? null : Number(r.confidence),
  })) as TimelineRow[];
}

export async function getDailyClientSummary(
  pool: pg.Pool,
  schema: string,
  day: string,
  host?: string | null,
): Promise<DailyClientSummaryRow[]> {
  const s = validIdent(schema);
  const res = await pool.query(
    `select $1::text as day, client_id as "clientId", client_group_id as "clientGroupId",
            client_name as "clientName",
            coalesce(sum(total_seconds),0)::float          as "totalSeconds",
            coalesce(sum(auto_finalized_seconds),0)::float as "autoFinalizedSeconds",
            coalesce(sum(confirmed_seconds),0)::float      as "confirmedSeconds",
            coalesce(sum(suggested_seconds),0)::float      as "suggestedSeconds",
            coalesce(sum(needs_review_seconds),0)::float   as "needsReviewSeconds",
            coalesce(sum(unresolved_seconds),0)::float     as "unresolvedSeconds",
            coalesce(sum(nonbillable_seconds),0)::float    as "nonbillableSeconds",
            coalesce(sum(billable_seconds),0)::float       as "billableSeconds",
            coalesce(sum(interval_count),0)::int            as "intervalCount"
       from ${s}.daily_client_summary
      where day = $1::date and ($2::text is null or hostname = $2)
      group by client_id, client_group_id, client_name
      order by sum(total_seconds) desc nulls last`,
    [day, host ?? null],
  );
  return res.rows as DailyClientSummaryRow[];
}

export interface RangeClientRow {
  clientId: string | null;
  clientGroupId: string | null;
  clientName: string | null;
  totalSeconds: number;
  billableSeconds: number;
  nonbillableSeconds: number;
  needsReviewSeconds: number;
  unresolvedSeconds: number;
  intervalCount: number;
}

/**
 * Per-client totals summed over a local-date range [start, end] (inclusive),
 * from daily_client_summary. The client_id-null row carries non-billable +
 * unattributed time. Drives the week/month/year rollup views.
 */
export async function getRangeClientSummary(
  pool: pg.Pool,
  schema: string,
  start: string,
  end: string,
  host?: string | null,
): Promise<RangeClientRow[]> {
  const s = validIdent(schema);
  const res = await pool.query(
    `select client_id as "clientId", client_group_id as "clientGroupId", client_name as "clientName",
            coalesce(sum(total_seconds),0)::float        as "totalSeconds",
            coalesce(sum(billable_seconds),0)::float     as "billableSeconds",
            coalesce(sum(nonbillable_seconds),0)::float  as "nonbillableSeconds",
            coalesce(sum(needs_review_seconds),0)::float as "needsReviewSeconds",
            coalesce(sum(unresolved_seconds),0)::float   as "unresolvedSeconds",
            coalesce(sum(interval_count),0)::int          as "intervalCount"
       from ${s}.daily_client_summary
      where day between $1::date and $2::date and ($3::text is null or hostname = $3)
      group by client_id, client_group_id, client_name
      order by sum(total_seconds) desc nulls last`,
    [start, end, host ?? null],
  );
  return res.rows as RangeClientRow[];
}

export interface DataFreshness {
  lastActivity: string | null; // ISO of the newest interval end
  minutesAgo: number | null;
}

/** How recently the sync last ingested activity — powers the dashboard's
 *  "synced N min ago" health indicator so a stalled sync is visible. */
export async function getDataFreshness(
  pool: pg.Pool,
  schema: string,
  host?: string | null,
): Promise<DataFreshness> {
  const s = validIdent(schema);
  const res = await pool.query(
    `select max(end_ts) as "lastActivity",
            round(extract(epoch from (now() - max(end_ts))) / 60.0)::int as "minutesAgo"
       from ${s}.intervals
      where ($1::text is null or hostname = $1)`,
    [host ?? null],
  );
  const r = (res.rows[0] ?? {}) as { lastActivity: Date | string | null; minutesAgo: number | null };
  return {
    lastActivity: r.lastActivity ? new Date(r.lastActivity).toISOString() : null,
    minutesAgo: r.minutesAgo == null ? null : Number(r.minutesAgo),
  };
}

export async function getCoverage(
  pool: pg.Pool,
  schema: string,
  day: string,
  host?: string | null,
): Promise<CoverageReportRow> {
  const s = validIdent(schema);
  const res = await pool.query(
    `select $1::text as day,
            coalesce(sum(active_seconds),0)::float              as "activeSeconds",
            coalesce(sum(auto_finalized_seconds),0)::float      as "autoFinalizedSeconds",
            coalesce(sum(confirmed_seconds),0)::float           as "confirmedSeconds",
            coalesce(sum(suggested_seconds),0)::float           as "suggestedSeconds",
            coalesce(sum(needs_review_seconds),0)::float        as "needsReviewSeconds",
            coalesce(sum(unresolved_seconds),0)::float          as "unresolvedSeconds",
            coalesce(sum(nonbillable_seconds),0)::float         as "nonbillableSeconds",
            coalesce(sum(screenshot_supported_seconds),0)::float as "screenshotSupportedSeconds"
       from ${s}.coverage_report
      where day = $1::date and ($2::text is null or hostname = $2)`,
    [day, host ?? null],
  );
  return (
    (res.rows[0] as CoverageReportRow) ?? {
      day,
      activeSeconds: 0,
      autoFinalizedSeconds: 0,
      confirmedSeconds: 0,
      suggestedSeconds: 0,
      needsReviewSeconds: 0,
      unresolvedSeconds: 0,
      nonbillableSeconds: 0,
      screenshotSupportedSeconds: 0,
    }
  );
}

export interface UnresolvedBucket {
  app: string;
  host: string;
  intervals: number;
  seconds: number;
}

export interface CategoryBucket {
  category: string;
  intervals: number;
  seconds: number;
}

/** Non-billable time grouped by category bucket (social_media, music, firm_internal, ...). */
export async function getCategoryBreakdown(
  pool: pg.Pool,
  schema: string,
  day: string,
  tz: string,
  host?: string | null,
): Promise<CategoryBucket[]> {
  const s = validIdent(schema);
  const res = await pool.query(
    `select coalesce(r.category, 'uncategorized') as category,
            count(*)::int            as intervals,
            sum(i.duration_seconds)::int as seconds
       from ${s}.intervals i
       join ${s}.resolutions r on r.interval_id = i.id
      where i.is_afk = false
        and (r.status = 'nonbillable' or r.is_billable = false)
        and (i.start_ts at time zone $2)::date = $1::date
        and ($3::text is null or i.hostname = $3)
      group by 1
      order by seconds desc`,
    [day, tz, host ?? null],
  );
  return res.rows as CategoryBucket[];
}

export interface IdleBucket {
  kind: string;
  intervals: number;
  seconds: number;
}

/**
 * Idle (AFK) time grouped by what was on screen, so "idle" is explainable: a
 * left-running app (Claude / dev tools) or a specific app you stepped away from.
 * Locked-screen time is excluded — it's the only idle not counted in the total —
 * so this total ties to the per-client "Idle" row.
 */
export async function getIdleBreakdown(
  pool: pg.Pool,
  schema: string,
  day: string,
  tz: string,
  awayCutoffSeconds = 1800,
  host?: string | null,
): Promise<IdleBucket[]> {
  const s = validIdent(schema);
  // Only count SHORT idle as "at the desk." A single contiguous AFK stretch
  // longer than awayCutoffSeconds is genuinely away (lunch, a meeting elsewhere)
  // even if an app was left open, so it's excluded from on-computer idle — the
  // same cutoff the resolver uses to decide what idle to promote/bill. Runs are
  // back-to-back AFK intervals within 2 min of each other (gaps-and-islands).
  const res = await pool.query(
    `with afk as (
        select id, app, start_ts, duration_seconds,
               lag(end_ts) over (order by start_ts) as prev_end
          from ${s}.intervals
         where is_afk = true
           and lower(coalesce(app,'')) not like '%lockapp%'
           and (start_ts at time zone $2)::date = $1::date
           and ($4::text is null or hostname = $4)
     ),
     marked as (
        select *, case when prev_end is null or start_ts - prev_end > interval '120 seconds'
                       then 1 else 0 end as new_run
          from afk
     ),
     runs as (
        select *, sum(new_run) over (order by start_ts rows unbounded preceding) as run_id
          from marked
     ),
     run_tot as (select run_id, sum(duration_seconds) as run_seconds from runs group by run_id)
     select
        case
          when lower(coalesce(r.app,'')) like '%claude%' then 'Claude — left running'
          when lower(coalesce(r.app,'')) ~ '(windowsterminal|powershell|pwsh|conhost|wsl|node|vscode|code)' then 'Dev tools — left running'
          when coalesce(r.app,'') = '' then '(no window)'
          else regexp_replace(r.app, '\\.exe$', '')
        end                          as kind,
        count(*)::int                as intervals,
        sum(r.duration_seconds)::int as seconds
       from runs r
       join run_tot t on t.run_id = r.run_id
      where t.run_seconds <= $3
      group by 1
      order by seconds desc`,
    [day, tz, awayCutoffSeconds, host ?? null],
  );
  return res.rows as IdleBucket[];
}

/** Active (non-AFK) seconds summed across a date range, for the Reporting cards. */
export async function getRangeActiveSeconds(
  pool: pg.Pool,
  schema: string,
  start: string,
  end: string,
  host?: string | null,
): Promise<number> {
  const s = validIdent(schema);
  const res = await pool.query(
    `select coalesce(sum(active_seconds),0)::float as seconds
       from ${s}.coverage_report
      where day between $1::date and $2::date and ($3::text is null or hostname = $3)`,
    [start, end, host ?? null],
  );
  return Number((res.rows[0] as { seconds: number } | undefined)?.seconds ?? 0);
}

/** Counted (short) idle seconds across a date range. Uses the same per-day
 *  away-cutoff logic as getIdleBreakdown — run detection is partitioned by
 *  (host, day) so an AFK run never merges across midnight or across people —
 *  so summing days here ties to the day view's idle totals. Locked-screen
 *  time is excluded, matching Total-on-computer on Today. */
export async function getRangeIdleSeconds(
  pool: pg.Pool,
  schema: string,
  start: string,
  end: string,
  tz: string,
  awayCutoffSeconds = 1800,
  host?: string | null,
): Promise<number> {
  const s = validIdent(schema);
  const res = await pool.query(
    `with afk as (
        select duration_seconds, hostname, start_ts,
               (start_ts at time zone $3)::date as d,
               lag(end_ts) over (partition by hostname, (start_ts at time zone $3)::date order by start_ts) as prev_end
          from ${s}.intervals
         where is_afk = true
           and lower(coalesce(app,'')) not like '%lockapp%'
           and (start_ts at time zone $3)::date between $1::date and $2::date
           and ($5::text is null or hostname = $5)
     ),
     marked as (
        select *, case when prev_end is null or start_ts - prev_end > interval '120 seconds'
                       then 1 else 0 end as new_run
          from afk
     ),
     runs as (
        select *, sum(new_run) over (partition by hostname, d order by start_ts rows unbounded preceding) as run_id
          from marked
     ),
     run_tot as (select hostname, d, run_id, sum(duration_seconds) as run_seconds from runs group by hostname, d, run_id)
     select coalesce(sum(r.duration_seconds),0)::float as seconds
       from runs r
       join run_tot t on t.hostname = r.hostname and t.d = r.d and t.run_id = r.run_id
      where t.run_seconds <= $4`,
    [start, end, tz, awayCutoffSeconds, host ?? null],
  );
  return Number((res.rows[0] as { seconds: number } | undefined)?.seconds ?? 0);
}

/** Top apps/domains/titles still unresolved — drives the "what to map next" list. */
export async function getTopUnresolved(
  pool: pg.Pool,
  schema: string,
  day: string,
  tz: string,
  limit = 20,
  host?: string | null,
): Promise<UnresolvedBucket[]> {
  const s = validIdent(schema);
  const res = await pool.query(
    `select coalesce(nullif(i.app,''),'(unknown)') as app,
            coalesce(nullif(split_part(regexp_replace(coalesce(i.url,''),'^[a-z]+://',''),'/',1),''),'') as host,
            count(*)::int            as intervals,
            sum(i.duration_seconds)::int as seconds
       from ${s}.intervals i
       left join ${s}.resolutions r on r.interval_id = i.id
      where i.is_afk = false
        and (r.id is null or r.status in ('unresolved','needs_review'))
        and (i.start_ts at time zone $2)::date = $1::date
        and ($4::text is null or i.hostname = $4)
      group by 1,2
      order by seconds desc
      limit $3`,
    [day, tz, limit, host ?? null],
  );
  return res.rows as UnresolvedBucket[];
}
