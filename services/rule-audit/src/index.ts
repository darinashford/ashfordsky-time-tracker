import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';
import { ruleRisk } from '@tt/shared';
import { autoDisableRule, findOverBroadTitleRules, type OverBroadRule } from '@tt/db';

// ---------------------------------------------------------------------------
// Nightly rule audit — now an auto-fixer, not just a heads-up.
//
// "set client · remember" can teach a bad rule (a generic word like
// "bookkeeping", or a shared tool like "pdfgear", pinned to one client). Those
// silently mis-bill every future block containing the word, and waiting for a
// human to notice meant days of bad attribution.
//
// Two passes:
//  1. PROVEN over-broad -> DISABLED automatically. The test is the firm's own
//     data, not a word list: if DIRECT evidence (emails, calendar, CCH/QBO/FC,
//     mapped files) already ties the token to >= MIN_CLIENTS different clients,
//     it cannot be a client identifier. Nothing is deleted, the reason is
//     recorded, and a rule a person enabled by hand is never touched.
//  2. Looks-risky (shared host / single common word) -> reported only, as before.
//
// Env:
//   DATABASE_URL           Supabase (required)
//   RULE_ALERT_WEBHOOK_URL incoming webhook to post to (optional; logs if unset)
//   DASHBOARD_URL          link included in the message (optional)
//   RULE_AUDIT_MIN_CLIENTS spread threshold (default 3)
//   RULE_AUDIT_DRY_RUN     'true' = report what it would disable, change nothing
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

function buildDisabledMessage(disabled: OverBroadRule[], dryRun: boolean): string | null {
  if (disabled.length === 0) return null;
  const verb = dryRun ? 'would be turned off' : 'turned off';
  return [
    `🧹 Time Tracker: ${disabled.length} learned rule${disabled.length === 1 ? '' : 's'} ${verb} — the word matches several clients, so it can't identify one.`,
    ...disabled
      .slice(0, 10)
      .map(
        (r) =>
          `• "${r.pattern}" → ${r.clientName ?? '—'} (was claiming ${r.blocksHit} blocks; seen on ${r.distinctClients} clients)`,
      ),
    disabled.length > 10 ? `…and ${disabled.length - 10} more.` : '',
    'Nothing was deleted — re-enable any of them on the Manual Rules page and the audit will leave it alone from then on.',
  ]
    .filter(Boolean)
    .join('\n');
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
    // Pass 1 — disable what the data proves is over-broad.
    const minClients = Number(process.env.RULE_AUDIT_MIN_CLIENTS ?? '3');
    const dryRun = process.env.RULE_AUDIT_DRY_RUN === 'true';
    const overBroad = await findOverBroadTitleRules(pool, 'time_tracker', minClients);
    for (const r of overBroad) {
      const reason =
        `matched ${r.distinctClients} different clients (${r.clientNames.slice(0, 4).join(', ')}` +
        `${r.clientNames.length > 4 ? '…' : ''}) — not a client identifier`;
      if (dryRun) console.log(`[rule-audit] WOULD disable "${r.pattern}" → ${r.clientName}: ${reason}`);
      else {
        await autoDisableRule(pool, 'time_tracker', r.id, reason);
        console.log(`[rule-audit] disabled "${r.pattern}" → ${r.clientName}: ${reason}`);
      }
    }

    // Pass 2 — report the ones that only *look* risky; a human decides those.
    const risky = await loadRisky(pool);
    const message = [buildDisabledMessage(overBroad, dryRun), buildMessage(risky)].filter(Boolean).join('\n\n');
    console.log(
      `[rule-audit] ${overBroad.length} auto-disabled, ${risky.length} risky rule(s), ` +
        `${risky.filter((r) => r.isNew).length} new this week.`,
    );
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
