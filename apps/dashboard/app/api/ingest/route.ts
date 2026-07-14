import { NextResponse } from 'next/server';
import type { IntervalInput, RawEventInput } from '@tt/db';
import {
  attachPendingOcr,
  insertRawEvents,
  issuePendingToken,
  pruneIntervalsExcept,
  recordAgentReport,
  resolveIngestToken,
  touchIngestToken,
  upsertIntervals,
} from '@tt/db';
import { getDb } from '../../../lib/db';

export const dynamic = 'force-dynamic';

/**
 * Token-authenticated ingest for teammate machines. Their agent normalizes its
 * own ActivityWatch activity locally and POSTs it here with a Bearer token — so
 * no database credentials ever live on their machine. The token maps to a
 * hostname (server-side); we stamp that host on everything, so one person can't
 * write as another. Attribution is handled centrally by the resolver, not here.
 */
export async function POST(req: Request): Promise<Response> {
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!token) return NextResponse.json({ error: 'missing bearer token' }, { status: 401 });

  const { pool, schema } = getDb();
  const t = await resolveIngestToken(pool, schema, token);
  if (!t) return NextResponse.json({ error: 'invalid token' }, { status: 401 });

  let body: {
    since?: string;
    until?: string;
    rawEvents?: RawEventInput[];
    intervals?: IntervalInput[];
    // Agent self-report: code sha + machine health (scheduled tasks, last errors).
    meta?: { sha?: string | null; report?: unknown };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const { since, until } = body;
  if (!since || !until) return NextResponse.json({ error: 'since and until are required' }, { status: 400 });

  // Trust the token for identity, never the client: stamp the token's host on
  // every row.
  const host = t.hostname;
  const raws = (body.rawEvents ?? []).map((e) => ({ ...e, hostname: host }));
  const ivs = (body.intervals ?? []).map((iv) => ({ ...iv, hostname: host }));

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("set local statement_timeout = '120000'");
    const rawInserted = await insertRawEvents(client, schema, raws);
    const saved = await upsertIntervals(client, schema, ivs);
    let pruned = 0;
    if (ivs.length) {
      pruned = await pruneIntervalsExcept(client, schema, since, until, ivs.map((i) => i.dedupeKey), host);
    }
    await client.query('commit');
    await touchIngestToken(pool, schema, t.id);
    // Attach any OCR text this person's screenshot loop staged to the intervals we
    // just ingested. Best-effort — a failure here must never fail the ingest.
    let ocrAttached = 0;
    try {
      ocrAttached = await attachPendingOcr(pool, schema, host);
    } catch {
      ocrAttached = 0;
    }

    // Fleet management (best-effort, never fails the ingest):
    // 1) store the agent's self-report (code sha, task health, last errors);
    // 2) if the admin requested a token rotation, hand a fresh token back — the
    //    agent rewrites its own .env, and the new token's first use promotes it.
    let rotateToken: string | undefined;
    try {
      if (body.meta) await recordAgentReport(pool, schema, t.id, { sha: body.meta.sha ?? null, report: body.meta.report });
      const rot = await pool.query(
        `select rotate_requested from ${schema}.ingest_tokens where id = $1 and not revoked`,
        [t.id],
      );
      if (rot.rows[0]?.rotate_requested) rotateToken = await issuePendingToken(pool, schema, t.id);
    } catch {
      rotateToken = undefined;
    }

    return NextResponse.json({
      ok: true, host, rawInserted, upserted: saved.length, pruned, ocrAttached,
      ...(rotateToken ? { rotateToken } : {}),
    });
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'ingest failed' }, { status: 500 });
  } finally {
    client.release();
  }
}
