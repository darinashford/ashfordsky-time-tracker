import type { ReactNode } from 'react';
import Link from 'next/link';
import { localDate, secondsToHours } from '@tt/shared';
import {
  getHosts,
  getRangeActiveSeconds,
  getRangeClientSummary,
  getActiveSecondsByDay,
  getRangeStripBins,
  type StripBin,
} from '@tt/db';
import { getDb } from '../../../../lib/db';
import { getViewerScope } from '../../../../lib/viewer';
import { DayStripBinned, DayStripLegend, WorkdayColumns } from '../../../../components/DayStrip';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FIRST_DATA_YEAR = 2026; // tracking started June 2026

/** Month bubbles for one year (future months muted) with a ‹ year › switcher.
 *  Clicking a month keeps the current period (month view, or week view where it
 *  then lists that month's weeks). */
function MonthBubbles({
  period,
  anchorYear,
  anchorMonth,
  nowYear,
  nowMonth,
  q,
}: {
  period: Period;
  anchorYear: number;
  anchorMonth: number;
  nowYear: number;
  nowMonth: number;
  q: string;
}) {
  const monthHref = (y: number, i: number) => `/range/${period}/${y}-${String(i + 1).padStart(2, '0')}-01${q}`;
  const prevOk = anchorYear > FIRST_DATA_YEAR;
  const nextOk = anchorYear < nowYear;
  return (
    <div className="bubbles">
      {MONTHS.map((m, i) => {
        const future = anchorYear > nowYear || (anchorYear === nowYear && i > nowMonth);
        const cls = `bubble${i === anchorMonth ? ' active' : ''}${future ? ' off' : ''}`;
        return (
          <Link key={m} className={cls} href={monthHref(anchorYear, i)}>
            {m}
          </Link>
        );
      })}
      <span className="bubbles" style={{ margin: 0, marginLeft: 6, gap: 2, alignItems: 'center' }}>
        <Link className={`bubble${prevOk ? '' : ' off'}`} href={monthHref(anchorYear - 1, anchorMonth)} title="Previous year">
          ‹
        </Link>
        <span className="muted small" style={{ padding: '0 4px' }}>{anchorYear}</span>
        <Link className={`bubble${nextOk ? '' : ' off'}`} href={monthHref(anchorYear + 1, Math.min(anchorMonth, nowMonth))} title="Next year">
          ›
        </Link>
      </span>
    </div>
  );
}

/** Calendar-style pickers. Week: pick a month, then one of its week ranges.
 *  Month: month bubbles + year switcher. Year: year bubbles. */
function PeriodPicker({ period, anchor, today, q }: { period: Period; anchor: string; today: string; q: string }) {
  const a = parse(anchor);
  const anchorYear = a.getUTCFullYear();
  const anchorMonth = a.getUTCMonth();
  const nowYear = parse(today).getUTCFullYear();
  const nowMonth = parse(today).getUTCMonth();

  if (period === 'year') {
    const years: number[] = [];
    for (let y = FIRST_DATA_YEAR; y <= nowYear; y++) years.push(y);
    return (
      <div className="bubbles">
        {years.map((y) => (
          <Link key={y} className={`bubble${y === anchorYear ? ' active' : ''}`} href={`/range/year/${y}-01-01${q}`}>
            {y}
          </Link>
        ))}
      </div>
    );
  }

  const months = (
    <MonthBubbles
      period={period}
      anchorYear={anchorYear}
      anchorMonth={anchorMonth}
      nowYear={nowYear}
      nowMonth={nowMonth}
      q={q}
    />
  );
  if (period === 'month') return months;

  // Day view: pick a month, then a day-of-month bubble (future days muted).
  if (period === 'day') {
    const daysInMonth = new Date(Date.UTC(anchorYear, anchorMonth + 1, 0)).getUTCDate();
    const anchorDay = a.getUTCDate();
    const t = parse(today);
    return (
      <>
        {months}
        <div className="bubbles">
          {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((d) => {
            const dd = new Date(Date.UTC(anchorYear, anchorMonth, d));
            return (
              <Link
                key={d}
                className={`bubble${d === anchorDay ? ' active' : ''}${dd > t ? ' off' : ''}`}
                href={`/range/day/${ymd(dd)}${q}`}
              >
                {d}
              </Link>
            );
          })}
        </div>
      </>
    );
  }

  // Week view: the anchor month's Monday-start weeks as ranges, current one lit.
  const monthStart = new Date(Date.UTC(anchorYear, anchorMonth, 1));
  const monthEnd = new Date(Date.UTC(anchorYear, anchorMonth + 1, 0));
  const weeks: { start: Date; end: Date }[] = [];
  let ws = addDays(monthStart, -((monthStart.getUTCDay() + 6) % 7));
  while (ws <= monthEnd) {
    weeks.push({ start: ws, end: addDays(ws, 6) });
    ws = addDays(ws, 7);
  }
  const todayD = parse(today);
  return (
    <>
      {months}
      <div className="bubbles">
        {weeks.map((w) => {
          const active = a >= w.start && a <= w.end;
          const future = w.start > todayD;
          return (
            <Link
              key={ymd(w.start)}
              className={`bubble${active ? ' active' : ''}${future ? ' off' : ''}`}
              href={`/range/week/${ymd(w.start)}${q}`}
            >
              {fmt(w.start, { month: 'short', day: 'numeric' })} – {fmt(w.end, { month: 'short', day: 'numeric' })}
            </Link>
          );
        })}
      </div>
    </>
  );
}

