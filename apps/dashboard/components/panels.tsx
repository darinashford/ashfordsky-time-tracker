import type { CoverageReportRow, DailyClientSummaryRow } from '@tt/shared';
import { categoryLabel, formatDuration, secondsToHours } from '@tt/shared';
import type { CategoryBucket, IdleBucket } from '@tt/db';

const seg = (label: string, value: number, color: string) => ({ label, value, color });

export function CoveragePanel({ coverage }: { coverage: CoverageReportRow }) {
  const active = Math.max(coverage.activeSeconds, 1);
  const segments = [
    seg('confident', coverage.autoFinalizedSeconds, '#1f8a4c'),
    seg('confirmed', coverage.confirmedSeconds, '#2ecc71'),
    seg('likely', coverage.suggestedSeconds, '#b8860b'),
    seg('uncertain', coverage.needsReviewSeconds, '#c0392b'),
    seg('non-billable', coverage.nonbillableSeconds, '#566573'),
    seg('unknown', coverage.unresolvedSeconds, '#7f8c8d'),
  ];
  const p = (v: number) => `${Math.round((v / active) * 100)}%`;
  return (
    <div>
      <div className="bar">
        {segments.map((s) => (
          <span key={s.label} style={{ width: p(s.value), background: s.color }} title={`${s.label}: ${p(s.value)}`} />
        ))}
      </div>
      <div className="legend">
        {segments.map((s) => (
          <span key={s.label}>
            <i style={{ background: s.color }} />
            {s.label} {p(s.value)}
          </span>
        ))}
        <span className="muted">screenshot-supported {p(coverage.screenshotSupportedSeconds)}</span>
      </div>
    </div>
  );
}

// Bucket colors mirror the coverage/accuracy bar so the table reads like a
// per-client version of it. Confirmed folds into Auto-finalized for display.
const BUCKET = {
  autoFinal: '#1f8a4c',
  suggested: '#b8860b',
  needsReview: '#c0392b',
  unresolved: '#7f8c8d',
} as const;

/** An hours cell: dash for zero (ledger convention); links to the timeline drill-down. */
function Hrs({
  seconds,
  color,
  strong,
  href,
}: {
  seconds: number;
  color?: string;
  strong?: boolean;
  href?: string;
}) {
  const h = secondsToHours(seconds);
  if (h === 0) return <td className="num muted">–</td>;
  const style = { color, fontWeight: strong ? 600 : undefined } as const;
  return (
    <td className="num">
      {href ? (
        <a href={href} style={style} title="Show these blocks in the timeline">
          {h}h
        </a>
      ) : (
        <span style={style}>{h}h</span>
      )}
    </td>
  );
}

// Plain-English meaning of each bucket, shown as a legend under the table.
const STATUS_HELP: { label: string; color: string; muted?: boolean; desc: string }[] = [
  {
    label: 'Confident',
    color: BUCKET.autoFinal,
    desc: 'A strong, direct signal — a calendar meeting, a rule, a CCH/QBO id, a mapped Sheet / SharePoint / Drive folder, or an exact client email or domain. Counted as billable.',
  },
  {
    label: 'Likely',
    color: BUCKET.suggested,
    desc: 'Probably this client, from a weaker signal — a name in the title, or carried over from what you were just working on.',
  },
  {
    label: 'Uncertain',
    color: BUCKET.needsReview,
    desc: 'A weak or conflicting signal — an ambiguous shared domain, or time borrowed from a nearby block. Fix persistent misses at the root (a rule or mapping), not block by block.',
  },
  {
    label: 'Non-bill',
    color: '#566573',
    muted: true,
    desc: 'Matched a non-billable category (social, music, email/internal, firm-internal). Itemized in the section below.',
  },
];

function StatusLegend() {
  return (
    <div className="muted small" style={{ marginTop: 8, lineHeight: 1.6 }}>
      <div style={{ marginBottom: 4 }}>
        <strong>What the columns mean</strong> — click any number to see exactly those blocks (with the “why”) in
        Raw Data:
      </div>
      {STATUS_HELP.map((s) => (
        <div key={s.label} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
          <span
            style={{
              flex: '0 0 9px',
              width: 9,
              height: 9,
              borderRadius: 2,
              background: s.color,
              display: 'inline-block',
              transform: 'translateY(1px)',
            }}
          />
          <span>
            <strong style={{ color: s.muted ? undefined : s.color }}>{s.label}</strong> — {s.desc}
          </span>
        </div>
      ))}
    </div>
  );
}

