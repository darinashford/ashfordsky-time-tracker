import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { localDate, secondsToHours } from '@tt/shared';
import {
  getCategoryBreakdown,
  getCoverage,
  getDailyClientSummary,
  getDataFreshness,
  getHosts,
  getIdleBreakdown,
} from '@tt/db';
import { getDb, listClientOptions, listManualEntries } from '../../../lib/db';
import { getViewerScope } from '../../../lib/viewer';
import { BillingTable, BucketsTable, CoveragePanel, IdleTable } from '../../../components/panels';
import { DateJump } from '../../../components/DateJump';
import { ManualEntry } from '../../../components/ManualEntry';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Sync-health pill: green if activity was ingested recently, amber/red if the
 *  10-min sync looks stalled. Lets you see at a glance that tracking is alive. */
function SyncBadge({ minutesAgo }: { minutesAgo: number | null }) {
  const m = minutesAgo;
  const color = m == null ? '#c0392b' : m <= 15 ? '#1f8a4c' : m <= 60 ? '#b8860b' : '#c0392b';
  const text = m == null ? 'no activity recorded yet' : m <= 1 ? 'just now' : `${m} min ago`;
  return (
    <div className="small muted" style={{ marginBottom: 6 }}>
      <span
        style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color, marginRight: 6, verticalAlign: 'middle' }}
      />
      Synced {text}
      {m != null && m > 20 && (
        <span style={{ color: '#b8860b' }}>
          {' '}— sync may be stalled; check ActivityWatch and the AshfordSky-TimeTracker-Sync task
        </span>
      )}
    </div>
  );
}