const PERIODS = ['day', 'week', 'month', 'year'] as const;
type Period = (typeof PERIODS)[number];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Billable / pending / non-billable / unattributed — match the day view's palette.
const C = { billable: '#1f8a4c', pending: '#b8860b', nonbillable: '#566573', unattributed: '#7f8c8d' };

// Calendar-only date math (UTC, so it never drifts by timezone).
const parse = (d: string): Date => new Date(`${d}T00:00:00Z`);
const ymd = (d: Date): string => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number): Date => {
  const x = new Date(d);
  x.setUTCDate(d.getUTCDate() + n);
  return x;
};
const fmt = (d: Date, opts: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).format(d);

function rangeFor(period: Period, anchor: string): { start: string; end: string; label: string } {
  const d = parse(anchor);
  const y = d.getUTCFullYear();
  if (period === 'day') {
    return { start: anchor, end: anchor, label: fmt(d, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) };
  }
  if (period === 'week') {
    const start = addDays(d, -((d.getUTCDay() + 6) % 7)); // Monday
    const end = addDays(start, 6);
    return {
      start: ymd(start),
      end: ymd(end),
      label: `${fmt(start, { month: 'short', day: 'numeric' })} – ${fmt(end, { month: 'short', day: 'numeric', year: 'numeric' })}`,
    };
  }
  if (period === 'month') {
    const start = new Date(Date.UTC(y, d.getUTCMonth(), 1));
    const end = new Date(Date.UTC(y, d.getUTCMonth() + 1, 0));
    return { start: ymd(start), end: ymd(end), label: fmt(start, { month: 'long', year: 'numeric' }) };
  }
  return { start: ymd(new Date(Date.UTC(y, 0, 1))), end: ymd(new Date(Date.UTC(y, 11, 31))), label: `${y}` };
}

const hrs = (sec: number): string => `${secondsToHours(sec).toFixed(2)}h`;
const cap = (s: string): string => s[0]!.toUpperCase() + s.slice(1);

