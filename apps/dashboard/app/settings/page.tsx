import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { secondsToHours } from '@tt/shared';
import { getDb, listPeople, type PersonRow } from '../../lib/db';
import { revokeTokenAction, rotateTokenAction } from '../../lib/actions';
import { getViewerScope } from '../../lib/viewer';
import { MintToken } from '../../components/MintToken';
import { HowItWorks } from '../../components/RawHelp';

export const dynamic = 'force-dynamic';

/** "3m ago" / "2h ago" / "5d ago" for the last-active column. */
function ago(iso: string | null): string {
  if (!iso) return 'never';
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

function mt(iso: string | null, tz: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' }).format(
    new Date(iso),
  );
}

/** The machine's self-reported health: code version, task states, recent errors. */
function AgentCell({ p, tz }: { p: PersonRow; tz: string }) {
  if (!p.tokenId) return <span className="muted small">local (this machine)</span>;
  if (!p.agentReportedAt) return <span className="muted small">no report yet</span>;
  const tasks = p.agentReport?.tasks ?? {};
  const badTasks = Object.entries(tasks).filter(([, v]) => v !== 'Ready' && v !== 'Running');
  const errs = p.agentReport?.recentErrors ?? [];
  const healthy = badTasks.length === 0;
  return (
    <div className="small">
      <span className="mono">{p.agentSha ?? '?'}</span>{' '}
      <span className="muted">· {ago(p.agentReportedAt)}</span>{' '}
      {healthy ? (
        <span className="badge" style={{ background: '#e8f5ec', color: '#1f8a4c' }}>tasks ok</span>
      ) : (
        <span className="badge" style={{ background: '#fdecea', color: '#c0392b' }} title={badTasks.map(([k, v]) => `${k}: ${v}`).join(', ')}>
          {badTasks.map(([k, v]) => `${k}: ${v}`).join(', ')}
        </span>
      )}
      {errs.length > 0 && (
        <div className="muted" title={errs.join('\n')} style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          last err: {errs[errs.length - 1]}
        </div>
      )}
      {p.rotatePending && <div style={{ color: '#b8860b' }}>token rotation pending…</div>}
      {!p.rotatePending && p.rotatedAt && <div className="muted">token rotated {mt(p.rotatedAt, tz)}</div>}
    </div>
  );
}

function AccessBadge({ p }: { p: PersonRow }) {
  if (p.tokenRevoked === true) return <span className="badge" style={{ background: '#fdecea', color: '#c0392b' }}>revoked</span>;
  if (p.tokenRevoked === false) return <span className="badge" style={{ background: '#e8f5ec', color: '#1f8a4c' }}>token</span>;
  return <span className="badge" style={{ background: '#eef0f2', color: '#566573' }}>owner (direct)</span>;
}

export default async function SettingsPage() {
  // Owner-only: tokens and the people list cover the whole firm.
  if (!(await getViewerScope()).isOwner) redirect('/day/today');
  const { cfg } = getDb();
  let body: ReactNode;
  try {
    const people = await listPeople();
    body = (
      <>
        <h2>People</h2>
        {people.length === 0 ? (
          <p className="muted small">No activity or tokens yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th>Access</th>
                <th>First seen</th>
                <th>Last active</th>
                <th>Agent</th>
                <th className="num">Time logged</th>
                <th className="num">Blocks</th>
                <th className="num">Days</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.hostname}>
                  <td>
                    <div><strong>{p.label ?? p.hostname}</strong></div>
                    <div className="muted small mono">{p.hostname}</div>
                  </td>
                  <td><AccessBadge p={p} /></td>
                  <td className="small">{mt(p.firstSeen, cfg.timezone)}</td>
                  <td className="small">
                    {ago(p.lastActive)}
                    {p.blocks === 0 && p.tokenId && !p.tokenRevoked && (
                      <div className="muted small">token issued {mt(p.tokenCreatedAt, cfg.timezone)}, no data yet</div>
                    )}
                  </td>
                  <td><AgentCell p={p} tz={cfg.timezone} /></td>
                  <td className="num">{secondsToHours(p.activeSeconds)}h</td>
                  <td className="num">{p.blocks}</td>
                  <td className="num">{p.daysActive}</td>
                  <td className="num">
                    {p.tokenId && p.tokenRevoked === false && (
                      <span style={{ display: 'inline-flex', gap: 6 }}>
                        {!p.rotatePending && (
                          <form action={rotateTokenAction} style={{ display: 'inline' }}>
                            <input type="hidden" name="tokenId" value={p.tokenId} />
                            <button type="submit" className="small" title="Issue a fresh token through their next sync — nothing to do on their machine">
                              rotate
                            </button>
                          </form>
                        )}
                        <form action={revokeTokenAction} style={{ display: 'inline' }}>
                          <input type="hidden" name="tokenId" value={p.tokenId} />
                          <button type="submit" className="warn small">revoke</button>
                        </form>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="small muted">
          “Time logged” is active (non-idle) tracked time, all days. “Last active” is their newest synced block
          (or token use). Revoking a token stops that person’s machine from sending time — it does not delete
          anything already recorded.
        </p>

        <h2>Add a person</h2>
        <MintToken />

        <h2>How access works</h2>
        <div className="card" style={{ padding: 14 }}>
          <p className="small" style={{ marginTop: 0 }}>
            <strong>Seeing this dashboard</strong>: anyone signing in with an{' '}
            <span className="mono">@ashfordsky.com</span> Microsoft account gets in. Their login’s email name is
            matched to their short id (alex@ashfordsky.com → “alex”): <strong>Today</strong> always shows their
            own time, <strong>Raw Data</strong> defaults to it (switchable to anyone), and{' '}
            <strong>Reporting</strong> shows the whole firm. This page is owner-only.
          </p>
          <p className="small">
            <strong>Sending time is the real allowed-list</strong> — the tokens above. To add someone: create
            their token here, send it to them securely with the one-line installer, and they paste both. Their
            time starts appearing within ~10–15 minutes, attributed by the same engine as yours. To remove
            someone, revoke their token.
          </p>
          <p className="small" style={{ marginBottom: 0 }}>
            Your own machine (“owner (direct)”) writes straight to the database and doesn’t use a token.
          </p>
        </div>
      </>
    );
  } catch (err) {
    body = (
      <div className="card" style={{ marginTop: 20 }}>
        <p><strong>Could not load settings.</strong></p>
        <pre className="small">{err instanceof Error ? err.message : String(err)}</pre>
      </div>
    );
  }

  return (
    <>
      <div className="topbar">
        <h1>Settings</h1>
      </div>
      {body}
      <h2 style={{ marginTop: 28 }}>How this works</h2>
      <p className="small muted" style={{ maxWidth: 780, marginTop: 0 }}>
        The whole pipeline, end to end — how time is captured and refreshed, how each block is matched to a
        client, how confidence becomes a billing status, and how idle time and calls are handled. (This same
        explainer is also on the Raw Data tab, so teammates can see it too.)
      </p>
      <HowItWorks
        autoFinalizeThreshold={cfg.autoFinalizeThreshold}
        reviewThreshold={cfg.reviewThreshold}
        awayCutoffSeconds={cfg.awayCutoffSeconds}
        screenshotsEnabled={cfg.screenshotsEnabled}
        screenshotStableSeconds={cfg.screenshotStableSeconds}
        screenshotRetentionDays={cfg.screenshotRetentionDays}
        llmEnabled={cfg.llmEnabled}
      />
    </>
  );
}