export default async function DayPage({
  params,
  searchParams,
}: {
  params: { date: string };
  searchParams: { client?: string; status?: string; host?: string };
}) {
  const { pool, schema, cfg } = getDb();
  // "Today" is the local (Mountain) calendar day, not UTC — otherwise after ~5–6pm
  // MT the default/today would roll to tomorrow's mostly-empty day.
  const date = DATE_RE.test(params.date)
    ? params.date
    : localDate(new Date().toISOString(), cfg.timezone);
  // Today is personal and always scoped to ONE person (never an "everyone"
  // total). It defaults to the signed-in person's own machine. The owner alone
  // may switch to another person via ?host=; a non-owner is pinned to self and
  // any ?host= they pass is ignored.
  const scope = await getViewerScope();
  const requestedHost =
    typeof searchParams.host === 'string' && searchParams.host ? searchParams.host : undefined;
  const fHost = (scope.isOwner ? requestedHost : undefined) ?? scope.selfHost ?? undefined;

  // Block-level drill-downs live on the Raw Data page now; keep old links working.
  if (searchParams.client || searchParams.status) {
    const qs = new URLSearchParams();
    if (searchParams.client) qs.set('client', searchParams.client);
    if (searchParams.status) qs.set('status', searchParams.status);
    if (fHost) qs.set('host', fHost);
    redirect(`/raw/${date}?${qs.toString()}`);
  }

  let content: ReactNode;
  try {
    const [summary, coverage, buckets, idleBuckets, freshness, hosts, clients, manualEntries] = await Promise.all([
      getDailyClientSummary(pool, schema, date, fHost),
      getCoverage(pool, schema, date, fHost),
      getCategoryBreakdown(pool, schema, date, cfg.timezone, fHost),
      getIdleBreakdown(pool, schema, date, cfg.timezone, cfg.awayCutoffSeconds, fHost),
      getDataFreshness(pool, schema, fHost),
      getHosts(pool, schema),
      listClientOptions(),
      listManualEntries(date, fHost ?? null),
    ]);

    const billable = summary.reduce((a, r) => a + r.billableSeconds, 0);
    const autoPct = coverage.activeSeconds
      ? Math.round(((coverage.autoFinalizedSeconds + coverage.confirmedSeconds) / coverage.activeSeconds) * 100)
      : 0;
    // "Total on computer" = active + idle, excluding only a locked screen (Darin's
    // call). getIdleBreakdown already drops locked time, so summing it gives the
    // counted idle — and the breakdown total ties to the per-client "Idle" row.
    const idleSeconds = idleBuckets.reduce((a, b) => a + b.seconds, 0);
    const idleBlocks = idleBuckets.reduce((a, b) => a + b.intervals, 0);
    const totalOnComputer = coverage.activeSeconds + idleSeconds;
    // Non-billable totals for its own row in the per-client table (from the
    // category breakdown, which is authoritative for non-billable seconds + blocks).
    const nonBillable = {
      seconds: buckets.reduce((a, b) => a + b.seconds, 0),
      blocks: buckets.reduce((a, b) => a + b.intervals, 0),
    };

    content = (
      <>
        <SyncBadge minutesAgo={freshness.minutesAgo} />
        {scope.isOwner && hosts.length > 1 && (
          <div className="tabs" style={{ margin: '2px 0 10px' }}>
            <span className="muted small" style={{ alignSelf: 'center', marginRight: 2 }}>Whose time:</span>
            {hosts.map((h) => (
              <Link key={h} className={`tab${fHost === h ? ' active' : ''}`} href={`/day/${date}?host=${encodeURIComponent(h)}`}>
                {h}{h === scope.selfHost ? ' (you)' : ''}
              </Link>
            ))}
          </div>
        )}
        <div className="cards">
          <div className="card">
            <div className="k">Total on computer</div>
            <div className="v">{secondsToHours(totalOnComputer)}h</div>
          </div>
          <div className="card">
            <div className="k">Active</div>
            <div className="v">{secondsToHours(coverage.activeSeconds)}h</div>
          </div>
          <div className="card">
            <div className="k">Billable</div>
            <div className="v">{secondsToHours(billable)}h</div>
          </div>
          <div className="card">
            <div className="k">Confident</div>
            <div className="v">{autoPct}%</div>
          </div>
          <div className="card">
            <div className="k">Uncertain</div>
            <div className="v">{secondsToHours(coverage.needsReviewSeconds)}h</div>
          </div>
        </div>

        <h2>Coverage / accuracy</h2>
        <CoveragePanel coverage={coverage} />

        <h2>Per-client summary</h2>
        <BillingTable rows={summary} nonBillable={nonBillable} idle={{ seconds: idleSeconds, blocks: idleBlocks }} date={date} />

        <ManualEntry
          date={date}
          host={fHost ?? (hosts.length === 1 ? hosts[0]! : null)}
          tz={cfg.timezone}
          clients={clients}
          entries={manualEntries}
        />

        <h2>Non-billable buckets</h2>
        <BucketsTable rows={buckets} />

        <h2>Idle / away breakdown</h2>
        <p className="small muted">
          Short idle — ActivityWatch saw no keyboard/mouse for 3+ min but under {Math.round(cfg.awayCutoffSeconds / 60)} min
          at a stretch (reading, thinking, a quick step away). This counts toward Total on computer and ties to the Idle row
          above. Longer unbroken stretches are treated as “away” (lunch, a meeting elsewhere) — excluded even if an app was
          left open — as is locked-screen time.
        </p>
        <IdleTable rows={idleBuckets} />

        <p className="small muted" style={{ marginTop: 18 }}>
          Click any client or number above to open its blocks in <Link href={`/raw/${date}`}>Raw Data</Link>.
        </p>
      </>
    );
  } catch (err) {
    content = (
      <div className="card" style={{ marginTop: 20 }}>
        <p>
          <strong>Could not load data.</strong> Make sure <code>DATABASE_URL</code> is set in <code>.env</code> and that
          you have run <code>pnpm seed</code> / <code>pnpm resolve</code>.
        </p>
        <pre className="small">{err instanceof Error ? err.message : String(err)}</pre>
      </div>
    );
  }

  // Keep the owner's selected person across date navigation. Self is the
  // default, so only a non-self pick needs to ride along in the URL.
  const navSuffix =
    scope.isOwner && requestedHost && requestedHost !== scope.selfHost
      ? `?host=${encodeURIComponent(requestedHost)}`
      : '';
  return (
    <>
      <div className="topbar">
        <h1>Today</h1>
        <div className="datenav">
          <Link className="btn" href={`/day/${addDays(date, -1)}${navSuffix}`}>
            ◀
          </Link>
          <DateJump date={date} base="/day" suffix={navSuffix} />
          <Link className="btn" href={`/day/${addDays(date, 1)}${navSuffix}`}>
            ▶
          </Link>
          <Link className="btn" href={`/day/${localDate(new Date().toISOString(), cfg.timezone)}${navSuffix}`}>
            today
          </Link>
          <a className="btn" href={`/api/export/${date}?host=${encodeURIComponent(fHost ?? 'all')}`}>
            ⬇ CSV
          </a>
        </div>
      </div>
      {content}
    </>
  );
}