export default async function RangePage({
  params,
  searchParams,
}: {
  params: { period: string; date: string };
  searchParams: { host?: string };
}) {
  const { pool, schema, cfg } = getDb();
  const period: Period = (PERIODS as readonly string[]).includes(params.period) ? (params.period as Period) : 'week';
  const today = localDate(new Date().toISOString(), cfg.timezone);
  const anchor = DATE_RE.test(params.date) ? params.date : today;
  const range = rangeFor(period, anchor);
  const prev = ymd(addDays(parse(range.start), -1));
  const next = ymd(addDays(parse(range.end), 1));
  // Defaults to the signed-in person (like Today); 'all' is the explicit Everyone
  // view. Anyone may switch to Everyone or another person — Reporting is shared.
  const scope = await getViewerScope();
  const rawHost = typeof searchParams.host === 'string' && searchParams.host ? searchParams.host : undefined;
  const isEveryone = rawHost === 'all';
  const fHost = isEveryone ? undefined : (rawHost ?? scope.selfHost ?? undefined);
  const q = rawHost ? `?host=${encodeURIComponent(rawHost)}` : ''; // preserve selection across nav

  // Person switcher data — shown to everyone here; fetched outside the body so it
  // can render at the very top even if the summary query fails.
  let hosts: string[] = [];
  try {
    hosts = await getHosts(pool, schema);
  } catch {
    hosts = [];
  }

  let body: ReactNode;
  try {
    // The workday strip is per-day; year would be 365 columns, so skip it there.
    const wantStrip = period !== 'year';
    const [rows, activeSeconds, stripBins, workedByDay] = await Promise.all([
      getRangeClientSummary(pool, schema, range.start, range.end, fHost),
      getRangeActiveSeconds(pool, schema, range.start, range.end, fHost),
      wantStrip
        ? getRangeStripBins(pool, schema, range.start, range.end, cfg.timezone, fHost)
        : Promise.resolve([] as StripBin[]),
      wantStrip
        ? getActiveSecondsByDay(pool, schema, range.start, range.end, fHost)
        : Promise.resolve(new Map<string, number>()),
    ]);
    // Worked = all active (non-away) time. Idle / away / locked is excluded upstream.
    const worked = activeSeconds;
    const nullRow = rows.find((r) => !r.clientId);
    const clients = rows.filter((r) => r.clientId).sort((a, b) => b.totalSeconds - a.totalSeconds);

    // Any time on a client is billable (confidence is a review signal, not a
    // billing gate) — so billable == client total; there is no separate pending.
    const billable = clients.reduce((a, r) => a + r.billableSeconds, 0);
    const clientTotal = clients.reduce((a, r) => a + r.totalSeconds, 0);
    const nonbillable = nullRow?.nonbillableSeconds ?? 0;
    const unattributed = Math.max(0, (nullRow?.totalSeconds ?? 0) - nonbillable);
    const grand = clientTotal + (nullRow?.totalSeconds ?? 0);
    const maxTotal = clients[0]?.totalSeconds ?? 1;
    const w = (sec: number, denom: number) => `${denom ? (sec / denom) * 100 : 0}%`;

    // Workday strip(s): one horizontal bar for a single day, or one vertical bar
    // per day (time top→bottom) across a week/month. All from server-aggregated
    // 5-min bins — no raw interval rows leave the database for this.
    const binsByDay = new Map<string, StripBin[]>();
    for (const b of stripBins) {
      const arr = binsByDay.get(b.day);
      if (arr) arr.push(b);
      else binsByDay.set(b.day, [b]);
    }
    const dayList: string[] = [];
    for (let d = parse(range.start); ymd(d) <= range.end; d = addDays(d, 1)) dayList.push(ymd(d));
    const stripCols = dayList.map((day) => {
      const dt = parse(day);
      const bins = binsByDay.get(day) ?? [];
      const workedSeconds = workedByDay.get(day) ?? 0;
      return period === 'month'
        ? { day, bins, workedSeconds, label: fmt(dt, { day: 'numeric' }), sublabel: fmt(dt, { weekday: 'narrow' }) }
        : { day, bins, workedSeconds, label: fmt(dt, { weekday: 'short' }), sublabel: fmt(dt, { month: 'numeric', day: 'numeric' }) };
    });
    const workday = wantStrip ? (
      <>
        <h2 style={{ marginTop: 8 }}>Workday</h2>
        {period === 'day' ? (
          <DayStripBinned bins={binsByDay.get(range.start) ?? []} />
        ) : (
          <WorkdayColumns days={stripCols} colWidth={period === 'month' ? 20 : 46} />
        )}
        <DayStripLegend />
      </>
    ) : null;

    body = (
      <>
        {workday}
        <div className="cards">
          <div className="card">
            <div className="k">Worked</div>
            <div className="v">{hrs(worked)}</div>
          </div>
          <div className="card">
            <div className="k">Billable</div>
            <div className="v" style={{ color: C.billable }}>{hrs(billable)}</div>
          </div>
          <div className="card">
            <div className="k">Non-billable</div>
            <div className="v" style={{ color: C.nonbillable }}>{hrs(nonbillable)}</div>
          </div>
        </div>

        <h2>Billable vs non-billable</h2>
        <div className="bar" style={{ height: 26, borderRadius: 6 }}>
          <span style={{ width: w(billable, grand), background: C.billable }} title={`Billable ${hrs(billable)}`} />
          <span style={{ width: w(nonbillable, grand), background: C.nonbillable }} title={`Non-billable ${hrs(nonbillable)}`} />
          <span style={{ width: w(unattributed, grand), background: C.unattributed }} title={`Unattributed ${hrs(unattributed)}`} />
        </div>
        <div className="legend">
          <span><i style={{ background: C.billable }} />Billable {hrs(billable)}</span>
          <span><i style={{ background: C.nonbillable }} />Non-billable {hrs(nonbillable)}</span>
          <span><i style={{ background: C.unattributed }} />Unattributed {hrs(unattributed)}</span>
        </div>

        <h2>Hours by client</h2>
        {clients.length === 0 ? (
          <p className="muted small">No client time in this period.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th>Share of period</th>
                <th className="num">Billable</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((r) => (
                <tr key={r.clientId}>
                  <td>
                    <div>{r.clientName ?? r.clientId}</div>
                    <div className="muted small">{r.intervalCount} blocks</div>
                  </td>
                  <td style={{ width: '46%' }}>
                    <div className="bar" style={{ height: 12 }} title={`${hrs(r.totalSeconds)} of ${hrs(maxTotal)} (top client)`}>
                      <span style={{ width: w(r.totalSeconds, maxTotal), background: C.billable }} />
                    </div>
                  </td>
                  <td className="num" style={{ color: C.billable }}>{hrs(r.billableSeconds)}</td>
                  <td className="num">{hrs(r.totalSeconds)}</td>
                </tr>
              ))}
              <tr>
                <td><span className="badge" style={{ background: C.nonbillable }}>non-billable</span></td>
                <td>
                  <div className="bar" style={{ height: 12 }}>
                    <span style={{ width: w(nonbillable, maxTotal), background: C.nonbillable }} />
                  </div>
                </td>
                <td className="num muted">—</td>
                <td className="num">{hrs(nonbillable)}</td>
              </tr>
              {unattributed > 1 && (
                <tr>
                  <td><span className="badge" style={{ background: C.unattributed }}>unattributed</span></td>
                  <td>
                    <div className="bar" style={{ height: 12 }}>
                      <span style={{ width: w(unattributed, maxTotal), background: C.unattributed }} />
                    </div>
                  </td>
                  <td className="num muted">—</td>
                  <td className="num">{hrs(unattributed)}</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        <p className="muted small" style={{ marginTop: 10 }}>
          {range.start} → {range.end}. Any time attributed to a client counts as billable. Times in MT.
        </p>
      </>
    );
  } catch (err) {
    body = (
      <div className="card" style={{ marginTop: 20 }}>
        <p><strong>Could not load the summary.</strong></p>
        <pre className="small">{err instanceof Error ? err.message : String(err)}</pre>
      </div>
    );
  }

  return (
    <>
      <div className="topbar">
        <h1>Reporting</h1>
        <div className="datenav">
          <Link className="btn" href={`/range/${period}/${prev}${q}`}>◀</Link>
          <span className="date">{range.label}</span>
          <Link className="btn" href={`/range/${period}/${next}${q}`}>▶</Link>
          <Link className="btn" href={`/range/${period}/${today}${q}`}>this {period}</Link>
          <Link className="btn" href={`/day/${anchor}${q}`}>day view</Link>
        </div>
      </div>
      {hosts.length > 0 && (
        <div className="tabs" style={{ marginTop: 12 }}>
          <span className="muted small" style={{ alignSelf: 'center', marginRight: 2 }}>Whose time:</span>
          {hosts.map((h) => (
            <Link
              key={h}
              className={`tab${!isEveryone && fHost === h ? ' active' : ''}`}
              href={`/range/${period}/${anchor}?host=${encodeURIComponent(h)}`}
            >
              {h}{h === scope.selfHost ? ' (you)' : ''}
            </Link>
          ))}
          <Link className={`tab${isEveryone ? ' active' : ''}`} href={`/range/${period}/${anchor}?host=all`}>
            Everyone
          </Link>
        </div>
      )}
      <div className="tabs" style={{ marginTop: hosts.length > 0 ? 6 : 12 }}>
        {PERIODS.map((p) => (
          <Link key={p} className={`tab${p === period ? ' active' : ''}`} href={`/range/${p}/${anchor}${q}`}>
            {cap(p)}
          </Link>
        ))}
      </div>
      <PeriodPicker period={period} anchor={anchor} today={today} q={q} />
      {body}
    </>
  );
}