export function BillingTable({
  rows,
  nonBillable,
  idle,
  date,
  host,
}: {
  rows: DailyClientSummaryRow[];
  nonBillable?: { seconds: number; blocks: number };
  idle?: { seconds: number; blocks: number };
  date: string;
  /** Whose day this is — carried into the Raw Data drill-down so it opens on the
   *  same person you were viewing, not the signed-in user's default. */
  host?: string | null;
}) {
  // Non-billable is shown as its own row (a pseudo-client), not a column. All
  // non-billable time has no client, so it lives under "(unattributed)" in the
  // raw data; we split it out here and remove it from the unattributed totals.
  const nbSeconds = nonBillable?.seconds ?? rows.reduce((a, r) => a + r.nonbillableSeconds, 0);
  const nbBlocks = nonBillable?.blocks ?? 0;

  // Client rows: billable/attributable buckets only (auto+confirmed, suggested,
  // needs-review, unresolved). Auto-final = auto_finalized + confirmed.
  const view = rows
    .map((r) => {
      const afSec = r.autoFinalizedSeconds + r.confirmedSeconds;
      const totalSec = afSec + r.suggestedSeconds + r.needsReviewSeconds + r.unresolvedSeconds;
      const key = r.clientId ?? 'none';
      // The unattributed row's block count includes the non-billable blocks we're
      // splitting out, so subtract them back off it.
      const blocks = key === 'none' ? Math.max(0, r.intervalCount - nbBlocks) : r.intervalCount;
      return { r, afSec, totalSec, key, blocks };
    })
    .filter((v) => v.totalSec > 0);

  if (view.length === 0 && nbSeconds === 0)
    return <p className="muted small">No attributed time yet for this day.</p>;

  // Idle/away is shown as its own row too, so the Total ties to "Total on
  // computer" (active + idle) rather than just active.
  const idleSeconds = idle?.seconds ?? 0;
  const idleBlocks = idle?.blocks ?? 0;

  const sumSec = (pick: (v: (typeof view)[number]) => number) => view.reduce((a, v) => a + pick(v), 0);
  const tot = {
    afSec: sumSec((v) => v.afSec),
    suSec: sumSec((v) => v.r.suggestedSeconds),
    nrSec: sumSec((v) => v.r.needsReviewSeconds),
    totalSec: sumSec((v) => v.totalSec) + nbSeconds + idleSeconds,
    blocks: view.reduce((a, v) => a + v.blocks, 0) + nbBlocks + idleBlocks,
  };

  // Drill-down: a summary number → the Raw Data page filtered to that client+bucket,
  // keeping whose day we're on (?host=) so it doesn't fall back to the viewer's own.
  const h = host ? `&host=${encodeURIComponent(host)}` : '';
  const link = (clientKey: string, status: string) =>
    `/raw/${date}?client=${encodeURIComponent(clientKey)}&status=${status}${h}`;
  const allLink = (status: string) => `/raw/${date}?status=${status}${h}`;
  // Clicking a client name → every block for that client (all statuses).
  const clientLink = (clientKey: string) => `/raw/${date}?client=${encodeURIComponent(clientKey)}${h}`;

  return (
    <>
      <table>
        <thead>
          <tr>
            <th>Client</th>
            <th className="num">Total</th>
            <th className="num" style={{ color: BUCKET.autoFinal }}>Confident</th>
            <th className="num" style={{ color: BUCKET.suggested }}>Likely</th>
            <th className="num" style={{ color: BUCKET.needsReview }}>Uncertain</th>
            <th className="num">Blocks</th>
          </tr>
        </thead>
        <tbody>
          {view.map(({ r, afSec, totalSec, key, blocks }) => (
            <tr key={key}>
              <td>
                <a href={clientLink(key)} title="Show every block in the timeline">
                  {r.clientName ?? '(unattributed)'}
                </a>
              </td>
              <td className="num" style={{ fontWeight: 600 }}>{secondsToHours(totalSec)}h</td>
              <Hrs seconds={afSec} color={BUCKET.autoFinal} href={link(key, 'auto')} />
              <Hrs seconds={r.suggestedSeconds} color={BUCKET.suggested} href={link(key, 'suggested')} />
              <Hrs seconds={r.needsReviewSeconds} color={BUCKET.needsReview} href={link(key, 'needs_review')} />
              <td className="num muted">{blocks}</td>
            </tr>
          ))}
          {nbSeconds > 0 && (
            <tr>
              <td>Non-billable</td>
              <Hrs seconds={nbSeconds} strong href={allLink('nonbillable')} />
              <td className="num muted">–</td>
              <td className="num muted">–</td>
              <td className="num muted">–</td>
              <td className="num muted">{nbBlocks || '–'}</td>
            </tr>
          )}
          {idleSeconds > 0 && (
            <tr>
              <td>
                <a href={clientLink('idle')} title="Show idle blocks in the timeline">Idle</a>{' '}
                <span className="muted small">(not typing, unlocked)</span>
              </td>
              <Hrs seconds={idleSeconds} strong href={clientLink('idle')} />
              <td className="num muted">–</td>
              <td className="num muted">–</td>
              <td className="num muted">–</td>
              <td className="num muted">{idleBlocks || '–'}</td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td style={{ fontWeight: 600 }}>Total</td>
            <td className="num" style={{ fontWeight: 600 }}>{secondsToHours(tot.totalSec)}h</td>
            <Hrs seconds={tot.afSec} color={BUCKET.autoFinal} strong href={allLink('auto')} />
            <Hrs seconds={tot.suSec} color={BUCKET.suggested} strong href={allLink('suggested')} />
            <Hrs seconds={tot.nrSec} color={BUCKET.needsReview} strong href={allLink('needs_review')} />
            <td className="num muted">{tot.blocks}</td>
          </tr>
        </tfoot>
      </table>
      <StatusLegend />
    </>
  );
}

export function BucketsTable({ rows }: { rows: CategoryBucket[] }) {
  if (rows.length === 0) return <p className="muted small">No non-billable time categorized yet.</p>;
  const totalSeconds = rows.reduce((a, r) => a + r.seconds, 0);
  const totalBlocks = rows.reduce((a, r) => a + r.intervals, 0);
  const denom = totalSeconds || 1;
  return (
    <table>
      <thead>
        <tr>
          <th>Bucket</th>
          <th className="num">Time</th>
          <th className="num">Share</th>
          <th className="num">Blocks</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.category}>
            <td>{categoryLabel(r.category)}</td>
            <td className="num">{formatDuration(r.seconds)}</td>
            <td className="num muted">{Math.round((r.seconds / denom) * 100)}%</td>
            <td className="num muted">{r.intervals}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        {/* Total ties to the per-client "Non-billable" row (same seconds, same Xh format). */}
        <tr>
          <td style={{ fontWeight: 600 }}>Total non-billable</td>
          <td className="num" style={{ fontWeight: 600 }}>{secondsToHours(totalSeconds)}h</td>
          <td className="num muted">100%</td>
          <td className="num muted">{totalBlocks}</td>
        </tr>
      </tfoot>
    </table>
  );
}

export function IdleTable({ rows }: { rows: IdleBucket[] }) {
  if (rows.length === 0) return <p className="muted small">No idle time — you were active all day.</p>;
  const totalSeconds = rows.reduce((a, r) => a + r.seconds, 0);
  const totalBlocks = rows.reduce((a, r) => a + r.intervals, 0);
  const denom = totalSeconds || 1;
  return (
    <table>
      <thead>
        <tr>
          <th>What was on screen</th>
          <th className="num">Time</th>
          <th className="num">Share</th>
          <th className="num">Blocks</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.kind}>
            <td>{r.kind}</td>
            <td className="num">{formatDuration(r.seconds)}</td>
            <td className="num muted">{Math.round((r.seconds / denom) * 100)}%</td>
            <td className="num muted">{r.intervals}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        {/* Total ties to the per-client "Idle" row (locked time is excluded upstream). */}
        <tr>
          <td style={{ fontWeight: 600 }}>Total idle</td>
          <td className="num" style={{ fontWeight: 600 }}>{secondsToHours(totalSeconds)}h</td>
          <td className="num muted">100%</td>
          <td className="num muted">{totalBlocks}</td>
        </tr>
      </tfoot>
    </table>
  );
}
