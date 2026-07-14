import type pg from 'pg';
import type { AttributionRule, MatchKind } from '@tt/shared';
import { validIdent } from './pool';

/** All enabled overlay rules, highest priority first. */
export async function loadEnabledRules(
  pool: pg.Pool,
  schema: string,
): Promise<AttributionRule[]> {
  const s = validIdent(schema);
  const res = await pool.query(
    `select id, rule_type as "ruleType", match_kind as "matchKind", pattern, normalized,
            client_id as "clientId", client_group_id as "clientGroupId",
            source_system as "sourceSystem", confidence, is_billable as "isBillable",
            enabled, priority
       from ${s}.attribution_rules
      where enabled = true
      order by priority asc, created_at asc`,
  );
  return res.rows.map((r) => ({ ...r, confidence: Number(r.confidence) })) as AttributionRule[];
}

export interface RuleSpec {
  ruleType: string;
  matchKind: MatchKind;
  pattern: string;
  normalized: string;
  clientId: string | null;
  clientGroupId?: string | null;
  sourceSystem?: string | null;
  confidence?: number;
  isBillable?: boolean | null;
  priority?: number;
  createdFromCorrectionId?: string | null;
}

/** Create or update a durable rule (idempotent on rule_type+match_kind+normalized). */
export async function upsertRule(
  pool: pg.Pool,
  schema: string,
  spec: RuleSpec,
): Promise<string> {
  const s = validIdent(schema);
  const res = await pool.query(
    `insert into ${s}.attribution_rules
       (rule_type, match_kind, pattern, normalized, client_id, client_group_id,
        source_system, confidence, is_billable, priority, created_from_correction_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (rule_type, match_kind, normalized) do update set
       client_id       = excluded.client_id,
       client_group_id = excluded.client_group_id,
       source_system   = excluded.source_system,
       confidence      = excluded.confidence,
       is_billable     = excluded.is_billable,
       enabled         = true,
       updated_at      = now()
     returning id`,
    [
      spec.ruleType, spec.matchKind, spec.pattern, spec.normalized, spec.clientId,
      spec.clientGroupId ?? null, spec.sourceSystem ?? null, spec.confidence ?? 0.97,
      spec.isBillable ?? null, spec.priority ?? 100, spec.createdFromCorrectionId ?? null,
    ],
  );
  return res.rows[0].id as string;
}

export async function bumpRuleHits(
  pool: pg.Pool,
  schema: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const s = validIdent(schema);
  await pool.query(
    `update ${s}.attribution_rules
        set hit_count = hit_count + 1, last_hit_at = now()
      where id = any($1::uuid[])`,
    [ids],
  );
}
