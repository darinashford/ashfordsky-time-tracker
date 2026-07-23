import { secondsToHours } from '@tt/shared';
import { WorkdayColumnsView, type PreparedDay, type PreparedTick } from './WorkdayColumnsView';

/**
 * "When did they work" strips, color-coded —
 *   green  = billable client time (any client-attributed block, incl. Uncertain)
 *   slate  = non-billable + unattributed worked time
 *   track  = translucent gray: not worked (idle past the grace, away, locked, off)
 * The day runs 6:00 AM → 1:00 AM (MT), bucketed into 5-minute bins; each bin
 * takes its dominant category so the strip reads as clean runs, not slivers.
 * Idle is not a category: the resolver promotes real work out of AFK, so any
 * time still flagged AFK isn't worked and simply reads as a gap.
 *
 * `DayStrip` is the horizontal single-day bar (Today). `WorkdayColumns` is the
 * multi-day version for Reporting: one vertical bar per day, time top→bottom.
 */

const DAY_START_MIN = 6 * 60; // 6:00 AM local
const DAY_END_MIN = 25 * 60; // 1:00 AM next day
const BIN_MIN = 5;
const N_BINS = (DAY_END_MIN - DAY_START_MIN) / BIN_MIN;

type Cat = 'billable' | 'nonbillable';

const COLOR: Record<Cat, string> = {
  billable: '#1f8a4c',
  nonbillable: '#566573',
};
const LABEL: Record<Cat, string> = {
  billable: 'Billable',
  nonbillable: 'Non-billable / unattributed',
};

// Any client-attributed block is billable, including low-confidence (needs_review)
// ones — confidence is a review signal, not a billing gate. Matches the
// daily_client_summary.billable_seconds rule.
const BILLABLE_STATUSES = new Set(['auto_finalized', 'confirmed', 'suggested', 'needs_review']);

/** The fields the rows-based strip logic needs — the Today page's TimelineRow satisfies it. */
export interface StripInput {
  id: string;
  startTs: string;
  endTs: string;
  durationSeconds: number;
  app: string | null;
  isAfk: boolean;
  clientId: string | null;
  isBillable: boolean | null;
  status: string | null;
}

interface Segment {
  cat: Cat;
  from: number; // bin index (inclusive)
  to: number; // bin index (exclusive)
}

/** Minutes since local midnight of `day` for an ISO timestamp, in `tz`. */
function minutesIntoDay(iso: string, day: string, tz: string): number {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const ymd = `${get('year')}-${get('month')}-${get('day')}`;
  const hh = get('hour') === '24' ? 0 : Number(get('hour'));
  const mins = hh * 60 + Number(get('minute'));
  if (ymd === day) return mins;
  return ymd > day ? mins + 1440 : mins - 1440; // spillover past midnight / before
}

function fmtMin(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  const h24 = Math.floor(m / 60);
  const mm = m % 60;
  const ap = h24 < 12 ? 'a' : 'p';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return mm === 0 ? `${h12}${ap}` : `${h12}:${String(mm).padStart(2, '0')}${ap}`;
}

/** Bucket one day's rows into 5-min bins, pick each bin's dominant category, and
 *  merge adjacent same-category bins into segments (billable wins ties). Only
 *  worked (non-AFK) time fills the bar; idle/away/locked is left as a gap. */
export function daySegments(rows: StripInput[], day: string, tz: string): Segment[] {
  const bins: Array<Record<Cat, number>> = Array.from({ length: N_BINS }, () => ({
    billable: 0,
    nonbillable: 0,
  }));
  for (const r of rows) {
    if (r.isAfk) continue; // idle / away / locked -> gap; only worked time fills the bar
    const cat: Cat =
      r.clientId && r.isBillable !== false && BILLABLE_STATUSES.has(r.status ?? '')
        ? 'billable'
        : 'nonbillable'; // unresolved / no-client, or non-billable buckets
    const s = minutesIntoDay(r.startTs, day, tz);
    const e = s + r.durationSeconds / 60;
    const from = Math.max(s, DAY_START_MIN);
    const to = Math.min(e, DAY_END_MIN);
    if (to <= from) continue;
    const b0 = Math.floor((from - DAY_START_MIN) / BIN_MIN);
    const b1 = Math.min(N_BINS - 1, Math.floor((to - DAY_START_MIN - 0.001) / BIN_MIN));
    for (let b = b0; b <= b1; b++) {
      const binStart = DAY_START_MIN + b * BIN_MIN;
      const overlap = Math.min(to, binStart + BIN_MIN) - Math.max(from, binStart);
      if (overlap > 0) bins[b]![cat] += overlap * 60;
    }
  }

  return mergeBinTotals(bins);
}

/** Server-aggregated strip bins (see @tt/db getRangeStripBins) — worked seconds
 *  per 5-min display bin, already split billable/non-billable and localized. */
export interface BinnedInput {
  bin: number; // 0..N_BINS-1
  billableSeconds: number;
  nonbillableSeconds: number;
}

/** Same dominance + merge rules as daySegments, but from pre-aggregated bins —
 *  so Reporting never ships raw interval rows to render the strips. */
export function segmentsFromBins(binRows: BinnedInput[]): Segment[] {
  const bins: Array<Record<Cat, number>> = Array.from({ length: N_BINS }, () => ({
    billable: 0,
    nonbillable: 0,
  }));
  for (const b of binRows) {
    if (b.bin < 0 || b.bin >= N_BINS) continue;
    bins[b.bin]!.billable += b.billableSeconds;
    bins[b.bin]!.nonbillable += b.nonbillableSeconds;
  }
  return mergeBinTotals(bins);
}

