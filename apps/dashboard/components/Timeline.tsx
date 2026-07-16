'use client';

import { Fragment, memo, useMemo, useState } from 'react';
import { useFormState } from 'react-dom';
import { categoryLabel, formatDuration, localClock } from '@tt/shared';
import { describeLearn } from '../lib/learn';
import {
  dispositionBucket,
  type Disposition,
  explainEvidence,
  pct,
  resolverLabel,
  statusColor,
  statusLabel,
} from '../lib/format';
import { setClientAction } from '../lib/actions';

export interface ClientOption {
  id: string;
  name: string;
}

/** When present, each block shows a "set client" control that reassigns it (and
 *  teaches the engine). Only passed on Raw Data for someone who may edit. */
export interface EditCtx {
  clients: ClientOption[];
  date: string;
  host: string | null;
}

export interface TimelineRowVM {
  id: string;
  startTs: string;
  endTs: string;
  durationSeconds: number;
  app: string | null;
  windowTitle: string | null;
  url: string | null;
  clientId: string | null;
  clientName: string | null;
  status: string | null;
  confidence: number | null;
  resolverType: string | null;
  isBillable: boolean | null;
  needsReview: boolean | null;
  category: string | null;
  reviewStatus: string | null;
  screenshotStatus: string | null;
  screenshotId: string | null;
  evidence: Record<string, unknown> | null;
}

export type TabKey = Disposition | 'all';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'auto', label: 'Confident' },
  { key: 'suggested', label: 'Likely' },
  { key: 'needs_review', label: 'Uncertain' },
  { key: 'unresolved', label: 'Unknown' },
  { key: 'nonbillable', label: 'Non-billable' },
];

const TAB_COLOR: Record<TabKey, string> = {
  all: '#2563eb',
  auto: '#1f8a4c',
  suggested: '#b8860b',
  needs_review: '#c0392b',
  unresolved: '#7f8c8d',
  nonbillable: '#566573',
};

/**
 * The heading a block files under: WHY its time went where it did. Coarse
 * families (meeting, email, mapped file, their system, carried over, ...) so
 * the day reads as "this hour went to the client because of a calendar meeting;
 * that half hour because their sheet was open".
 */
function reasonOf(r: TimelineRowVM): { key: string; label: string } {
  if (r.status === 'nonbillable' || r.isBillable === false) {
    const c = r.category ?? 'other';
    return { key: `nb:${c}`, label: `Non-billable — ${categoryLabel(c)}` };
  }
  const t = r.resolverType ?? '';
  if (!t) return { key: 'none', label: 'No client signal found' };
  if (t === 'manual') return { key: 'manual', label: 'You set the client yourself' };
  if (t === 'rule') return { key: 'rule', label: 'Matched a rule you created' };
  if (t === 'llm') return { key: 'llm', label: 'AI judgement from the window content' };
  if (t.includes('calendar') || t === 'call_run' || t === 'meeting_idle')
    return { key: 'meeting', label: 'On a call or calendar meeting with this client' };
  if (t.includes('email')) return { key: 'email', label: 'An email tied to this client was on screen' };
  if (t.includes('sheet') || t.includes('excel') || t.includes('folder'))
    return { key: 'file', label: 'Working in a file or folder mapped to this client' };
  if (t === 'review_tracker') return { key: 'review', label: 'Reviewing this client’s return in the Review Tracker' };
  if (t.includes('cch') || t.includes('qbo') || t.includes('financial'))
    return { key: 'system', label: 'In their accounting system (CCH / QBO / Financial Cents)' };
  if (t.includes('ocr')) return { key: 'ocr', label: 'The screenshot text identified this client' };
  if (t.includes('title') || t.includes('name')) return { key: 'title', label: 'The client’s name was in the window title' };
  if (t.includes('browser')) return { key: 'website', label: 'On a website tied to this client' };
  if (t.includes('chat')) return { key: 'chat', label: 'Their chat workspace or AI chat content' };
  if (t === 'context_carry_forward') return { key: 'carry', label: 'Carried over from what you were doing just before' };
  if (t === 'neighbor') return { key: 'neighbor', label: 'Borrowed from the surrounding activity' };
  return { key: t, label: resolverLabel(t) };
}

interface Decorated {
  r: TimelineRowVM;
  disp: Disposition;
}

/** Same-activity chunks rolled into one line (title flicker shatters one task
 *  into many 1–5s blocks); expandable, and capped so a huge expand can't freeze. */
