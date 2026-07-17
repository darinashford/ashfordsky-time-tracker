import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';
import { ruleRisk } from '@tt/shared';

// ---------------------------------------------------------------------------
// Weekly rule audit — a scheduled heads-up, not an auto-fixer.
//
// "set client · remember" can teach a bad rule (a generic word or a firm/shared
// host mapped to one client). Prevention now blocks most, and the Manual Rules
// page flags the rest live — but a rule taught on a Tuesday shouldn't run bogus
// for a month before someone opens that page. This job runs weekly (Railway
// cron), finds rules that look over-broad, and posts a short message to a
// webhook you set (Slack / Teams / Discord / email-via-Zapier). It never
// disables anything: billing rules stay human-in-the-loop.
//
// Env:
//   DATABASE_URL           Supabase (required)
//   RULE_ALERT_WEBHOOK_URL incoming webhook to post to (optional; logs if unset)
//   DASHBOARD_URL          link included in the message (optional)
// ---------------------------------------------------------------------------

for (const p of ['.env', '../.env', '../../.env', '../../../.env']) {
  const f = resolve(process.cwd(), p);
  if (existsSync(f)) {
    dotenv.config({ path: f });
    break;
  }
}

const { Pool } = pg;

interface RuleRow {
  id: string;
  ruleType: string;
  pattern: string;
  clientName: string | null;
  createdBy: string | null;
  createdAt: string | null;
  blocksHit: number;
  isNew: boolean; // created in the last 7 days
}

async function loadRisky(pool: pg.Pool): Promise<RuleRow[]> {
  const { rows } = await pool.query<RuleRow>(
    `select r.id, r.rule_type as "ruleType", r.pattern,
            c.name as "clientName",
            (select co.created_by from time_tracker.corrections co
              where co.created_rule_id = r.id order by co.created_at desc limit 1) as "createdBy",
            r.created_at as "createdAt",
            (select count(*)::int from time_tracker.resolutions res
               where res.resolver_type='rule' and res.evidence->>'ruleId' = r.id::text) as "blocksHit",
            (r.created_at > now() - interval '7 days') as "isNew"
       from time_tracker.attribution_rules r
       left join public.clients c on c.id = r.client_id
      where r.enabled = true`,
  );
  // Reuse the exact same risk logic the dashboard shows.
  return rows.filter((r) => ruleRisk(r.ruleType, r.pattern) != null);
}

function describe(r: RuleRow): string {
  const p = `"${r.pattern}"`;
  const what =
    r.ruleType === 'url_host'
      ? `any page on ${p}`
      : r.ruleType === 'title_pattern'
        ? `any title containing ${p}`
        : `${r.ruleType} ${p}`;
  const why = ruleRisk(r.ruleType, r.pattern) ?? '';
  return `• ${what} → ${r.clientName ?? '—'} (${r.blocksHit} blocks; by ${r.createdBy ?? 'unknown'}) — ${why}`;
}

function buildMessage(risky: RuleRow[]): string | null {
  const fresh = risky.filter((r) => r.isNew);
  // Silent weeks: only speak up when a NEW risky rule appeared. The total is
  // included for context so a growing pile doesn't hide.
  if (fresh.length === 0) return null;
  const link = process.env.DASHBOARD_URL ? `${process.env.DASHBOARD_URL.replace(/\/$/, '')}/rules` : 'the Manual Rules page';
  const lines = [
    `⚠ Time Tracker: ${fresh.length} new learned rule${fresh.length === 1 ? '' : 's'} look${fresh.length === 1 ? 's' : ''} over-broad this week` +
      (risky.length > fresh.length ? ` (${risky.length} risky total).` : '.'),
    ...fresh.slice(0, 10).map(describe),
    fresh.length > 10 ? `…and ${fresh.length - 10} more.` : '',
    `Review / disable: ${link}`,
  ];
  return lines.filter(Boolean).join('\n');
}

async function post(url: string, text: string): Promise<void> {
  // One payload that satisfies Slack/Teams ("text") and Discord ("content").
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, content: text }),
  });
  if (!res.ok) throw new Error(`webhook ${res.status} ${res.statusText}`);
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL is required');
  const isLocal = /@(localhost|127\.0\.0\.1|\[?::1\]?)[:/]/i.test(dbUrl);
  const pool = new Pool({
    connectionString: dbUrl,
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
    max: 2,
    application_name: 'ashfordsky-rule-audit',
  });
  try {
    const risky = await loadRisky(pool);
    const message = buildMessage(risky);
    console.log(`[rule-audit] ${risky.length} risky rule(s), ${risky.filter((r) => r.isNew).length} new this week.`);
    if (!message) {
      console.log('[rule-audit] nothing new — staying quiet.');
      return;
    }
    console.log(message);
    const webhook = process.env.RULE_ALERT_WEBHOOK_URL;
    if (webhook) {
      await post(webhook, message);
      console.log('[rule-audit] posted to webhook.');
    } else {
      console.log('[rule-audit] RULE_ALERT_WEBHOOK_URL unset — logged only.');
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[rule-audit] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
