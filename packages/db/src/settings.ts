import type pg from 'pg';
import { validIdent } from './pool';

export async function getSetting<T = unknown>(
  pool: pg.Pool,
  schema: string,
  key: string,
): Promise<T | null> {
  const s = validIdent(schema);
  const res = await pool.query(`select value from ${s}.settings where key = $1`, [key]);
  return res.rows.length ? (res.rows[0].value as T) : null;
}

export async function setSetting(
  pool: pg.Pool,
  schema: string,
  key: string,
  value: unknown,
): Promise<void> {
  const s = validIdent(schema);
  await pool.query(
    `insert into ${s}.settings (key, value, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}
