import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { assertDatabaseUrl, loadConfig } from '@tt/shared';
import {
  clearIngestRange,
  closePool,
  getPool,
  insertRawEvents,
  pruneIntervalsExcept,
  upsertIntervals,
} from '@tt/db';
import { ActivityWatchAdapter } from './activitywatch';
import { MockAdapter } from './mock';
import { normalizeEvents, toRawEventInput } from './normalize';
import type { SensorAdapter } from './adapter';

// Load the nearest .env walking up from the current working directory.
for (const p of ['.env', '../.env', '../../.env', '../../../.env']) {
  const f = resolve(process.cwd(), p);
  if (existsSync(f)) {
    dotenv.config({ path: f });
    break;
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string): boolean => process.argv.includes(name);

async function main(): Promise<void> {
  const cfg = loadConfig();
  assertDatabaseUrl(cfg);

  const days = Number(arg('--days') ?? '1');
  const rebase = hasFlag('--rebase');
  const now = new Date();
  const until = arg('--until') ?? now.toISOString();
  let since = arg('--since') ?? new Date(now.getTime() - days * 86_400_000).toISOString();

  let adapter: SensorAdapter;
  if (cfg.sensorMode === 'live') {
    adapter = new ActivityWatchAdapter(cfg.activitywatchUrl);
  } else {
    const fixture = fileURLToPath(new URL('../fixtures/demo-day.json', import.meta.url));
    adapter = new MockAdapter(fixture, rebase);
    // When replaying the fixture as-is, widen the window so we don't miss it.
    if (!arg('--since') && !rebase) since = '1970-01-01T00:00:00.000Z';
  }

  console.log(`[ingestor] sensor=${adapter.name} range=${since}..${until}`);
  const events = await adapter.fetchEvents({ since, until });
  console.log(`[ingestor] fetched ${events.length} raw events`);

  // Safety: never touch the DB on an empty fetch (e.g. AW briefly unreachable) —
  // otherwise the clear below would wipe the window with nothing to replace it.
  if (events.length === 0) {
    console.log('[ingestor] no events fetched; leaving stored data untouched.');
    return;
  }

  const pool = getPool(cfg.databaseUrl);
  const client = await pool.connect();
  try {
    // Atomic re-ingest of the window: clear + insert in ONE transaction, so an
    // interruption (the scheduler killing a slow run) rolls back instead of
    // deleting a day it never re-adds.
    await client.query('begin');
    // A multi-day clear+insert can exceed the default statement cap; raise it
    // for this transaction only (a backfill is far bigger than a 15-min delta).
    await client.query("set local statement_timeout = '300000'");
    const intervals = normalizeEvents(events, { mergeGapSeconds: 60 });
    // This machine's host — scope every clear/prune to it so, on a shared DB,
    // one person's sync can never delete another person's intervals.
    const host = intervals.find((i) => i.hostname)?.hostname ?? null;
    // --rebase is an explicit full rebuild of the window. The normal incremental
    // path upserts intervals in place and prunes only stale merge-orphans, so a
    // settled interval keeps its id — and therefore its resolution — across
    // cycles, instead of the whole day's attribution being wiped + redone.
    if (rebase) await clearIngestRange(client, cfg.schema, since, until, { fullClear: true, host });
    const rawInserted = await insertRawEvents(client, cfg.schema, events.map(toRawEventInput));
    const saved = await upsertIntervals(client, cfg.schema, intervals);
    let pruned = 0;
    if (!rebase) {
      pruned = await pruneIntervalsExcept(client, cfg.schema, since, until, intervals.map((i) => i.dedupeKey), host);
    }
    await client.query('commit');
    if (pruned) console.log(`[ingestor] pruned ${pruned} stale interval(s)`);
    console.log(
      `[ingestor] stored ${rawInserted} new raw events; upserted ${saved.length} intervals ` +
        `(${saved.filter((i) => !i.isAfk).length} active).`,
    );
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await closePool();
  }
}

main().catch((err) => {
  console.error('[ingestor] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
