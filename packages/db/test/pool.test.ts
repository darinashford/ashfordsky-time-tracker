import { describe, expect, it } from 'vitest';
import { isCircuitBreakerError, isTransientDbError, normalizePoolerUrl } from '../src/pool';

const SESSION = 'postgresql://postgres.abc:pw@aws-1-us-west-1.pooler.supabase.com:5432/postgres';

describe('normalizePoolerUrl — session mode is what exhausts the pooler', () => {
  it('moves a Supabase pooler URL from session (5432) to transaction (6543)', () => {
    expect(new URL(normalizePoolerUrl(SESSION, {} as NodeJS.ProcessEnv)).port).toBe('6543');
  });

  it('keeps the rest of the connection string intact', () => {
    const out = new URL(normalizePoolerUrl(SESSION, {} as NodeJS.ProcessEnv));
    expect(out.hostname).toBe('aws-1-us-west-1.pooler.supabase.com');
    expect(out.username).toBe('postgres.abc');
    expect(out.pathname).toBe('/postgres');
  });

  it('leaves a URL already on 6543 alone', () => {
    const already = SESSION.replace(':5432', ':6543');
    expect(new URL(normalizePoolerUrl(already, {} as NodeJS.ProcessEnv)).port).toBe('6543');
  });

  it('honours the DB_POOL_MODE=session escape hatch', () => {
    expect(normalizePoolerUrl(SESSION, { DB_POOL_MODE: 'session' } as NodeJS.ProcessEnv)).toBe(SESSION);
  });

  it('never rewrites a direct (non-pooler) Supabase connection', () => {
    const direct = 'postgresql://postgres:pw@db.abc.supabase.co:5432/postgres';
    expect(normalizePoolerUrl(direct, {} as NodeJS.ProcessEnv)).toBe(direct);
  });

  it('leaves local/other databases untouched', () => {
    const local = 'postgresql://u:p@localhost:5432/postgres';
    expect(normalizePoolerUrl(local, {} as NodeJS.ProcessEnv)).toBe(local);
  });

  it('does not throw on an unparseable connection string', () => {
    expect(normalizePoolerUrl('not a url', {} as NodeJS.ProcessEnv)).toBe('not a url');
  });
});

describe('error classification', () => {
  it('recognises the Supavisor circuit breaker', () => {
    const e = new Error('(ECIRCUITBREAKER) too many authentication failures, new connections are temporarily blocked');
    expect(isCircuitBreakerError(e)).toBe(true);
    // ...and it still counts as transient, so a cron skips rather than crashing.
    expect(isTransientDbError(e)).toBe(true);
  });

  it('recognises the pooler connect timeout that crashed the deploy', () => {
    expect(isTransientDbError(new Error('Failed to connect to database: {:error, :timeout}'))).toBe(true);
  });

  it('does not treat a real bug as transient', () => {
    expect(isTransientDbError(new Error('column "foo" does not exist'))).toBe(false);
    expect(isCircuitBreakerError(new Error('column "foo" does not exist'))).toBe(false);
  });
});
