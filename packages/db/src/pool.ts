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

/**
 * Is this an infrastructure hiccup rather than a bug in our code? Supabase's
 * pooler (Supavisor) refuses connections under load with `{:error, :timeout}`,
 * and idle TLS sockets get dropped — both are transient and clear on their own.
 * Scheduled jobs use this to skip a cycle quietly instead of exiting non-zero,
 * which Railway reports as "Deploy Crashed" and emails about.
 */
export function isTransientDbError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    m.includes('failed to connect') ||
    m.includes('timeout') ||
    m.includes('econnreset') ||
    m.includes('econnrefused') ||
    m.includes('etimedout') ||
    m.includes('enotfound') ||
    m.includes('eai_again') ||
    m.includes('connection terminated') ||
    m.includes('socket hang up') ||
    m.includes('server closed the connection') ||
    m.includes('too many clients') ||
    m.includes('max client connections')
  );
}

/**
 * Take a connection, retrying a few times with backoff. Most pooler timeouts
 * clear within seconds, so a scheduled run should ride them out rather than
 * lose the whole cycle on the first blip.
 */
export async function waitForDb(pool: pg.Pool, attempts = 3, baseDelayMs = 4000): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const client = await pool.connect();
      client.release();
      return;
    } catch (err) {
      if (attempt >= attempts || !isTransientDbError(err)) throw err;
      const wait = baseDelayMs * attempt;
      console.warn(
        `[db] connect attempt ${attempt}/${attempts} failed (${err instanceof Error ? err.message : err}); retrying in ${wait}ms`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
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