interface Cluster {
  key: string;
  rows: Decorated[];
  seconds: number;
}

interface Group {
  key: string;
  label: string;
  clusters: Cluster[];
  seconds: number;
  blocks: number;
}

const EXPAND_CAP = 40; // chunks shown per cluster before "show all"

/**
 * Read-only raw-data view grouped by ATTRIBUTION REASON: each heading answers
 * "why did this time go to that client?" (a meeting, an email on screen, a
 * mapped file, carried over, ...). Groups start collapsed — headers with
 * totals — so the page stays light; corrections happen upstream, not here.
 */
export function Timeline({
  tz,
  rows,
  initialTab = 'all',
  edit,
}: {
  tz: string;
  rows: TimelineRowVM[];
  initialTab?: TabKey;
  edit?: EditCtx;
}) {
  const [tab, setTab] = useState<TabKey>(initialTab);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const decorated = useMemo<Decorated[]>(
    () =>
      rows.map((r) => ({
        r,
        disp: dispositionBucket({ status: r.status, isBillable: r.isBillable, needsReview: r.needsReview }),
      })),
    [rows],
  );

  const totals = useMemo(() => {
    const z = () => ({ count: 0, seconds: 0 });
    const acc: Record<TabKey, { count: number; seconds: number }> = {
      all: z(), auto: z(), suggested: z(), needs_review: z(), unresolved: z(), nonbillable: z(),
    };
    for (const x of decorated) {
      acc.all.count++;
      acc.all.seconds += x.r.durationSeconds;
      acc[x.disp].count++;
      acc[x.disp].seconds += x.r.durationSeconds;
    }
    return acc;
  }, [decorated]);

  const visible = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return decorated.filter((x) => {
      if (tab !== 'all' && x.disp !== tab) return false;
      if (!ql) return true;
      return (
        (x.r.app ?? '').toLowerCase().includes(ql) ||
        (x.r.windowTitle ?? '').toLowerCase().includes(ql) ||
        (x.r.url ?? '').toLowerCase().includes(ql) ||
        (x.r.clientName ?? '').toLowerCase().includes(ql) ||
        (x.r.category ? categoryLabel(x.r.category).toLowerCase().includes(ql) : false)
      );
    });
  }, [decorated, tab, q]);

  const groups = useMemo<Group[]>(() => {
    const m = new Map<string, { label: string; rows: Decorated[] }>();
    for (const x of visible) {
      const reason = reasonOf(x.r);
      const g = m.get(reason.key);
      if (g) g.rows.push(x);
      else m.set(reason.key, { label: reason.label, rows: [x] });
    }
    const out: Group[] = [];
    for (const [key, g] of m) {
      // Cluster same-activity rows; time-ordered input keeps clusters chronological.
      const byKey = new Map<string, Cluster>();
      for (const x of g.rows) {
        const ck = `${x.r.windowTitle ?? x.r.url ?? ''}§${x.r.clientId ?? x.r.category ?? ''}§${x.disp}`;
        const c = byKey.get(ck);
        if (c) {
          c.rows.push(x);
          c.seconds += x.r.durationSeconds;
        } else {
          byKey.set(ck, { key: `${key}§${ck}`, rows: [x], seconds: x.r.durationSeconds });
        }
      }
      out.push({
        key,
        label: g.label,
        // Biggest chunk first within the group (not chronological).
        clusters: [...byKey.values()].sort((a, b) => b.seconds - a.seconds),
        seconds: g.rows.reduce((a, x) => a + x.r.durationSeconds, 0),
        blocks: g.rows.length,
      });
    }
    // Groups: most time at top, least at bottom.
    return out.sort((a, b) => b.seconds - a.seconds);
  }, [visible]);

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  return (
    <>
      <div className="tabs">
        {TABS.map((t) => {
          const meta = totals[t.key];
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              className={`tab${active ? ' active' : ''}`}
              onClick={() => setTab(t.key)}
              style={active ? { borderColor: TAB_COLOR[t.key], color: TAB_COLOR[t.key] } : undefined}
            >
              <i className="dot" style={{ background: TAB_COLOR[t.key] }} />
              {t.label}
              <span className="tab-meta">
                {formatDuration(meta.seconds)} · {meta.count}
              </span>
            </button>
          );
        })}
      </div>

      <input
        className="filter"
        type="text"
        placeholder="Filter by site, app, client, or title (e.g. acme)…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      {groups.length === 0 ? (
        <p className="muted small">No blocks in this view.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Time <span className="muted" style={{ fontWeight: 400 }}>(MT)</span></th>
              <th className="num">Dur</th>
              <th>App</th>
              <th>Window / URL</th>
              <th>Client</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const isOpen = expanded.has(g.key);
              return (
                <Fragment key={g.key}>
                  <tr className="group" onClick={() => toggle(g.key)}>
                    <td colSpan={5}>
                      <span className="caret">{isOpen ? '▾' : '▸'}</span>
                      <span className="group-label">{g.label}</span>
                      <span className="group-meta">
                        {formatDuration(g.seconds)} · {g.blocks} block{g.blocks === 1 ? '' : 's'}
                      </span>
                    </td>
                  </tr>
                  {isOpen && g.clusters.map((c) => <ClusterBlock key={c.key} cluster={c} tz={tz} edit={edit} />)}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

/** One activity line: a lone block renders directly; repeated chunks roll up
 *  into a summary row that expands (capped) to individual blocks on click. */
const ClusterBlock = memo(function ClusterBlock({ cluster, tz, edit }: { cluster: Cluster; tz: string; edit?: EditCtx }) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  if (cluster.rows.length === 1) return <BlockRow r={cluster.rows[0]!.r} tz={tz} edit={edit} />;
  const first = cluster.rows[0]!.r;
  const last = cluster.rows[cluster.rows.length - 1]!.r;
  // Header keeps the full time span (rows are chronological), but the expanded
  // chunks list shows the longest first down to the shortest.
  const ordered = [...cluster.rows].sort((a, b) => b.r.durationSeconds - a.r.durationSeconds);
  const shown = showAll ? ordered : ordered.slice(0, EXPAND_CAP);
  return (
    <>
      <tr className="cluster" onClick={() => setOpen((v) => !v)}>
        <td className="mono small" style={{ whiteSpace: 'nowrap' }}>
          <span className="caret">{open ? '▾' : '▸'}</span>
          {localClock(first.startTs, tz)}–{localClock(last.endTs, tz)}
        </td>
        <td className="num">{formatDuration(cluster.seconds)}</td>
        <td className="small">{first.app ?? <span className="muted">—</span>}</td>
        <td className="title-cell">
          <div className="t">
            {first.windowTitle ?? <span className="muted">(no title)</span>}{' '}
            <span className="muted small">×{cluster.rows.length} blocks</span>
          </div>
          {first.url && <div className="u mono">{first.url}</div>}
        </td>
        <ClientCell r={first} edit={edit} ids={cluster.rows.map((x) => x.r.id)} />
      </tr>
      {open && shown.map((x) => <BlockRow key={x.r.id} r={x.r} tz={tz} sub edit={edit} />)}
      {open && !showAll && cluster.rows.length > EXPAND_CAP && (
        <tr className="sub">
          <td colSpan={5}>
            <button type="button" onClick={() => setShowAll(true)}>
              show all {cluster.rows.length} chunks
            </button>
          </td>
        </tr>
      )}
    </>
  );
});

