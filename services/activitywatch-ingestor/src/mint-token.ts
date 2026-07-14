// Mint a per-person ingest token (you run this with DB access; the teammate
// never does). Usage:
//   corepack pnpm exec tsx services/activitywatch-ingestor/src/mint-token.ts --host jane --label "Jane Smith"
// `--host` is the identifier that person's time shows under in the dashboard's
// "Whose time" switcher. The printed token has NO database access — it only lets
// their agent POST activity as that host.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { assertDatabaseUrl, loadConfig } from '@tt/shared';
import { closePool, createIngestToken, getPool } from '@tt/db';

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

async function main(): Promise<void> {
  const cfg = loadConfig();
  assertDatabaseUrl(cfg);
  const host = arg('--host');
  const label = arg('--label') ?? null;
  if (!host || host.startsWith('--')) {
    console.error('usage: mint-token --host <person-id> [--label "Full Name"]');
    process.exit(1);
  }
  const pool = getPool(cfg.databaseUrl);
  try {
    const { token } = await createIngestToken(pool, cfg.schema, { hostname: host, label });
    console.log(`\nIngest token for "${host}"${label ? ` (${label})` : ''} — shown ONCE, store securely:\n`);
    console.log(`  ${token}\n`);
    console.log('Give the teammate this token + the dashboard/ingest URL. It has no database access.');
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error('[mint-token] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
