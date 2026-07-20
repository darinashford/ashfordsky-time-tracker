import type pg from 'pg';
import type { AttributionRule, MatchKind } from '@tt/shared';
import { validIdent } from './pool';

/**
 * Resolvers whose attribution came from the RECORD ITSELF naming the client (an
 * email address/domain, a calendar attendee, a CCH/QBO/FC id, a mapped file).
 * Deliberately excludes the inferred ones — carry-forward, neighbour, name-in-
 * title — which attribute from surrounding context, not from the window title,
 * and so can't be used as evidence about what a title token means.
 */
const DIRECT_EVIDENCE = [
  'calendar_event', 'email_subject', 'email_domain', 'email_address',
  'cch_axcess', 'qbo', 'financial_cents', 'excel_path', 'manual',
];

/**
 * How many DIFFERENT clients direct evidence ties a title token to.
 *
 * This is the test for "is this token actually a client identifier?", and it
 * beats any list of banned words: a real identifier ("soarfare", "textkernel")
 * only ever shows up on one client's work, while a generic word ("bookkeeping",
 * "through") or a shared tool ("pdfgear", "claude") shows up across many. It
 * needs no maintenance — the answer comes from the firm's own data.
 *
 * 0 means "no independent evidence either way" — never treat that as bad, or a
 * legitimately narrow rule would be killed for lack of corroboration.
 */
export async function countClientsForTitlePattern(
  pool: pg.Pool,
  schema: string,
  pattern: string,
  days = 45,
): Promise<{ distinctClients: number; clientNames: string[] }> {
  const s = validIdent(schema);
  const p = (pattern ?? '').trim();
  if (p.length < 3) return { distinctClients: 0, clientNames: [] };
  const res = await pool.query(
    `select count(distinct r.client_id)::int as n,
            (array_agg(distinct c.name))[1:6] as names
       from ${s}.intervals i
       join ${s}.resolutions r on r.interval_id = i.id
       left join public.clients c on c.id = r.client_id
      where i.window_title ilike '%' || $1 || '%'
        and i.start_ts > now() - ($2 || ' days')::interval
        and r.client_id is not null
        and r.resolver_type = any($3::text[])`,
    [p, days, DIRECT_EVIDENCE],
  );
  const row = (res.rows[0] ?? {}) as { n: number; names: string[] | null };
  return { distinctClients: Number(row.n ?? 0), clientNames: row.names ?? [] };
}

export interface OverBroadRule {
  id: string;
  ruleType: string;
  pattern: string;
  clientName: string | null;
  blocksHit: number;
  distinctClients: number;
  clientNames: string[];
}

/**
 * Enabled title rules whose pattern turns out to span several clients. Rules a
 * person explicitly enabled (human_reviewed) are never returned — if you say a
 * rule is right, the sweep leaves it alone.
 */
export async function findOverBroadTitleRules(
  pool: pg.Pool,
  schema: string,
  minClients = 3,
  days = 45,
): Promise<OverBroadRule[]> {
  const s = validIdent(schema);
  const { rows } = await pool.query(
    `select r.id, r.rule_type as "ruleType", r.pattern, c.name as "clientName",
            (select count(*)::int from ${s}.resolutions res
              where res.resolver_type = 'rule' and res.evidence->>'ruleId' = r.id::text) as "blocksHit"
       from ${s}.attribution_rules r
       left join public.clients c on c.id = r.client_id
      where r.enabled = true and r.human_reviewed = false and r.rule_type = 'title_pattern'`,
  );
  const out: OverBroadRule[] = [];
  for (const r of rows as Array<Omit<OverBroadRule, 'distinctClients' | 'clientNames'>>) {
    const { distinctClients, clientNames } = await countClientsForTitlePattern(pool, schema, r.pattern, days);
    if (distinctClients >= minClients) out.push({ ...r, distinctClients, clientNames });
  }
  return out;
}

/** Turn a rule off and record why. Never deletes: everything stays reversible. */
export async function autoDisableRule(
  pool: pg.Pool,
  schema: string,
  ruleId: string,
  reason: string,
): Promise<void> {
  const s = validIdent(schema);
  await pool.query(
    `update ${s}.attribution_rules
        set enabled = false, auto_disabled_reason = $2, updated_at = now()
      where id = $1`,
    [ruleId, reason],
  );
}

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
