import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { assertDatabaseUrl, loadConfig } from '@tt/shared';
import { getPool, closePool, validIdent } from './pool';
import { loadClientGraph } from './clientGraph';
import { upsertIntervals, type IntervalInput } from './intervals';

for (const p of ['.env', '../.env', '../../.env', '../../../.env']) {
  const f = resolve(process.cwd(), p);
  if (existsSync(f)) {
    dotenv.config({ path: f });
    break;
  }
}

/**
 * Seeds a synthetic demo DAY into time_tracker only, using your real client
 * graph so the resolvers actually fire. Nothing is written to public.* and no
 * real client data is committed to the repo — it is generated on your machine.
 *
 * Run `pnpm resolve` afterwards to attribute the seeded intervals.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  assertDatabaseUrl(cfg);
  const pool = getPool(cfg.databaseUrl);
  const schema = validIdent(cfg.schema);

  try {
    const graph = await loadClientGraph(pool, {
      internalDomains: cfg.internalDomains,
      freemailDomains: cfg.freemailDomains,
    });

    // Pick a few real clients that have distinct signals to exercise resolvers.
    const domainClients = [...graph.byDomain.entries()]
      .filter(([, ids]) => ids.length === 1)
      .map(([domain, ids]) => ({ domain, clientId: ids[0]!, name: graph.clients.get(ids[0]!)?.name ?? 'Client' }))
      .slice(0, 3);
    const folder = graph.folders[0];
    const folderName = folder ? graph.clients.get(folder.clientId)?.name ?? 'Client' : null;

    const a = domainClients[0];
    const b = domainClients[1] ?? domainClients[0];

    const specs: Array<{ app: string; title: string; url?: string; minutes: number; afk?: boolean }> = [];
    if (a) specs.push({ app: 'CCH Axcess', title: `CCH Axcess Tax — ${a.name} — 2024 Form 1040`, minutes: 25 });
    specs.push({ app: 'chrome', title: 'Claude', url: 'https://claude.ai/chat/seed-demo', minutes: 10 });
    if (a) specs.push({ app: 'EXCEL', title: `${a.name} 2024 Workpapers.xlsx - Excel`, minutes: 20 });
    if (folder && folder.path) specs.push({ app: 'msedge', title: `${folderName} - All Documents`, url: folder.path, minutes: 15 });
    if (b) specs.push({ app: 'Missive', title: `${b.name} — Q2 docs — info@${b.domain}`, minutes: 12 });
    specs.push({ app: 'afk', title: 'Lunch', minutes: 30, afk: true });
    specs.push({
      app: 'chrome',
      title: 'New Prospect Budget - Google Sheets',
      url: 'https://docs.google.com/spreadsheets/d/1SEEDunmappedSheetID0000000000000000/edit',
      minutes: 18,
    });
    specs.push({ app: 'chrome', title: 'ChatGPT', url: 'https://chat.openai.com/c/seed-demo', minutes: 10 });
    specs.push({ app: 'Code', title: 'index.ts — time-tracker — Visual Studio Code', minutes: 20 });

    let cursor = Date.now() - 5 * 60 * 60 * 1000; // start ~5h ago
    const intervals: IntervalInput[] = specs.map((s, i) => {
      const start = cursor;
      const end = start + s.minutes * 60 * 1000;
      cursor = end + 60 * 1000; // 1-min gap
      return {
        source: 'seed',
        hostname: 'SEED-DEMO',
        startTs: new Date(start).toISOString(),
        endTs: new Date(end).toISOString(),
        durationSeconds: s.minutes * 60,
        app: s.app === 'afk' ? null : s.app,
        windowTitle: s.title,
        url: s.url ?? null,
        browser: ['chrome', 'msedge', 'edge'].includes(s.app) ? s.app : null,
        isAfk: !!s.afk,
        dedupeKey: `seed|${i}`,
      };
    });

    const saved = await upsertIntervals(pool, schema, intervals);

    // Sensible default exclusions (idempotent via created_by='seed').
    await pool.query(`delete from ${schema}.exclusions where created_by = 'seed'`);
    const exclusions: Array<[string, string, string, string]> = [
      ['no_screenshot', 'app', '1password', 'contains'],
      ['no_screenshot', 'app', 'bitwarden', 'contains'],
      ['no_screenshot', 'domain', 'chase.com', 'domain'],
      ['nonbillable', 'domain', 'youtube.com', 'domain'],
      ['nonbillable', 'app', 'spotify', 'contains'],
    ];
    for (const [kind, field, pattern, matchKind] of exclusions) {
      await pool.query(
        `insert into ${schema}.exclusions (kind, field, match_kind, pattern, normalized, created_by)
         values ($1,$2,$3,$4,$5,'seed')`,
        [kind, field, matchKind, pattern, pattern.toLowerCase()],
      );
    }

    console.log(`[seed] inserted ${saved.length} demo intervals + ${exclusions.length} default exclusions.`);
    console.log('[seed] next: run "pnpm resolve" to attribute them, then "pnpm dashboard".');
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error('[seed] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
