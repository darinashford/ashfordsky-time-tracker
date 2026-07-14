import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';
import { buildNameIndex, matchCompany, type NameRow } from './match';

// ---------------------------------------------------------------------------
// QBO realm sync — a scheduled DB→DB job.
//
// READS  the QBO-App connector's Postgres (Replit's built-in Postgres —
//        qbo_connections holds every connected client's realmId + QBO company
//        name) and WRITES client→realm rows into the Agent-os graph
//        (public.source_system_links, source_system='qbo'). That's the exact
//        field the time tracker's qbo resolver reads: byQboRealm (URL realmid,
//        0.95) and byQboCompany (window-title company name, 0.85).
//
// Runs on a Railway cron (see railway.json), same pattern as resolver-service.
// Safe + idempotent:
//   • NEW realm, unique name match  -> insert the link (auto).
//   • NEW realm, no/ambiguous match -> reported, never guessed (left for a human).
//   • EXISTING realm                -> only its company_name/connection_id are
//     refreshed; internal_record_id is never overwritten, so hand-made mappings
//     (e.g. BIJOU CORP -> Bijou Build) survive every run.
// ---------------------------------------------------------------------------

for (const p of ['.env', '../.env', '../../.env', '../../../.env']) {
  const f = resolve(process.cwd(), p);
  if (existsSync(f)) {
    dotenv.config({ path: f });
    break;
  }
}

const { Pool } = pg;
const DRY_RUN = process.argv.includes('--dry-run');

/** SSL + idle-error handling like @tt/db's getPool. SSL for any remote host
 * (Supabase and the connector's Neon/Replit Postgres both require it). */
function makePool(connectionString: string, name: string): pg.Pool {
  const isLocal = /@(localhost|127\.0\.0\.1|\[?::1\]?)[:/]/i.test(connectionString);
  const pool = new Pool({
    connectionString,
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
    max: 4,
    keepAlive: true,
    application_name: `ashfordsky-qbo-realm-sync-${name}`,
  });
  pool.on('error', (err) => {
    console.error(`[qbo-sync] idle pool error (${name}, recovering):`, err instanceof Error ? err.message : err);
  });
  return pool;
}

interface Connection {
  realmId: string;
  companyName: string;
  connectionId: string | null;
  status: string | null;
}

// qbo_connections in the connector's Replit Postgres. Columns verified 2026-07-14.
// (internal_client_name exists but is unused/empty, so we match on qbo_company_name.)
const CONNECTIONS_QUERY = `
  select realm_id          as "realmId",
         qbo_company_name  as "companyName",
         id                as "connectionId",
         connection_status as "status"
  from public.qbo_connections
`;

async function fetchConnections(qboPool: pg.Pool): Promise<Connection[]> {
  const { rows } = await qboPool.query<Connection>(CONNECTIONS_QUERY);
  return rows
    .filter((r) => r.realmId && r.companyName)
    .filter((r) => !r.status || r.status.toUpperCase() === 'CONNECTED');
}

interface AgentOsState {
  existingRealms: Set<string>;
  nameIndex: Map<string, Set<string>>;
  clientNames: Map<string, string>;
}

async function loadAgentOs(pool: pg.Pool): Promise<AgentOsState> {
  const existing = await pool.query<{ external_id: string }>(
    `select external_id from public.source_system_links
      where source_system='qbo' and internal_record_type='client'`,
  );
  const clients = await pool.query<{ id: string; name: string }>(
    `select id::text, name from public.clients`,
  );
  const aliases = await pool.query<{ subject_id: string; alias_value: string }>(
    `select subject_id::text, alias_value from public.client_aliases where subject_type='client'`,
  );
  const rows: NameRow[] = [];
  const clientNames = new Map<string, string>();
  for (const c of clients.rows) {
    rows.push({ clientId: c.id, value: c.name });
    clientNames.set(c.id, c.name);
  }
  for (const a of aliases.rows) rows.push({ clientId: a.subject_id, value: a.alias_value });
  return {
    existingRealms: new Set(existing.rows.map((r) => r.external_id)),
    nameIndex: buildNameIndex(rows),
    clientNames,
  };
}

