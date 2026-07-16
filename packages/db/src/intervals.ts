import type pg from 'pg';
import type { Interval } from '@tt/shared';
import { validIdent } from './pool';

/** A pool or a checked-out client — lets the ingest run these in one transaction. */
type Queryable = pg.Pool | pg.PoolClient;

export interface RawEventInput {
  source: string;
  hostname?: string | null;
  bucket?: string | null;
  eventType: string;
  app?: string | null;
  windowTitle?: string | null;
  url?: string | null;
  afk?: boolean | null;
  ts: string;
  durationSeconds: number;
  data?: Record<string, unknown>;
  dedupeKey: string;
}

export interface IntervalInput {
  source: string;
  hostname?: string | null;
  startTs: string;
  endTs: string;
  durationSeconds: number;
  app?: string | null;
  windowTitle?: string | null;
  url?: string | null;
  browser?: string | null;
  isAfk: boolean;
  dedupeKey: string;
}

/** Bulk insert raw sensor events, skipping anything already ingested. */
export async function insertRawEvents(
  pool: Queryable,
  schema: string,
  events: RawEventInput[],
): Promise<number> {
  const s = validIdent(schema);
  if (events.length === 0) return 0;
  const payload = events.map((e) => ({
    source: e.source,
    hostname: e.hostname ?? null,
    bucket: e.bucket ?? null,
    event_type: e.eventType,
    app: e.app ?? null,
    window_title: e.windowTitle ?? null,
    url: e.url ?? null,
    afk: e.afk ?? null,
    ts: e.ts,
    duration_seconds: e.durationSeconds,
    data: e.data ?? {},
    dedupe_key: e.dedupeKey,
  }));
  const res = await pool.query(
    `insert into ${s}.raw_events
       (source,hostname,bucket,event_type,app,window_title,url,afk,ts,duration_seconds,data,dedupe_key)
     select source,hostname,bucket,event_type,app,window_title,url,afk,ts::timestamptz,duration_seconds,
            coalesce(data,'{}'::jsonb),dedupe_key
       from jsonb_to_recordset($1::jsonb) as x(
         source text, hostname text, bucket text, event_type text, app text, window_title text,
         url text, afk boolean, ts text, duration_seconds numeric, data jsonb, dedupe_key text)
     on conflict (dedupe_key) do nothing`,
    [JSON.stringify(payload)],
  );
  return res.rowCount ?? 0;
}

/**
 * Upsert intervals by dedupe_key in a SINGLE batched statement; returns them
 * WITH their persisted ids. Runs on the passed pool/client so the ingest can
 * wrap clear+insert in one transaction (a crash rolls back instead of losing
 * data). One round-trip instead of N keeps a 24h re-ingest fast enough that it
 * can't be killed mid-write.
 */
export async function upsertIntervals(
  pool: Queryable,
  schema: string,
  intervals: IntervalInput[],
): Promise<Interval[]> {
  const s = validIdent(schema);
  if (intervals.length === 0) return [];
  const payload = intervals.map((iv) => ({
    source: iv.source,
    hostname: iv.hostname ?? null,
    start_ts: iv.startTs,
    end_ts: iv.endTs,
    duration_seconds: iv.durationSeconds,
    app: iv.app ?? null,
    window_title: iv.windowTitle ?? null,
    url: iv.url ?? null,
    browser: iv.browser ?? null,
    is_afk: iv.isAfk,
    dedupe_key: iv.dedupeKey,
  }));
  const res = await pool.query(
    `insert into ${s}.intervals
       (source,hostname,start_ts,end_ts,duration_seconds,app,window_title,url,browser,is_afk,dedupe_key)
     select source,hostname,start_ts::timestamptz,end_ts::timestamptz,duration_seconds,
            app,window_title,url,browser,is_afk,dedupe_key
       from jsonb_to_recordset($1::jsonb) as x(
         source text, hostname text, start_ts text, end_ts text, duration_seconds numeric,
         app text, window_title text, url text, browser text, is_afk boolean, dedupe_key text)
     on conflict (dedupe_key) do update set
       end_ts = excluded.end_ts,
       duration_seconds = excluded.duration_seconds,
       app = excluded.app,
       window_title = excluded.window_title,
       url = excluded.url,
       browser = excluded.browser,
       is_afk = excluded.is_afk,
       updated_at = now()
     returning id, source, hostname, start_ts as "startTs", end_ts as "endTs",
               duration_seconds as "durationSeconds", app, window_title as "windowTitle",
               url, browser, is_afk as "isAfk"`,
    [JSON.stringify(payload)],
  );
  return res.rows.map((row) => ({
    ...(row as Interval & { durationSeconds: string }),
    durationSeconds: Number(row.durationSeconds),
  }));
}

/**
 * Clear a time range for a clean re-ingest: drop raw events in range, and drop
 * machine-owned intervals in range. Intervals carrying work that can't be
 * re-derived — your hand corrections ('manual') and paid AI judgements ('llm') —
 * are preserved, matching pruneIntervalsExcept.
 */
