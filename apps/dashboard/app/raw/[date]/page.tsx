import type { ReactNode } from 'react';
import Link from 'next/link';
import { localDate } from '@tt/shared';
import { getDayTimeline, getHosts, getScreenshotActivity } from '@tt/db';
import { getDb, listClientOptions } from '../../../lib/db';
import { getViewerScope } from '../../../lib/viewer';
import { Timeline, type TabKey, type TimelineRowVM } from '../../../components/Timeline';
import { DateJump } from '../../../components/DateJump';
import { HowItWorks, LabelsHelp } from '../../../components/RawHelp';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TAB_KEYS = new Set(['auto', 'suggested', 'needs_review', 'unresolved', 'nonbillable']);

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Raw Data: every captured block for a day, read-only, with the attribution and
 * the "why" inline. Reached directly from the sidebar, or pre-filtered to one
 * client by clicking a name in Today's per-client summary.
 */
export default async function RawPage({
  params,
  searchParams,
}: {
  params: { date: string };
  searchParams: { client?: string; status?: string; host?: string; view?: string };
}) {
  const { pool, schema, cfg } = getDb();
  const date = DATE_RE.test(params.date) ? params.date : localDate(new Date().toISOString(), cfg.timezone);
  const view = searchParams.view === 'labels' || searchParams.view === 'how' ? searchParams.view : 'blocks';
  const fClient = typeof searchParams.client === 'string' ? searchParams.client : undefined;
  const fStatus = typeof searchParams.status === 'string' ? searchParams.status : undefined;
  // Defaults to the signed-in person's own machine. The owner alone may switch
  // via the "Whose time" bar (a person, or Everyone = ?host=all); a non-owner
  // is pinned to self and any ?host= they pass is ignored.
  const scope = await getViewerScope();
  const qHost = typeof searchParams.host === 'string' && searchParams.host ? searchParams.host : undefined;
  const fHost = scope.isOwner
    ? qHost === 'all'
      ? undefined
      : qHost ?? scope.selfHost ?? undefined
    : scope.selfHost ?? undefined;
  const initialTab: TabKey = fStatus && TAB_KEYS.has(fStatus) ? (fStatus as TabKey) : 'all';
  const keepFilters = [
    fClient ? `client=${encodeURIComponent(fClient)}` : '',
    fStatus ? `status=${encodeURIComponent(fStatus)}` : '',
    scope.isOwner && qHost ? `host=${encodeURIComponent(qHost)}` : '',
  ]
    .filter(Boolean)
    .join('&');
  const q = keepFilters ? `?${keepFilters}` : '';

  let content: ReactNode;
  if (view === 'labels') {
    content = <LabelsHelp />;
  } else if (view === 'how') {
    const shots = await getScreenshotActivity(pool, schema).catch(() => null);
    content = (
      <HowItWorks
        autoFinalizeThreshold={cfg.autoFinalizeThreshold}
        reviewThreshold={cfg.reviewThreshold}
        awayCutoffSeconds={cfg.awayCutoffSeconds}
        screenshotsEnabled={cfg.screenshotsEnabled || (shots?.active ?? false)}
        screenshotStoresLocally={(shots?.storedLocal ?? 0) > 0}
        screenshotStableSeconds={cfg.screenshotStableSeconds}
        screenshotRetentionDays={cfg.screenshotRetentionDays}
        llmEnabled={cfg.llmEnabled}
      />
    );
  } else
  try {
    const [timeline, hosts, clients] = await Promise.all([
      getDayTimeline(pool, schema, date, cfg.timezone, fHost),
      getHosts(pool, schema),
      listClientOptions(),
    ]);

    // Idle (AFK) blocks are hidden by default (they're accounted for on Today);
    // ?client=idle surfaces them (minus the locked screen) for the drill-down.
    const visible = timeline.filter((t) => {
      if (fClient === 'idle') return t.isAfk && !(t.app ?? '').toLowerCase().includes('lockapp');
      if (t.isAfk) return false;
      if (fClient === 'none') return t.clientId == null;
      if (fClient) return t.clientId === fClient;
      return true;
    });

    const filterName =
      fClient === 'none'
        ? '(unattributed)'
        : fClient === 'idle'
          ? 'idle (not typing, unlocked)'
          : fClient
            ? clients.find((c) => c.id === fClient)?.name ?? 'client'
            : null;

    const rows: TimelineRowVM[] = visible;

    content = (
      <>
        {scope.isOwner && hosts.length > 1 && (
          <div className="tabs" style={{ margin: '2px 0 10px' }}>
            <span className="muted small" style={{ alignSelf: 'center', marginRight: 2 }}>Whose time:</span>
            <Link className={`tab${!fHost ? ' active' : ''}`} href={`/raw/${date}?host=all`}>
              Everyone
            </Link>
            {hosts.map((h) => (
              <Link key={h} className={`tab${fHost === h ? ' active' : ''}`} href={`/raw/${date}?host=${encodeURIComponent(h)}`}>
                {h}{h === scope.selfHost ? ' (you)' : ''}
              </Link>
            ))}
          </div>
        )}
        {fClient && (
          <p className="small">
            Filtered to <strong>{filterName}</strong> — {rows.length} blocks.{' '}
            <Link href={`/raw/${date}${fHost ? `?host=${encodeURIComponent(fHost)}` : ''}`}>clear filter</Link>
          </p>
        )}
        <Timeline
          tz={cfg.timezone}
          rows={rows}
          initialTab={initialTab}
          edit={{ clients, date, host: fHost ?? null }}
        />
      </>
    );
  } catch (err) {
    content = (
      <div className="card" style={{ marginTop: 20 }}>
        <p>
          <strong>Could not load data.</strong>
        </p>
        <pre className="small">{err instanceof Error ? err.message : String(err)}</pre>
      </div>
    );
  }

  return (
    <>
      <div className="topbar">
        <h1>Raw Data</h1>
        <div className="datenav">
          <Link className="btn" href={`/raw/${addDays(date, -1)}${q}`}>
            ◀
          </Link>
          <DateJump date={date} base="/raw" suffix={q} />
          <Link className="btn" href={`/raw/${addDays(date, 1)}${q}`}>
            ▶
          </Link>
          <Link className="btn" href={`/raw/${localDate(new Date().toISOString(), cfg.timezone)}${q}`}>
            today
          </Link>
          <Link className="btn" href={`/day/${date}`}>
            day summary
          </Link>
          <a className="btn" href={`/api/export/${date}?host=${encodeURIComponent(fHost ?? 'all')}`}>
            ⬇ CSV
          </a>
        </div>
      </div>
      <div className="tabs" style={{ margin: '0 0 12px' }}>
        <Link className={`tab${view === 'blocks' ? ' active' : ''}`} href={`/raw/${date}${q}`}>
          Blocks
        </Link>
        <Link className={`tab${view === 'labels' ? ' active' : ''}`} href={`/raw/${date}?view=labels`}>
          What the labels mean
        </Link>
        <Link className={`tab${view === 'how' ? ' active' : ''}`} href={`/raw/${date}?view=how`}>
          How this works
        </Link>
      </div>
      {content}
    </>
  );
}