async function refreshMetadata(pool: pg.Pool, c: Connection): Promise<number> {
  const { rowCount } = await pool.query(
    `update public.source_system_links
        set external_metadata = external_metadata
              || jsonb_build_object('company_name', $2::text, 'connection_id', $3::text),
            updated_at = now()
      where source_system='qbo' and internal_record_type='client' and external_id=$1
        and ((external_metadata->>'company_name') is distinct from $2::text
             or (external_metadata->>'connection_id') is distinct from $3::text)`,
    [c.realmId, c.companyName, c.connectionId],
  );
  return rowCount ?? 0;
}

async function insertLink(pool: pg.Pool, clientId: string, c: Connection): Promise<void> {
  await pool.query(
    `insert into public.source_system_links
       (id, internal_record_type, internal_record_id, source_system, external_id,
        external_url, external_metadata, confidence, created_at, updated_at)
     values (gen_random_uuid(), 'client', $1::uuid, 'qbo', $2, null,
             jsonb_build_object('company_name', $3::text, 'connection_id', $4::text,
                                'source', 'qbo_app_connector'),
             1.0, now(), now())
     on conflict (source_system, internal_record_type, external_id) do nothing`,
    [clientId, c.realmId, c.companyName, c.connectionId],
  );
}

async function main(): Promise<void> {
  const writeUrl = process.env.DATABASE_URL;
  const readUrl = process.env.QBO_APP_DATABASE_URL;
  if (!writeUrl) throw new Error('DATABASE_URL (Agent-os graph) is required');
  if (!readUrl) throw new Error('QBO_APP_DATABASE_URL (connector DB) is required');

  const agentOs = makePool(writeUrl, 'agentos');
  const qbo = makePool(readUrl, 'connector');

  try {
    const connections = await fetchConnections(qbo);
    const state = await loadAgentOs(agentOs);
    console.log(
      `[qbo-sync] ${connections.length} connected books; ` +
        `${state.existingRealms.size} already linked; ${state.clientNames.size} clients indexed.` +
        (DRY_RUN ? ' (dry-run)' : ''),
    );

    let inserted = 0;
    let refreshed = 0;
    const unmatched: Array<{ company: string; realm: string; why: string }> = [];

    for (const c of connections) {
      if (state.existingRealms.has(c.realmId)) {
        if (!DRY_RUN && (await refreshMetadata(agentOs, c)) > 0) refreshed++;
        continue;
      }
      const m = matchCompany(c.companyName, state.nameIndex);
      if (m.kind === 'matched') {
        if (!DRY_RUN) await insertLink(agentOs, m.clientId, c);
        inserted++;
        console.log(`[qbo-sync] + ${c.companyName} (${c.realmId}) -> ${state.clientNames.get(m.clientId) ?? m.clientId}`);
      } else if (m.kind === 'ambiguous') {
        const names = m.clientIds.map((id) => state.clientNames.get(id) ?? id).join(', ');
        unmatched.push({ company: c.companyName, realm: c.realmId, why: `ambiguous: ${names}` });
      } else {
        unmatched.push({ company: c.companyName, realm: c.realmId, why: 'no client name/alias match' });
      }
    }

    if (unmatched.length) {
      console.log(`[qbo-sync] ${unmatched.length} need a human mapping:`);
      for (const u of unmatched) console.log(`[qbo-sync]   ? ${u.company} (${u.realm}) — ${u.why}`);
    }
    console.log(
      `[qbo-sync] done. inserted=${inserted} refreshed=${refreshed} unmatched=${unmatched.length}` +
        (DRY_RUN ? ' (dry-run: no writes)' : ''),
    );
  } finally {
    await Promise.allSettled([agentOs.end(), qbo.end()]);
  }
}

main().catch((err) => {
  console.error('[qbo-sync] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
