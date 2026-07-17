import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { assertDatabaseUrl, loadConfig } from '@tt/shared';
import type { ActivityEvent } from '@tt/shared';
import { closePool, getPool, upsertIntervals } from '@tt/db';
import { normalizeEvents } from './normalize';

/**
 * Rebuild a host's intervals from the raw_events already stored in the shared DB,
 * using the CURRENT normalizer — the teammate equivalent of the owner's `--rebase`.
 *
 * Teammate agents normalize on their own machine and POST finished intervals, so a
 * normalizer fix doesn't reach their PAST days until they re-post (which they don't
 * for old days). But they also POST their raw events, which we keep — so we can
 * re-normalize those here and replace the stale intervals, without any access to
 * their machine.
 *
 * Per local day: load that host's raw events, normalize with today's code, then in
 * one transaction delete the host's intervals for the day (preserving hand/AI
 * corrections — resolver_version manual/llm) and upsert the fresh ones. raw_events
 * are the source and are never touched. Re-run the resolver afterwards.
 *
 *   tsx rebuild-from-raw.ts --host keith [--since YYYY-MM-DD] [--until YYYY-MM-DD]
 */

for (const p of ['.env', '../.env', '../../.env', '../../../.env']) {
  const f = resolve(process.cwd(), p);
  if (existsSync(f)) {
    dotenv.config({ path: f });
    break;
  }
}

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const addDay = (d: string): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

async function main(): Promise<void> {
  const cfg = loadConfig();
  assertDatabaseUrl(cfg);
  const host = arg('--host');
  if (!host) throw new Error('--host is required (e.g. --host keith)');
  const tz = cfg.timezone;
  const s = cfg.schema;
  const pool = getPool(cfg.databaseUrl);

  try {
    const bounds = await pool.query(
      `select to_char(min((ts at time zone $2)::date),'YYYY-MM-DD') as d0,
              to_char(max((ts at time zone $2)::date),'YYYY-MM-DD') as d1
         from ${s}.raw_events where hostname = $1`,
      [host, tz],
    );
    const b = bounds.rows[0] as { d0: string | null; d1: string | null };
    if (!b.d0 || !b.d1) {
      console.log(`[rebuild] no raw events for host '${host}'; nothing to do.`);
      return;
    }
    const since = arg('--since') ?? b.d0;
    const until = arg('--until') ?? b.d1;
    console.log(`[rebuild] host=${host} range=${since}..${until} (tz=${tz})`);

    for (let day = since; day <= until; day = addDay(day)) {
      const res = await pool.query(
        `select source, hostname, bucket, event_type, app, window_title, url, afk, ts, duration_seconds, data
           from ${s}.raw_events
          where hostname = $1 and (ts at time zone $3)::date = $2::date
          order by ts asc`,
        [host, day, tz],
      );
      if (res.rows.length === 0) {
        console.log(`[rebuild] ${day} :: no raw events, skipped`);
        continue;
      }
      const events: ActivityEvent[] = res.rows.map((r) => ({
        source: r.source,
        hostname: r.hostname,
        bucket: r.bucket,
        eventType: r.event_type,
        app: r.app,
        windowTitle: r.window_title,
        url: r.url,
        afk: r.afk,
        timestamp: new Date(r.ts).toISOString(),
        durationSeconds: Number(r.duration_seconds),
        data: r.data ?? {},
      }));
      const intervals = normalizeEvents(events, { mergeGapSeconds: 60 }).map((iv) => ({ ...iv, hostname: host }));

      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query("set local statement_timeout = '120000'");
        // Replace this host's intervals for the local day, preserving anything you
        // corrected by hand or the AI pass already judged (can't be re-derived).
        const del = await client.query(
          `delete from ${s}.intervals i
            where i.hostname = $1
              and (i.start_ts at time zone $3)::date = $2::date
              and not exists (
                select 1 from ${s}.resolutions r
                 where r.interval_id = i.id and r.resolver_version in ('manual','llm')
              )`,
          [host, day, tz],
        );
        const saved = await upsertIntervals(client, s, intervals);
        await client.query('commit');
        console.log(`[rebuild] ${day} :: normalized ${intervals.length}, deleted ${del.rowCount}, upserted ${saved.length}`);
      } catch (err) {
        await client.query('rollback').catch(() => undefined);
        console.error(`[rebuild] ${day} :: FAILED ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        client.release();
      }
    }
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error('[rebuild] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
