import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;

/** Lazily create a singleton pg Pool. Supabase requires SSL. */
export function getPool(databaseUrl: string): pg.Pool {
  if (pool) return pool;
  const needsSsl = /supabase\.(co|com)|sslmode=require/i.test(databaseUrl);
  pool = new Pool({
    connectionString: databaseUrl,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    max: 5,
    keepAlive: true, // fewer idle-connection drops to Supabase
    application_name: 'ashfordsky-time-tracker',
  });
  // CRITICAL: without this, a transient TLS/network drop on an IDLE pooled
  // connection (Supabase pooler does this) emits an 'error' event with no
  // listener, which Node treats as fatal and crashes the whole process — that
  // was the intermittent `ingest exit=1`. With a handler, the pool just discards
  // the bad client and reconnects on the next query; the sync cycle survives.
  pool.on('error', (err) => {
    console.error('[db] idle pool client error (recovering):', err instanceof Error ? err.message : err);
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Guard a schema/table identifier before string-interpolating it into SQL. */
export function validIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`Unsafe SQL identifier: ${name}`);
  }
  return name;
}