export async function clearIngestRange(
  pool: Queryable,
  schema: string,
  since: string,
  until: string,
  opts: { fullClear?: boolean; host?: string | null } = {},
): Promise<void> {
  const s = validIdent(schema);
  // Never delete past days — only clear from local midnight today onward, so a
  // rolling 24h re-ingest can't churn yesterday's attributions (earlier intervals
  // are refreshed in place by the upsert). fullClear bypasses this for an explicit
  // backfill/rebase of a wider window.
  const lower = opts.fullClear
    ? '$1::timestamptz'
    : `greatest($1::timestamptz, date_trunc('day', now() at time zone 'America/Denver') at time zone 'America/Denver')`;
  // Host scope: only ever touch THIS machine's rows, so one person's sync can't
  // delete another person's data from the shared DB. null = all (single-user).
  const host = opts.host ?? null;
  await pool.query(
    `delete from ${s}.raw_events where ts >= ${lower} and ts < $2::timestamptz and ($3::text is null or hostname = $3)`,
    [since, until, host],
  );
  await pool.query(
    `delete from ${s}.intervals i
      where i.start_ts >= ${lower} and i.start_ts < $2::timestamptz
        and ($3::text is null or i.hostname = $3)
        and not exists (
          select 1 from ${s}.resolutions r
           where r.interval_id = i.id and r.resolver_version in ('manual','llm')
        )`,
    [since, until, host],
  );
}

/**
 * Incremental-ingest sweep: drop only the machine intervals for today that are
 * NO LONGER produced by the current merge (their dedupe_key isn't in keepKeys) —
 * e.g. a run that split/merged differently. Everything still present is left in
 * place by the upsert, so its resolution survives (no more wiping the whole day's
 * attribution every cycle). Hand/AI-corrected intervals (resolver_version manual
 * or llm) are never swept. Clamped to today onward so past days are untouched.
 */
export async function pruneIntervalsExcept(
  pool: Queryable,
  schema: string,
  since: string,
  until: string,
  keepKeys: string[],
  host?: string | null,
): Promise<number> {
  const s = validIdent(schema);
  if (keepKeys.length === 0) return 0; // never sweep everything (empty merge = leave as-is)
  const lower = `greatest($1::timestamptz, date_trunc('day', now() at time zone 'America/Denver') at time zone 'America/Denver')`;
  const res = await pool.query(
    `delete from ${s}.intervals i
      where i.start_ts >= ${lower} and i.start_ts < $2::timestamptz
        and ($4::text is null or i.hostname = $4)
        and not (i.dedupe_key = any($3::text[]))
        and not exists (
          select 1 from ${s}.resolutions r
           where r.interval_id = i.id and r.resolver_version in ('manual','llm')
        )`,
    [since, until, keepKeys, host ?? null],
  );
  return res.rowCount ?? 0;
}

/**
 * Flip is_afk for a set of intervals. The resolver promotes billable idle —
 * meeting/reading time AW logged as idle because you weren't typing — into
 * active (is_afk=false) so it counts toward active/billable everywhere. A
 * re-ingest re-normalizes is_afk from the raw events, and the next resolve pass
 * re-promotes, so this stays self-correcting.
 */
export async function setIntervalsAfk(
  pool: Queryable,
  schema: string,
  ids: string[],
  isAfk: boolean,
): Promise<void> {
  if (ids.length === 0) return;
  const s = validIdent(schema);
  await pool.query(
    `update ${s}.intervals set is_afk = $2, updated_at = now() where id = any($1::uuid[])`,
    [ids, isAfk],
  );
}

/** Intervals with no resolution yet (or still 'unresolved'), worth attributing. */
export async function getUnresolvedIntervals(
  pool: pg.Pool,
  schema: string,
  opts: { since?: string; until?: string; minSeconds?: number; limit?: number } = {},
): Promise<Interval[]> {
  const s = validIdent(schema);
  const res = await pool.query(
    `select i.id, i.source, i.hostname, i.start_ts as "startTs", i.end_ts as "endTs",
            i.duration_seconds as "durationSeconds", i.app, i.window_title as "windowTitle",
            i.url, i.browser, i.is_afk as "isAfk"
       from ${s}.intervals i
       left join ${s}.resolutions r on r.interval_id = i.id
      where i.is_afk = false
        and i.duration_seconds >= $1
        and (r.id is null or r.status = 'unresolved')
        and ($2::timestamptz is null or i.start_ts >= $2)
        and ($3::timestamptz is null or i.start_ts < $3)
      order by i.start_ts asc
      limit $4`,
    [opts.minSeconds ?? 0, opts.since ?? null, opts.until ?? null, opts.limit ?? 100000],
  );
  return res.rows.map((r) => ({ ...r, durationSeconds: Number(r.durationSeconds) })) as Interval[];
}

/** All intervals for a local day (used by the resolver runner for context). */
export async function getIntervalsForDay(
  pool: pg.Pool,
  schema: string,
  day: string,
  tz: string,
): Promise<Interval[]> {
  const s = validIdent(schema);
  const res = await pool.query(
    `select id, source, hostname, start_ts as "startTs", end_ts as "endTs",
            duration_seconds as "durationSeconds", app, window_title as "windowTitle",
            url, browser, is_afk as "isAfk"
       from ${s}.intervals
      where (start_ts at time zone $2)::date = $1::date
      order by start_ts asc`,
    [day, tz],
  );
  return res.rows.map((r) => ({ ...r, durationSeconds: Number(r.durationSeconds) })) as Interval[];
}
