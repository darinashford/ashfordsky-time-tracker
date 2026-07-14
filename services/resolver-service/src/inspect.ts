import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { bucketFor, categorizeActivity, formatDuration, loadConfig, localDate } from '@tt/shared';
import { closePool, getIntervalsForDay, getOcrTextByInterval, getPool, loadClientGraph, loadEnabledRules } from '@tt/db';
import { ContextEngine, extractSignals, runResolvers } from '@tt/resolvers';

for (const p of ['.env', '../.env', '../../.env', '../../../.env']) {
  const f = resolve(process.cwd(), p);
  if (existsSync(f)) {
    dotenv.config({ path: f });
    break;
  }
}

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/**
 * Read-only tuning tool. Re-runs the resolver chain over a date range WITHOUT
 * writing anything, then prints:
 *   - coverage by active duration,
 *   - per-app resolution breakdown,
 *   - the verbatim titles/URLs that did NOT resolve (your "what to fix" list).
 * This is the worklist for tuning resolvers against your real window titles.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const tz = cfg.timezone;
  const pool = getPool(cfg.databaseUrl);
  const config = { autoFinalizeThreshold: cfg.autoFinalizeThreshold, reviewThreshold: cfg.reviewThreshold };

  try {
    const graph = await loadClientGraph(pool, {
      internalDomains: cfg.internalDomains,
      freemailDomains: cfg.freemailDomains,
    });
    const rules = await loadEnabledRules(pool, cfg.schema);

    const dateArg = arg('--date');
    const days = Number(arg('--days') ?? '1');
    const dates = dateArg
      ? [dateArg]
      : Array.from({ length: days }, (_, d) => localDate(new Date(Date.now() - d * 86_400_000).toISOString(), tz));

    const statusSec: Record<string, number> = {};
    const byApp = new Map<string, { sec: number; statuses: Record<string, number> }>();
    const byClient = new Map<string, number>();
    const byCategory = new Map<string, number>();
    const misses: Array<{ app: string; title: string; url: string; dur: number; status: string; conf: number; resolver: string }> = [];
    let activeSec = 0;

    for (const day of dates) {
      const intervals = await getIntervalsForDay(pool, cfg.schema, day, tz);
      const ocrByInterval = await getOcrTextByInterval(pool, cfg.schema, day, tz);
      const engine = new ContextEngine({ ttlSeconds: 1800 });
      for (const iv of intervals) {
        if (iv.isAfk) continue;
        const app = iv.app ?? '(none)';
        activeSec += iv.durationSeconds; // count ALL active time, not just >= min
        const a = byApp.get(app) ?? { sec: 0, statuses: {} };
        a.sec += iv.durationSeconds;

        let status = 'unresolved';
        let conf = 0;
        let resolver = '-';
        let clientId: string | null = null;
        const sig = extractSignals(iv);
        if (iv.durationSeconds >= cfg.minIntervalSeconds) {
          const ctx = {
            graph,
            rules,
            config,
            currentAnchor: engine.anchorFor(iv),
            ocrText: ocrByInterval.get(iv.id) ?? null,
          };
          const { resolution, winner } = runResolvers(iv, ctx);
          engine.observe(iv, winner);
          status = resolution.status;
          conf = resolution.confidence;
          resolver = resolution.resolverType ?? '-';
          clientId = resolution.clientId;
        }

        // Mirror the runner's categorization so coverage reflects the buckets.
        const cat = categorizeActivity(
          { appNorm: sig.appNorm, host: sig.host, title: iv.windowTitle, url: iv.url },
          { staffNameTokens: graph.staffNameTokens },
        );
        const bucket = bucketFor(
          { clientId, resolverType: resolver === '-' ? null : resolver, confidence: conf },
          cat,
          cfg.reviewThreshold,
        );
        if (bucket) {
          status = 'nonbillable';
          clientId = null;
          byCategory.set(bucket, (byCategory.get(bucket) ?? 0) + iv.durationSeconds);
        }

        statusSec[status] = (statusSec[status] ?? 0) + iv.durationSeconds;
        a.statuses[status] = (a.statuses[status] ?? 0) + iv.durationSeconds;
        byApp.set(app, a);

        if (clientId && status !== 'nonbillable') {
          byClient.set(clientId, (byClient.get(clientId) ?? 0) + iv.durationSeconds);
        }

        if (status === 'unresolved' || status === 'needs_review') {
          misses.push({
            app,
            title: iv.windowTitle ?? '',
            url: sig.host || (iv.url ?? ''),
            dur: iv.durationSeconds,
            status,
            conf,
            resolver,
          });
        }
      }
    }

    const pct = (s: number): string => (activeSec ? `${Math.round((s / activeSec) * 100)}%` : '0%');
    console.log(`\n=== Coverage (${dates.join(', ')}) — active ${formatDuration(activeSec)} ===`);
    for (const st of ['auto_finalized', 'confirmed', 'suggested', 'needs_review', 'unresolved', 'nonbillable']) {
      if (statusSec[st]) console.log(`  ${st.padEnd(15)} ${formatDuration(statusSec[st]).padStart(8)}  ${pct(statusSec[st])}`);
    }

    console.log(`\n=== By app ===`);
    const apps = [...byApp.entries()].sort((a, b) => b[1].sec - a[1].sec);
    for (const [app, info] of apps) {
      const top = Object.entries(info.statuses).sort((a, b) => b[1] - a[1])[0];
      console.log(`  ${app.padEnd(24)} ${formatDuration(info.sec).padStart(8)}  mostly:${top?.[0] ?? '-'}`);
    }

    console.log(`\n=== By client (attributed today, incl. suggestions/review) ===`);
    const clients = [...byClient.entries()].sort((a, b) => b[1] - a[1]);
    for (const [cid, sec] of clients.slice(0, 25)) {
      const name = graph.clients.get(cid)?.name ?? cid;
      console.log(`  ${name.padEnd(34)} ${formatDuration(sec).padStart(8)}`);
    }
    if (clients.length === 0) console.log('  (no client-attributed time yet)');

    console.log(`\n=== Non-client buckets (categorized non-billable) ===`);
    const cats = [...byCategory.entries()].sort((a, b) => b[1] - a[1]);
    for (const [key, sec] of cats) {
      console.log(`  ${key.padEnd(20)} ${formatDuration(sec).padStart(8)}  ${pct(sec)}`);
    }
    if (cats.length === 0) console.log('  (no categorized non-client time)');

    console.log(`\n=== Unresolved / needs-review samples (your tuning worklist) ===`);
    misses.sort((a, b) => b.dur - a.dur);
    for (const m of misses.slice(0, 40)) {
      console.log(`  [${m.status}/${m.conf.toFixed(2)}] ${formatDuration(m.dur).padStart(7)}  ${m.app}`);
      console.log(`      title: ${m.title}`);
      if (m.url) console.log(`      host:  ${m.url}`);
    }
    if (misses.length === 0) console.log('  (nothing unresolved — every active block attributed)');
    console.log('');
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error('[inspect] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