const BlockRow = memo(function BlockRow({ r, tz, sub, edit }: { r: TimelineRowVM; tz: string; sub?: boolean; edit?: EditCtx }) {
  // Screenshots only surface when one was actually captured (they live on the
  // capture machine, so there's no image to embed here — just the fact of it,
  // whose OCR text already feeds the "why").
  const hasShot = r.screenshotId != null && r.screenshotStatus === 'available';
  return (
    <tr data-id={r.id} className={sub ? 'sub' : undefined}>
      <td className="mono small" style={{ whiteSpace: 'nowrap' }}>
        {localClock(r.startTs, tz)}–{localClock(r.endTs, tz)}
      </td>
      <td className="num">{formatDuration(r.durationSeconds)}</td>
      <td className="small">{r.app ?? <span className="muted">—</span>}</td>
      <td className="title-cell">
        <div className="t">
          {r.windowTitle ?? <span className="muted">(no title)</span>}
          {hasShot && (
            <span title="A screenshot was captured for this block" style={{ marginLeft: 6 }}>
              🖼️
            </span>
          )}
        </div>
        {r.url && <div className="u mono">{r.url}</div>}
        {(r.resolverType || r.evidence) && <Why r={r} />}
      </td>
      <ClientCell r={r} edit={edit} ids={[r.id]} />
    </tr>
  );
});

/** The "why" details. The JSON dump renders only once opened — stringifying it
 *  for every block on every re-render is what made big days feel frozen. */
