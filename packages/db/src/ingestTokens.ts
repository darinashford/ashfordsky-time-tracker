import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { validIdent } from './pool';

/** SHA-256 of a token. Tokens are 256-bit random, so an unsalted hash is safe. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Mint a new ingest token for a machine/person. Returns the PLAINTEXT token
 * once (only its hash is stored) — hand it to the teammate; it can't be recovered.
 */
export async function createIngestToken(
  pool: pg.Pool,
  schema: string,
  x: { hostname: string; label?: string | null },
): Promise<{ id: string; token: string }> {
  const s = validIdent(schema);
  const token = `ttk_${randomBytes(32).toString('base64url')}`;
  const res = await pool.query(
    `insert into ${s}.ingest_tokens (token_hash, hostname, label) values ($1,$2,$3) returning id`,
    [hashToken(token), x.hostname, x.label ?? null],
  );
  return { id: res.rows[0].id as string, token };
}

/**
 * Resolve a plaintext token to its host, or null if invalid/revoked. Also accepts
 * a PENDING rotation token: its first successful use promotes it to the active
 * token (completing a remote rotation, no action on the teammate machine beyond
 * the agent having rewritten its own .env).
 */
export async function resolveIngestToken(
  pool: pg.Pool,
  schema: string,
  token: string,
): Promise<{ id: string; hostname: string } | null> {
  const s = validIdent(schema);
  const h = hashToken(token);
  const res = await pool.query(
    `select id, hostname from ${s}.ingest_tokens where token_hash = $1 and not revoked`,
    [h],
  );
  if (res.rows[0]) return res.rows[0] as { id: string; hostname: string };

  // Pending rotation token? Promote on first use.
  const pending = await pool.query(
    `update ${s}.ingest_tokens
        set token_hash = pending_token_hash,
            pending_token_hash = null,
            rotate_requested = false,
            rotated_at = now()
      where pending_token_hash = $1 and not revoked
      returning id, hostname`,
    [h],
  );
  return (pending.rows[0] as { id: string; hostname: string }) ?? null;
}

/** Admin asked for a rotation: the next sync response will carry a fresh token. */
export async function requestTokenRotation(pool: pg.Pool, schema: string, tokenId: string): Promise<void> {
  const s = validIdent(schema);
  await pool.query(`update ${s}.ingest_tokens set rotate_requested = true where id = $1 and not revoked`, [tokenId]);
}

/**
 * Mint the replacement token for a rotation-requested row. Stores only the hash;
 * returns the plaintext ONCE so the ingest response can hand it to the agent.
 * Idempotent-by-overwrite: called again before adoption, it simply re-issues.
 */
export async function issuePendingToken(pool: pg.Pool, schema: string, tokenId: string): Promise<string> {
  const s = validIdent(schema);
  const token = `ttk_${randomBytes(32).toString('base64url')}`;
  await pool.query(`update ${s}.ingest_tokens set pending_token_hash = $2 where id = $1`, [tokenId, hashToken(token)]);
  return token;
}

/** Store the agent's self-reported machine health (code sha, tasks, last errors). */
export async function recordAgentReport(
  pool: pg.Pool,
  schema: string,
  tokenId: string,
  x: { sha?: string | null; report?: unknown },
): Promise<void> {
  const s = validIdent(schema);
  await pool.query(
    `update ${s}.ingest_tokens
        set agent_sha = coalesce($2, agent_sha),
            agent_report = coalesce($3::jsonb, agent_report),
            agent_reported_at = now()
      where id = $1`,
    [tokenId, x.sha ?? null, x.report === undefined ? null : JSON.stringify(x.report)],
  );
}

export async function touchIngestToken(pool: pg.Pool, schema: string, id: string): Promise<void> {
  const s = validIdent(schema);
  await pool.query(`update ${s}.ingest_tokens set last_used_at = now() where id = $1`, [id]);
}
