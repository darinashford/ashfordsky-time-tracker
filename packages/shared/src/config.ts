// Central config loader. Reads process.env (after the entrypoint has loaded
// .env via dotenv) and applies safe defaults. Pure: pass a custom env for tests.

export interface AppConfig {
  databaseUrl: string;
  schema: string;
  timezone: string;
  internalDomains: string[];
  internalClientNames: string[];
  freemailDomains: string[];
  autoFinalizeThreshold: number;
  reviewThreshold: number;
  minIntervalSeconds: number;
  /** One contiguous idle stretch longer than this = "away" (never billed, and
   *  not counted as on-computer idle). Lunch with an app left open ≠ at desk. */
  awayCutoffSeconds: number;
  /** A no-input stretch shorter than this is a pause at the desk (reading,
   *  thinking, listening on a call), NOT idle — it counts as active and is
   *  attributed like the work around it. ActivityWatch flags AFK after ~3 min;
   *  this raises the effective idle threshold in our own pipeline (default 10
   *  min) without reconfiguring each machine's watcher. */
  idleGraceSeconds: number;
  activitywatchUrl: string;
  sensorMode: 'mock' | 'live';
  screenshotsEnabled: boolean;
  screenshotDir: string;
  screenshotStableSeconds: number;
  screenshotRetentionDays: number;
  // LLM resolver (final pass over residual/ambiguous blocks).
  llmEnabled: boolean;
  anthropicApiKey: string;
  llmModel: string;
  llmMaxBlocks: number;
}

const DEFAULT_FREEMAIL = [
  'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'aol.com',
];

function num(v: string | undefined, d: number): number {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
}

function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const freemail = list(env.FREEMAIL_DOMAINS);
  return {
    databaseUrl: env.DATABASE_URL ?? '',
    schema: env.TIME_TRACKER_SCHEMA ?? 'time_tracker',
    timezone: env.TIMEZONE ?? 'America/Denver',
    internalDomains: list(env.INTERNAL_DOMAINS),
    internalClientNames: list(env.INTERNAL_CLIENT_NAMES).length
      ? list(env.INTERNAL_CLIENT_NAMES)
      : ['ashford sky'],
    freemailDomains: freemail.length ? freemail : DEFAULT_FREEMAIL,
    autoFinalizeThreshold: num(env.AUTO_FINALIZE_THRESHOLD, 0.85),
    reviewThreshold: num(env.REVIEW_THRESHOLD, 0.5),
    minIntervalSeconds: num(env.MIN_INTERVAL_SECONDS, 5),
    awayCutoffSeconds: num(env.AWAY_CUTOFF_SECONDS, 1800),
    idleGraceSeconds: num(env.IDLE_GRACE_SECONDS, 600),
    activitywatchUrl: env.ACTIVITYWATCH_URL ?? 'http://localhost:5600',
    sensorMode: env.SENSOR_MODE === 'live' ? 'live' : 'mock',
    screenshotsEnabled: env.SCREENSHOTS_ENABLED === 'true',
    screenshotDir: env.SCREENSHOT_DIR ?? './.data/screenshots',
    screenshotStableSeconds: num(env.SCREENSHOT_STABLE_SECONDS, 20),
    screenshotRetentionDays: num(env.SCREENSHOT_RETENTION_DAYS, 14),
    // LLM resolver: opt-in, needs a key. Default model is Opus 4.8; set
    // LLM_MODEL=claude-haiku-4-5 to cut per-block cost ~5x once it's dialed in.
    llmEnabled: env.LLM_ENABLED === 'true',
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? '',
    llmModel: env.LLM_MODEL ?? 'claude-opus-4-8',
    llmMaxBlocks: num(env.LLM_MAX_BLOCKS, 120),
  };
}

export function assertDatabaseUrl(cfg: AppConfig): void {
  if (!cfg.databaseUrl || cfg.databaseUrl.includes('__paste')) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env and paste your Supabase ' +
        'connection string (Project Settings > Database > Connection string).',
    );
  }
}
