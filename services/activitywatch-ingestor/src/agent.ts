// Thin sync agent for a teammate's machine. Reads local ActivityWatch, normalizes
// activity locally, and POSTs it to the dashboard's /api/ingest with a per-person
// token. It holds NO database credentials. Config via env:
//   INGEST_URL   = https://<dashboard>/api/ingest
//   INGEST_TOKEN = ttk_...   (from `mint-token`, given to them by the admin)
//   ACTIVITYWATCH_URL (optional, default http://localhost:5600)
// Phase 3 packages this into a one-file installer; for now it runs via tsx.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { loadConfig } from '@tt/shared';
import { ActivityWatchAdapter } from './activitywatch';
import { normalizeEvents, toRawEventInput } from './normalize';

let envPath: string | null = null;
for (const p of ['.env', '../.env', '../../.env', '../../../.env']) {
  const f = resolve(process.cwd(), p);
  if (existsSync(f)) {
    dotenv.config({ path: f });
    envPath = f;
    break;
  }
}

/** Best-effort self-report: which code this machine runs + what run-agent observed. */
function buildMeta(): { sha: string | null; report: unknown } {
  let sha: string | null = null;
  try {
    sha = execSync('git rev-parse --short HEAD', { timeout: 10_000, windowsHide: true }).toString().trim() || null;
  } catch {
    sha = null;
  }
  let report: unknown = null;
  try {
    const f = resolve(process.cwd(), '.data', 'agent-report.json');
    if (existsSync(f)) report = JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    report = null;
  }
  return { sha, report };
}

/**
 * Remote token rotation: the server handed us a fresh token — rewrite our own
 * .env in place. The new token's first use (next cycle) promotes it server-side;
 * the old one keeps working until then, so there is no gap.
 */
function adoptRotatedToken(newToken: string): void {
  if (!envPath) return;
  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
  const out = lines.map((l) => (/^\s*INGEST_TOKEN\s*=/.test(l) ? `INGEST_TOKEN=${newToken}` : l));
  if (!out.some((l) => l.startsWith('INGEST_TOKEN='))) out.push(`INGEST_TOKEN=${newToken}`);
  writeFileSync(envPath, out.join('\n'), 'utf8');
  console.log('[agent] token rotated by the server; .env updated (active from next sync).');
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const url = process.env.INGEST_URL;
  const token = process.env.INGEST_TOKEN;
  if (!url || !token) {
    console.error('[agent] set INGEST_URL and INGEST_TOKEN in .env (no DATABASE_URL needed).');
    process.exit(1);
  }

  const now = new Date();
  const until = now.toISOString();
  // Trailing ~26h window; the server upserts in place and only prunes today, so a
  // generous window is safe and self-heals any missed cycle.
  const since = new Date(now.getTime() - 26 * 3_600_000).toISOString();

  const adapter = new ActivityWatchAdapter(cfg.activitywatchUrl);
  const events = await adapter.fetchEvents({ since, until });
  if (events.length === 0) {
    console.log('[agent] no activity to send.');
    return;
  }
  const intervals = normalizeEvents(events, { mergeGapSeconds: 60 });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ since, until, rawEvents: events.map(toRawEventInput), intervals, meta: buildMeta() }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`[agent] ingest failed (HTTP ${res.status}): ${text}`);
    process.exit(1);
  }
  let parsed: { rotateToken?: string } = {};
  try {
    parsed = JSON.parse(text) as { rotateToken?: string };
  } catch {
    parsed = {};
  }
  if (parsed.rotateToken) adoptRotatedToken(parsed.rotateToken);
  console.log(`[agent] sent ${intervals.length} intervals; server: ${text.replace(/"rotateToken":"[^"]+"/, '"rotateToken":"<redacted>"')}`);
}

main().catch((err) => {
  console.error('[agent] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