/** Dominant category per 5-min bin (billable wins ties; <30s = gap), merged
 *  into contiguous same-category segments. */
function mergeBinTotals(bins: Array<Record<Cat, number>>): Segment[] {
  const PRIORITY: Cat[] = ['billable', 'nonbillable'];
  const binCat: Array<Cat | null> = bins.map((b) => {
    const total = b.billable + b.nonbillable;
    if (total < 30) return null; // effectively empty -> gap
    let best: Cat = 'billable';
    let bestV = -1;
    for (const c of PRIORITY) {
      if (b[c] > bestV) {
        bestV = b[c];
        best = c;
      }
    }
    return best;
  });
  const segments: Segment[] = [];
  for (let b = 0; b < N_BINS; b++) {
    const c = binCat[b];
    if (!c) continue;
    const last = segments[segments.length - 1];
    if (last && last.cat === c && last.to === b) last.to = b + 1;
    else segments.push({ cat: c, from: b, to: b + 1 });
  }
  return segments;
}

const binToMin = (bin: number) => DAY_START_MIN + bin * BIN_MIN;
const pctOfDay = (bin: number) => (bin / N_BINS) * 100;

export function DayStrip({
  rows,
  day,
  tz,
  label,
}: {
  rows: StripInput[];
  day: string;
  tz: string;
  label?: string;
}) {
  return <HorizontalStrip segments={daySegments(rows, day, tz)} label={label} />;
}

/** Same horizontal strip, from server-aggregated bins (Reporting's day view). */
export function DayStripBinned({ bins, label }: { bins: BinnedInput[]; label?: string }) {
  return <HorizontalStrip segments={segmentsFromBins(bins)} label={label} />;
}

function HorizontalStrip({ segments, label }: { segments: Segment[]; label?: string }) {
  const ticks: number[] = [];
  for (let m = DAY_START_MIN; m <= DAY_END_MIN; m += 60) ticks.push(m); // every hour

  return (
    <div style={{ margin: '4px 0 2px' }}>
      {label && <div className="small muted" style={{ marginBottom: 2 }}>{label}</div>}
      <div
        style={{
          position: 'relative',
          height: 22,
          borderRadius: 6,
          background: 'rgba(150,158,168,0.18)', // "off" track: light translucent gray
          overflow: 'hidden',
        }}
      >
        {segments.map((s, i) => (
          <span
            key={i}
            title={`${fmtMin(binToMin(s.from))}–${fmtMin(binToMin(s.to))} · ${LABEL[s.cat]}`}
            style={{
              position: 'absolute',
              left: `${pctOfDay(s.from)}%`,
              width: `${pctOfDay(s.to - s.from)}%`,
              top: 0,
              bottom: 0,
              background: COLOR[s.cat],
            }}
          />
        ))}
      </div>
      <div style={{ position: 'relative', height: 14 }}>
        {ticks.map((m) => (
          <span
            key={m}
            className="muted"
            style={{
              position: 'absolute',
              left: `${((m - DAY_START_MIN) / (DAY_END_MIN - DAY_START_MIN)) * 100}%`,
              transform: 'translateX(-50%)',
              fontSize: 10,
            }}
          >
            {fmtMin(m)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Multi-day "when did they work" view: one vertical bar per day. Used on
 *  Reporting for week/month. Heavy per-day work (binning) happens here on the
 *  server; the interactive shell (click-to-show worked-hours popup) is the small
 *  client component WorkdayColumnsView. Time axis (6a→1a) runs down the left. */
export function WorkdayColumns({
  days,
  height = 240,
  colWidth = 26,
}: {
  days: Array<{ day: string; bins: BinnedInput[]; workedSeconds: number; label: string; sublabel?: string }>;
  height?: number;
  colWidth?: number;
}) {
  const span = DAY_END_MIN - DAY_START_MIN;
  const ticks: PreparedTick[] = [];
  for (let m = DAY_START_MIN; m <= DAY_END_MIN; m += 120) {
    ticks.push({ label: fmtMin(m), topPct: ((m - DAY_START_MIN) / span) * 100 }); // every 2h
  }
  const prepared: PreparedDay[] = days.map((d) => {
    const segments = segmentsFromBins(d.bins);
    return {
      key: d.day,
      label: d.label,
      sublabel: d.sublabel,
      // Worked total from coverage_report — ties to the "Worked" card exactly.
      workedLabel: `${secondsToHours(d.workedSeconds).toFixed(2)}h`,
      segments: segments.map((s) => ({
        topPct: pctOfDay(s.from),
        heightPct: pctOfDay(s.to - s.from),
        color: COLOR[s.cat],
      })),
    };
  });
  return (
    <WorkdayColumnsView days={prepared} ticks={ticks} height={height} colWidth={colWidth} colGap={4} axisWidth={30} />
  );
}

/** Shared legend for one or more strips. */
export function DayStripLegend() {
  return (
    <div className="legend" style={{ marginTop: 2 }}>
      <span><i style={{ background: COLOR.billable }} />Billable</span>
      <span><i style={{ background: COLOR.nonbillable }} />Non-billable / unattributed</span>
      <span><i style={{ background: 'rgba(150,158,168,0.35)' }} />Not worked / away</span>
    </div>
  );
}
