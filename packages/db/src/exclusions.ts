import type pg from 'pg';
import type { Exclusion } from '@tt/shared';
import { validIdent } from './pool';

export async function loadExclusions(pool: pg.Pool, schema: string): Promise<Exclusion[]> {
  const s = validIdent(schema);
  const res = await pool.query(
    `select id, kind, field, match_kind as "matchKind", pattern, normalized, enabled
       from ${s}.exclusions
      where enabled = true`,
  );
  return res.rows as Exclusion[];
}

export interface ExclusionSpec {
  kind: 'no_screenshot' | 'nonbillable' | 'ignore';
  field: 'app' | 'domain' | 'url' | 'title';
  matchKind: Exclusion['matchKind'];
  pattern: string;
  normalized?: string | null;
  reason?: string | null;
}

export async function insertExclusion(
  pool: pg.Pool,
  schema: string,
  spec: ExclusionSpec,
): Promise<string> {
  const s = validIdent(schema);
  const res = await pool.query(
    `insert into ${s}.exclusions (kind, field, match_kind, pattern, normalized, reason)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [spec.kind, spec.field, spec.matchKind, spec.pattern, spec.normalized ?? null, spec.reason ?? null],
  );
  return res.rows[0].id as string;
}
