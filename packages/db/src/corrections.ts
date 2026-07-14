import type pg from 'pg';
import { validIdent } from './pool';

export interface CorrectionInput {
  intervalId?: string | null;
  action: string;
  oldClientId?: string | null;
  newClientId?: string | null;
  note?: string | null;
  payload?: Record<string, unknown>;
  createdRuleId?: string | null;
  createdBy?: string;
}

export async function insertCorrection(
  pool: pg.Pool,
  schema: string,
  c: CorrectionInput,
): Promise<string> {
  const s = validIdent(schema);
  const res = await pool.query(
    `insert into ${s}.corrections
       (interval_id, action, old_client_id, new_client_id, note, payload, created_rule_id, created_by)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7, coalesce($8,'darin@ashfordsky.com'))
     returning id`,
    [
      c.intervalId ?? null, c.action, c.oldClientId ?? null, c.newClientId ?? null,
      c.note ?? null, JSON.stringify(c.payload ?? {}), c.createdRuleId ?? null, c.createdBy ?? null,
    ],
  );
  return res.rows[0].id as string;
}

export async function linkCorrectionRule(
  pool: pg.Pool,
  schema: string,
  correctionId: string,
  ruleId: string,
): Promise<void> {
  const s = validIdent(schema);
  await pool.query(`update ${s}.corrections set created_rule_id = $2 where id = $1`, [
    correctionId,
    ruleId,
  ]);
}
