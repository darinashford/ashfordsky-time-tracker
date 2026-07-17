import { loadConfig } from '@tt/shared';
import { getPool } from '@tt/db';
import { ensureEnv } from './env';

/** Server-only DB handle: a pooled pg connection + resolved config. */
export function getDb() {
  ensureEnv();
  const cfg = loadConfig();
  return { pool: getPool(cfg.databaseUrl), schema: cfg.schema, cfg };
}

export interface ClientOption {
  id: string;
  name: string;
}

/** Active clients for the change-client picker. */
export async function listClientOptions(): Promise<ClientOption[]> {
  const { pool } = getDb();
  const res = await pool.query(
    `select id, name from public.clients where coalesce(status,'active') <> 'archived' order by name asc`,
  );
  return res.rows as ClientOption[];
}

export interface ManualEntryRow {
  id: string;
  startTs: string;
  durationSeconds: number;
  note: string | null;
  clientName: string | null;
  isBillable: boolean;
  hostname: string | null;
}

export interface PersonRow {
  hostname: string;
  label: string | null;
  firstSeen: string | null;
  lastActive: string | null; // greatest of last interval end / token last-used
  activeSeconds: number;
  blocks: number;
  daysActive: number;
  tokenId: string | null;
  tokenCreatedAt: string | null;
  tokenRevoked: boolean | null; // null = no token (direct-DB machine, e.g. the owner)
  rotatePending: boolean; // rotation requested, new token not yet adopted
  rotatedAt: string | null;
  agentSha: string | null; // code version the machine self-reported
  agentReport: { tasks?: Record<string, string>; recentErrors?: string[] } | null;
  agentReportedAt: string | null;
}

/**
 * Everyone who uses the tracker: the union of machines that have sent activity
 * and people who have a minted ingest token (even before their first sync).
 * One row per hostname; the newest token per hostname wins.
 */
export async function listPeople(): Promise<PersonRow[]> {
  const { pool, schema, cfg } = getDb();
  const res = await pool.query(
    `with activity as (
       select hostname,
              min(start_ts)                                       as first_seen,
              max(end_ts)                                         as last_seen,
              coalesce(sum(duration_seconds) filter (where not is_afk), 0)::float as active_seconds,
              count(*)::int                                       as blocks,
              count(distinct (start_ts at time zone $1)::date)::int as days_active
         from ${schema}.intervals
        where hostname is not null
        group by hostname
     ),
     tok as (
       select distinct on (hostname) id, hostname, label, created_at, last_used_at, revoked,
              rotate_requested, pending_token_hash, rotated_at,
              agent_sha, agent_report, agent_reported_at
         from ${schema}.ingest_tokens
        order by hostname, created_at desc
     )
     select coalesce(a.hostname, t.hostname)                       as hostname,
            t.label,
            a.first_seen                                           as "firstSeen",
            greatest(a.last_seen, t.last_used_at)                  as "lastActive",
            coalesce(a.active_seconds, 0)                          as "activeSeconds",
            coalesce(a.blocks, 0)                                  as blocks,
            coalesce(a.days_active, 0)                             as "daysActive",
            t.id                                                   as "tokenId",
            t.created_at                                           as "tokenCreatedAt",
            t.revoked                                              as "tokenRevoked",
            coalesce(t.rotate_requested, false)                    as "rotatePending",
            t.rotated_at                                           as "rotatedAt",
            t.agent_sha                                            as "agentSha",
            t.agent_report                                         as "agentReport",
            t.agent_reported_at                                    as "agentReportedAt"
       from activity a
       full outer join tok t on t.hostname = a.hostname
      order by greatest(a.last_seen, t.last_used_at) desc nulls last`,
    [cfg.timezone],
  );
  return res.rows as PersonRow[];
}

export interface RuleRow {
  id: string;
  ruleType: string;
  matchKind: string;
  pattern: string;
  clientName: string | null;
  enabled: boolean;
  createdAt: string | null;
  createdBy: string | null; // who ran "set client · remember"
  fromHost: string | null; // whose block it was learned from
  blocksHit: number; // blocks currently attributed by this rule
}

/**
 * Every attribution rule, newest first — the audit for what "set client ·
 * remember" has taught the engine. Joins the correction that created each rule
 * for who/when, and counts how many blocks it currently attributes (a big
 * number on a vague pattern is the tell for a bad rule).
 */
export async function listRules(): Promise<RuleRow[]> {
  const { pool, schema } = getDb();
  const res = await pool.query(
    `select r.id, r.rule_type as "ruleType", r.match_kind as "matchKind", r.pattern,
            c.name as "clientName", r.enabled, r.created_at as "createdAt",
            co.created_by as "createdBy",
            (select i.hostname from ${schema}.intervals i where i.id = co.interval_id) as "fromHost",
            (select count(*)::int from ${schema}.resolutions res
               where res.resolver_type = 'rule' and res.evidence->>'ruleId' = r.id::text) as "blocksHit"
       from ${schema}.attribution_rules r
       left join public.clients c on c.id = r.client_id
       left join lateral (
         select created_by, interval_id from ${schema}.corrections
          where created_rule_id = r.id order by created_at desc limit 1
       ) co on true
      order by r.enabled desc, r.created_at desc nulls last`,
  );
  return res.rows as RuleRow[];
}

/** Manually-logged blocks (source='manual') for a local day, for the Today list. */
export async function listManualEntries(date: string, host?: string | null): Promise<ManualEntryRow[]> {
  const { pool, schema, cfg } = getDb();
  const res = await pool.query(
    `select i.id, i.start_ts as "startTs", i.duration_seconds::float as "durationSeconds",
            i.window_title as note, c.name as "clientName",
            coalesce(r.is_billable, true) as "isBillable", i.hostname
       from ${schema}.intervals i
       left join ${schema}.resolutions r on r.interval_id = i.id
       left join public.clients c on c.id = r.client_id
      where i.source = 'manual'
        and (i.start_ts at time zone $2)::date = $1::date
        and ($3::text is null or i.hostname = $3)
      order by i.start_ts asc`,
    [date, cfg.timezone, host ?? null],
  );
  return res.rows as ManualEntryRow[];
}
