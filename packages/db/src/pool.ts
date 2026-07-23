import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;

/**
 * Supabase's pooler serves two modes on different ports:
 *   5432 = SESSION    — each client holds a dedicated Postgres connection for as
 *                       long as it's connected. A small, easily exhausted pool.
 *   6543 = TRANSACTION— connections are multiplexed per transaction, so many
 *                       short-lived clients share a few real connections.
 *
 * We have a dashboard, three crons, a 10-minute sync on each machine and ad-hoc
 * tooling all hitting the same tenant. In session mode they exhaust the pool,
 * the refused attempts count as authentication failures, and Supavisor trips its
 * circuit breaker — which blocks NEW connections for everyone
 * ("ECIRCUITBREAKER: too many authentication failures"), taking the dashboard
 * down with it.
 *
 * The Supabase UI hands out the 5432 string by default, so relying on every
 * service's env being set correctly is fragile. Normalise it here instead: any
 * pooler URL on 5432 is moved to 6543 unless DB_POOL_MODE=session is set. Our
 * code is transaction-mode safe (no LISTEN/NOTIFY, no named prepared
 * statements; every `set local` is inside an explicit transaction).
 */
export function normalizePoolerUrl(databaseUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.DB_POOL_MODE === 'session') return databaseUrl;
  try {
    const u = new URL(databaseUrl);
    if (/(^|\.)pooler\.supabase\.com$/i.test(u.hostname) && u.port === '5432') {
      u.port = '6543';
      return u.toString();
    }
  } catch {
    /* not a URL we can parse — leave it alone */
  }
  return databaseUrl;
}

function num(v: string | undefined, d: number): number {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

/** Lazily create a singleton pg Pool. Supabase requires SSL. */
export function getPool(databaseUrl: string): pg.Pool {
  if (pool) return pool;
  const url = normalizePoolerUrl(databaseUrl);
  const needsSsl = /supabase\.(co|com)|sslmode=require/i.test(url);
  pool = new Pool({
    connectionString: url,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    // Keep our footprint small: every extra idle connection is one the rest of
    // the fleet can't have. Crons can drop this further via DB_POOL_MAX.
    max: num(process.env.DB_POOL_MAX, 4),
    idleTimeoutMillis: num(process.env.DB_IDLE_TIMEOUT_MS, 10_000),
    connectionTimeoutMillis: num(process.env.DB_CONNECT_TIMEOUT_MS, 15_000),
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
    isCircuitBreakerError(err) ||
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
 * Supavisor has stopped accepting new connections for the whole tenant after too
 * many failed attempts. Retrying is actively harmful here: every further attempt
 * is one more failure that keeps the breaker open, and it's open for everyone —
 * the dashboard included. Back all the way off and let the next cycle try.
 */
export function isCircuitBreakerError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    m.includes('circuitbreaker') ||
    m.includes('circuit breaker') ||
    m.includes('temporarily blocked') ||
    m.includes('too many authentication failures')
  );
}

/**
 * Take a connection, retrying a few times with backoff. Most pooler timeouts
 * clear within seconds, so a scheduled run should ride them out rather than
 * lose the whole cycle on the first blip.
 *
 * Exception: never retry a circuit-breaker/auth rejection — hammering it is what
 * keeps the breaker closed on the rest of the fleet. Fail fast and skip the run.
 */
export async function waitForDb(pool: pg.Pool, attempts = 3, baseDelayMs = 4000): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const client = await pool.connect();
      client.release();
      return;
    } catch (err) {
      if (isCircuitBreakerError(err)) {
        console.warn('[db] pooler circuit breaker is open — not retrying, skipping this run.');
        throw err;
      }
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
