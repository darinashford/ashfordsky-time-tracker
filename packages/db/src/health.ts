import type pg from 'pg';
import { validIdent } from './pool';

// Early-warning telemetry for disk-IO exhaustion (the 2026-07-22 outage class).
// The IO budget is a daily burst bucket: charts read ~0% until one sustained
// heavy stretch drains it, then the instance crawls and retry churn keeps it
// pinned. Row-write rate and table growth are the leading indicators — they're
// visible days before the cliff, so the nightly audit snapshots and compares.

export interface HealthSnapshot {
  totalWrites: number;
  deadTuples: number;
  dbBytes: number;
  tables: Record<string, number>; // per-table cumulative writes
}

export interface HealthDelta {
  hours: number;
  writesPerDay: number;
  growthBytesPerDay: number;
  topTables: Array<{ table: string; writesPerDay: number }>;
  /** True when counters went backwards (Postgres stats reset — restart/resize);
   *  deltas are meaningless for this period and no alert should fire. */
  statsReset: boolean;
}

async function readCurrent(pool: pg.Pool, schema: string): Promise<HealthSnapshot> {
  const s = validIdent(schema);
  const res = await pool.query(
    `select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::bigint as writes,
            coalesce(sum(n_dead_tup), 0)::bigint as dead,
            pg_database_size(current_database())::bigint as bytes,
            coalesce(jsonb_object_agg(relname, (n_tup_ins + n_tup_upd + n_tup_del))
                     filter (where relname is not null), '{}'::jsonb) as tables
       from pg_stat_user_tables
      where schemaname = '${s}'`,
  );
  const r = res.rows[0] as { writes: string; dead: string; bytes: string; tables: Record<string, number> };
  return {
    totalWrites: Number(r.writes),
    deadTuples: Number(r.dead),
    dbBytes: Number(r.bytes),
    tables: Object.fromEntries(Object.entries(r.tables ?? {}).map(([k, v]) => [k, Number(v)])),
  };
}

/**
 * Take today's snapshot, compare against the newest previous one, and persist.
 * Returns null when there is no prior snapshot (first run) or it is under an
 * hour old (nothing meaningful to normalize).
 */
export async function takeHealthSnapshot(pool: pg.Pool, schema: string): Promise<HealthDelta | null> {
  const s = validIdent(schema);
  const cur = await readCurrent(pool, schema);
  const prevRes = await pool.query(
    `select taken_at, total_writes, db_bytes, tables
       from ${s}.db_health_snapshots order by taken_at desc limit 1`,
  );
  await pool.query(
    `insert into ${s}.db_health_snapshots (total_writes, dead_tuples, db_bytes, tables)
     values ($1, $2, $3, $4::jsonb)`,
    [cur.totalWrites, cur.deadTuples, cur.dbBytes, JSON.stringify(cur.tables)],
  );
  // Keep a year of daily snapshots at most; this table must never become its
  // own growth problem.
  await pool.query(`delete from ${s}.db_health_snapshots where taken_at < now() - interval '365 days'`);

  const prev = prevRes.rows[0] as
    | { taken_at: Date; total_writes: string; db_bytes: string; tables: Record<string, number> }
    | undefined;
  if (!prev) return null;
  const hours = (Date.now() - new Date(prev.taken_at).getTime()) / 3_600_000;
  if (hours < 1) return null;

  const writesDelta = cur.totalWrites - Number(prev.total_writes);
  const perDay = (n: number) => (n / hours) * 24;
  const prevTables = prev.tables ?? {};
  const topTables = Object.entries(cur.tables)
    .map(([table, w]) => ({ table, writesPerDay: Math.round(perDay(w - Number(prevTables[table] ?? 0))) }))
    .filter((t) => t.writesPerDay > 0)
    .sort((a, b) => b.writesPerDay - a.writesPerDay)
    .slice(0, 5);

  return {
    hours,
    writesPerDay: Math.round(perDay(writesDelta)),
    growthBytesPerDay: Math.round(perDay(cur.dbBytes - Number(prev.db_bytes))),
    topTables,
    statsReset: writesDelta < 0,
  };
}

/**
 * Retention for raw sensor events. They are the replay source for
 * rebuild-from-raw (teammate history rebuilds), so keep a generous window —
 * but unbounded, they are the fastest-growing table in the schema.
 */
export async function pruneRawEvents(pool: pg.Pool, schema: string, days = 90): Promise<number> {
  const s = validIdent(schema);
  const res = await pool.query(
    `delete from ${s}.raw_events where ts < now() - ($1 || ' days')::interval`,
    [days],
  );
  return res.rowCount ?? 0;
}
