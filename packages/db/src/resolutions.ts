import type pg from 'pg';
import type { ClientAnchor, Resolution } from '@tt/shared';
import { validIdent } from './pool';

/** Insert or replace the single current resolution for an interval. */
export async function upsertResolution(
  pool: pg.Pool,
  schema: string,
  r: Resolution,
): Promise<void> {
  const s = validIdent(schema);
  await pool.query(
    `insert into ${s}.resolutions
       (interval_id, client_id, client_group_id, status, confidence, resolver_type,
        is_billable, needs_review, evidence, resolver_version, category, resolved_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11, now(), now())
     on conflict (interval_id) do update set
       client_id        = excluded.client_id,
       client_group_id  = excluded.client_group_id,
       status           = excluded.status,
       confidence       = excluded.confidence,
       resolver_type    = excluded.resolver_type,
       is_billable      = excluded.is_billable,
       needs_review     = excluded.needs_review,
       evidence         = excluded.evidence,
       resolver_version = excluded.resolver_version,
       category         = excluded.category,
       updated_at       = now()`,
    [
      r.intervalId, r.clientId, r.clientGroupId, r.status, r.confidence, r.resolverType,
      r.isBillable, r.needsReview, JSON.stringify(r.evidence ?? {}), r.resolverVersion ?? null,
      r.category ?? null,
    ],
  );
}

/**
 * Stamp an existing resolution with a resolver_version (e.g. 'llm') WITHOUT
 * changing its client/status/category, merging an evidence patch. Used by the
 * LLM pass to freeze blocks it saw but couldn't improve ("unknown"), so they're
 * not re-sent to the model on every sync cycle.
 */
export async function freezeResolution(
  pool: pg.Pool,
  schema: string,
  intervalId: string,
  version: string,
  evidencePatch: Record<string, unknown> = {},
): Promise<void> {
  const s = validIdent(schema);
  await pool.query(
    `update ${s}.resolutions
        set resolver_version = $2,
            resolver_type = coalesce(resolver_type, $2),
            evidence = coalesce(evidence, '{}'::jsonb) || $3::jsonb,
            updated_at = now()
      where interval_id = $1`,
    [intervalId, version, JSON.stringify(evidencePatch)],
  );
}

export interface AuditVote {
  resolverType: string;
  clientId: string | null;
  confidence: number;
  matched: boolean;
  evidence: Record<string, unknown>;
}

/** Replace the audit trail for an interval with the votes from the latest run. */
export async function replaceAudit(
  pool: pg.Pool,
  schema: string,
  intervalId: string,
  votes: AuditVote[],
): Promise<void> {
  const s = validIdent(schema);
  await pool.query(`delete from ${s}.resolution_audit where interval_id = $1`, [intervalId]);
  if (votes.length === 0) return;
  const payload = votes.map((v) => ({
    resolver_type: v.resolverType,
    client_id: v.clientId,
    confidence: v.confidence,
    matched: v.matched,
    evidence: v.evidence ?? {},
  }));
  await pool.query(
    `insert into ${s}.resolution_audit (interval_id, resolver_type, client_id, confidence, matched, evidence)
     select $1, resolver_type, client_id, confidence, matched, coalesce(evidence,'{}'::jsonb)
       from jsonb_to_recordset($2::jsonb)
            as x(resolver_type text, client_id uuid, confidence numeric, matched boolean, evidence jsonb)`,
    [intervalId, JSON.stringify(payload)],
  );
}

export async function enqueueReview(
  pool: pg.Pool,
  schema: string,
  intervalId: string,
  reason: string,
  priority = 0,
): Promise<void> {
  const s = validIdent(schema);
  await pool.query(
    `insert into ${s}.review_queue (interval_id, reason, priority, status)
     values ($1,$2,$3,'open')
     on conflict (interval_id) do update set
       reason = excluded.reason, priority = excluded.priority, status = 'open', resolved_at = null`,
    [intervalId, reason, priority],
  );
}

export async function resolveReview(
  pool: pg.Pool,
  schema: string,
  intervalId: string,
  status: 'resolved' | 'dismissed' = 'resolved',
): Promise<void> {
  const s = validIdent(schema);
  await pool.query(
    `update ${s}.review_queue set status = $2, resolved_at = now() where interval_id = $1`,
    [intervalId, status],
  );
}

/**
 * Remove an interval's resolution and its review-queue + audit rows. Used when a
 * block becomes "away" idle (machine slept, long idle off a call) and must carry
 * no billable/non-billable attribution — otherwise a block that used to be active
 * would keep its old resolution after flipping to idle. Callers guard manual rows.
 */
export async function deleteResolution(
  pool: pg.Pool,
  schema: string,
  intervalId: string,
): Promise<void> {
  const s = validIdent(schema);
  // One round-trip: audit + review_queue + resolution for this interval.
  await pool.query(
    `with a as (delete from ${s}.resolution_audit where interval_id = $1),
          r as (delete from ${s}.review_queue where interval_id = $1)
     delete from ${s}.resolutions where interval_id = $1`,
    [intervalId],
  );
}

/** Append a rolling current-client anchor (auditable context history). */
export async function appendAnchor(
  pool: pg.Pool,
  schema: string,
  a: ClientAnchor,
): Promise<void> {
  const s = validIdent(schema);
  await pool.query(
    `insert into ${s}.current_client_state
       (as_of, client_id, client_group_id, confidence, anchor_resolver_type, source_interval_id)
     values ($1::timestamptz,$2,$3,$4,$5,$6)`,
    [a.asOf, a.clientId, a.clientGroupId ?? null, a.confidence, a.anchorResolverType, a.sourceIntervalId ?? null],
  );
}

export async function getResolution(
  pool: pg.Pool,
  schema: string,
  intervalId: string,
): Promise<Resolution | null> {
  const s = validIdent(schema);
  const res = await pool.query(
    `select interval_id as "intervalId", client_id as "clientId", client_group_id as "clientGroupId",
            status, confidence, resolver_type as "resolverType", is_billable as "isBillable",
            needs_review as "needsReview", evidence, resolver_version as "resolverVersion"
       from ${s}.resolutions where interval_id = $1`,
    [intervalId],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return { ...row, confidence: Number(row.confidence) } as Resolution;
}

export interface DayResolutionRow {
  intervalId: string;
  status: string;
  clientId: string | null;
  clientGroupId: string | null;
  confidence: number;
  resolverType: string | null;
  resolverVersion: string | null;
  category: string | null;
}

/** All resolutions for a local day, keyed by interval id (for the runner). */
export async function getResolutionsForDay(
  pool: pg.Pool,
  schema: string,
  day: string,
  tz: string,
): Promise<Map<string, DayResolutionRow>> {
  const s = validIdent(schema);
  const res = await pool.query(
    `select r.interval_id as "intervalId", r.status, r.client_id as "clientId",
            r.client_group_id as "clientGroupId", r.confidence, r.resolver_type as "resolverType",
            r.resolver_version as "resolverVersion", r.category
       from ${s}.resolutions r
       join ${s}.intervals i on i.id = r.interval_id
      where (i.start_ts at time zone $2)::date = $1::date`,
    [day, tz],
  );
  const map = new Map<string, DayResolutionRow>();
  for (const row of res.rows) {
    map.set(row.intervalId, { ...row, confidence: Number(row.confidence) } as DayResolutionRow);
  }
  return map;
}