function Why({ r }: { r: TimelineRowVM }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="evi" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>why</summary>
      {open && (
        <>
          <div className="why-human">{explainEvidence(r)}</div>
          {r.evidence && (
            <details className="why-tech">
              <summary className="muted small">technical detail</summary>
              <pre>{JSON.stringify(r.evidence, null, 2)}</pre>
            </details>
          )}
        </>
      )}
    </details>
  );
}

function ClientCell({ r, edit, ids }: { r: TimelineRowVM; edit?: EditCtx; ids?: string[] }) {
  return (
    <td>
      <span className="badge" style={{ background: statusColor(r.status) }}>
        {statusLabel(r.status)}
      </span>
      {r.clientName ? (
        <>
          <div style={{ marginTop: 4 }}>{r.clientName}</div>
          <div className="muted small">
            {pct(r.confidence)} · {resolverLabel(r.resolverType)}
            {r.isBillable === false ? ' · non-billable' : ''}
          </div>
        </>
      ) : (
        r.category && (
          <div className="muted small" style={{ marginTop: 4 }}>
            {categoryLabel(r.category)}
          </div>
        )
      )}
      {edit && ids && ids.length > 0 && (
        <ClientReassign edit={edit} ids={ids} count={ids.length} url={r.url} title={r.windowTitle} />
      )}
    </td>
  );
}

/** Type-ahead client picker: reassigns this block (or a whole rolled-up cluster)
 *  to a client and, by default, teaches the engine so similar blocks follow.
 *  Shows up-front what "remember" will (or won't) learn from this block. */
function ClientReassign({
  edit,
  ids,
  count,
  url,
  title,
}: {
  edit: EditCtx;
  ids: string[];
  count: number;
  url: string | null;
  title: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<ClientOption | null>(null);
  const [state, formAction] = useFormState(setClientAction, { done: false, count: 0, learned: null });

  const matches = useMemo(() => {
    const ql = q.trim().toLowerCase();
    if (!ql) return [];
    return edit.clients.filter((c) => c.name.toLowerCase().includes(ql)).slice(0, 8);
  }, [q, edit.clients]);

  // What "remember" would learn from THIS block — shown before you save so it's
  // never a surprise (and makes "nothing to remember from a call" explicit).
  const willLearn = useMemo(() => describeLearn(url, title), [url, title]);

  // Confirmation after a successful save (may be brief — the block jumps to the
  // "You set the client yourself" group once it re-resolves).
  if (state.done) {
    return (
      <div className="reassign-done small">
        ✓ Set {state.count} block{state.count === 1 ? '' : 's'}
        {state.learned ? <> · learned {state.learned}</> : <> · nothing to remember from this</>}
      </div>
    );
  }

  if (!open) {
    return (
      <button type="button" className="reassign-open" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
        set client
      </button>
    );
  }
  return (
    <form action={formAction} className="reassign" onClick={(e) => e.stopPropagation()}>
      <input type="hidden" name="intervalId" value={ids.join(',')} />
      <input type="hidden" name="date" value={edit.date} />
      {edit.host && <input type="hidden" name="host" value={edit.host} />}
      <input type="hidden" name="clientId" value={sel?.id ?? ''} />
      <div className="reassign-box">
        <input
          autoFocus
          className="reassign-input"
          placeholder="type a client…"
          value={sel ? sel.name : q}
          onChange={(e) => {
            setSel(null);
            setQ(e.target.value);
          }}
        />
        {!sel && matches.length > 0 && (
          <ul className="reassign-ac">
            {matches.map((c) => (
              <li key={c.id} onMouseDown={() => { setSel(c); setQ(c.name); }}>
                {c.name}
              </li>
            ))}
          </ul>
        )}
      </div>
      <label className="reassign-learn small">
        <input type="checkbox" name="learn" defaultChecked /> remember
      </label>
      <div className="reassign-note small muted">
        {willLearn ? <>→ remembers {willLearn}</> : <>→ nothing to remember from this — just {count > 1 ? 'these blocks' : 'this block'}</>}
      </div>
      {state.error && <div className="reassign-note small" style={{ color: '#c0392b' }}>{state.error}</div>}
      <div className="reassign-actions">
        <button type="submit" className="primary small" disabled={!sel}>
          save{count > 1 ? ` (${count})` : ''}
        </button>
        <button type="button" className="small" onClick={() => { setOpen(false); setSel(null); setQ(''); }}>
          cancel
        </button>
      </div>
    </form>
  );
}
