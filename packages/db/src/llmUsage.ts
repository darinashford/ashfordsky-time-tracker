import type pg from 'pg';
import { validIdent } from './pool';

export interface LlmUsageRow {
  day: string; // local date YYYY-MM-DD
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  blocks: number;
}

/** Append one row of LLM-classifier token usage + cost (one per pass/day). */
export async function recordLlmUsage(pool: pg.Pool, schema: string, u: LlmUsageRow): Promise<void> {
  if (u.calls <= 0) return; // nothing actually billed
  const s = validIdent(schema);
  await pool.query(
    `insert into ${s}.llm_usage
       (day, model, calls, input_tokens, output_tokens, cache_read_tokens, cost_usd, blocks)
     values ($1::date,$2,$3,$4,$5,$6,$7,$8)`,
    [u.day, u.model, u.calls, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.costUsd, u.blocks],
  );
}

export interface LlmCost {
  costUsd: number;
  calls: number;
  blocks: number;
  monthCostUsd: number; // month-to-date, same calendar month as `day`
}

/** Classifier cost for one local day + its month-to-date, for the dashboard meter. */
export async function getLlmCostForDay(pool: pg.Pool, schema: string, day: string): Promise<LlmCost> {
  const s = validIdent(schema);
  const res = await pool.query(
    `select
        coalesce(sum(cost_usd) filter (where day = $1::date), 0)                              as "costUsd",
        coalesce(sum(calls)    filter (where day = $1::date), 0)                              as "calls",
        coalesce(sum(blocks)   filter (where day = $1::date), 0)                              as "blocks",
        coalesce(sum(cost_usd) filter (where date_trunc('month', day) = date_trunc('month', $1::date)), 0) as "monthCostUsd"
       from ${s}.llm_usage`,
    [day],
  );
  const r = res.rows[0] ?? {};
  return {
    costUsd: Number(r.costUsd ?? 0),
    calls: Number(r.calls ?? 0),
    blocks: Number(r.blocks ?? 0),
    monthCostUsd: Number(r.monthCostUsd ?? 0),
  };
}
