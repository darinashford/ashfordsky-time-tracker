import { secondsToHours } from '@tt/shared';
import { DayStripView, type PreparedStripSegment, type PreparedStripTick } from './DayStripView';
import { WorkdayColumnsView, type PreparedDay, type PreparedTick } from './WorkdayColumnsView';

/**
 * "When did they work" strips, color-coded —
 *   green  = billable client time (any client-attributed block, incl. Uncertain)
 *   slate  = non-billable + unattributed worked time
 *   track  = translucent gray: Away / off (any no-input stretch past the
 *            15-min grace, locked, or simply not there)
 * There are exactly TWO worked states — billable and non-billable; idle is not
 * a status. The day runs 5:00 AM → 1:00 AM (MT) in 5-minute bins; each bin
 * takes its dominant category so the strip reads as clean runs, not slivers.
 * Worked = sensor-active OR grace-promoted (afk_promoted — migration 0015).
 * Clicking any stretch — worked OR away — shows a bubble with its duration.
 *
 * `DayStrip` (via buildDayModel) is the horizontal single-day bar (Today).
 * `WorkdayColumns` is the multi-day Reporting version: one vertical bar per day.
 */

const DAY_START_MIN = 5 * 60; // 5:00 AM local
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
  afkPromoted?: boolean | null;
  clientId: string | null;
  isBillable: boolean | null;
  status: string | null;
}

interface Segment {
  cat: Cat;
  from: number; // bin index (inclusive)
  to: number; // bin index (exclusive)
  seconds: number; // real seconds of this category inside the segment
}

/** A prepared day model for the Today strip. */
export interface DayModel {
  segments: Segment[];
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

function fmtDur(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ''}`.trim();
}

/**
 * Classify one day's rows and bin them. Worked (not AFK, or AFK but
 * grace-promoted) → billable / nonbillable. Everything else — idle past the
 * grace, locked, gone — is Away/off: unpainted track, clickable via a ghost
 * segment so its duration is one click away.
 */
export function buildDayModel(rows: StripInput[], day: string, tz: string): DayModel {
  const bins: Array<Record<Cat, number>> = Array.from({ length: N_BINS }, () => ({
    billable: 0,
    nonbillable: 0,
  }));
  for (const r of rows) {
    const worked = !r.isAfk || !!r.afkPromoted;
    if (!worked) continue; // Away / off -> track
    const cat: Cat =
      r.clientId && r.isBillable !== false && BILLABLE_STATUSES.has(r.status ?? '')
        ? 'billable'
        : 'nonbillable';
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

  return { segments: mergeBinTotals(bins) };
}

/** Server-aggregated strip bins (see @tt/db getRangeStripBins) — worked seconds
 *  per 5-min display bin, already split billable/non-billable and localized. */
export interface BinnedInput {
  bin: number; // 0..N_BINS-1
  billableSeconds: number;
  nonbillableSeconds: number;
}

/** Same dominance + merge rules, from pre-aggregated bins — so Reporting never
 *  ships raw interval rows to render the strips. (No idle channel here: the
 *  Reporting columns show worked time only.) */
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

/** Dominant category per 5-min bin, merged into contiguous same-category
 *  segments carrying their REAL seconds (for the click bubble). A bin paints
 *  only when it is MAJORITY covered (≥150s of its 300s): each painted bin then
 *  stands for ~5 real minutes and the bar's total length tracks the cards. */
function mergeBinTotals(bins: Array<Record<Cat, number>>): Segment[] {
  const PRIORITY: Cat[] = ['billable', 'nonbillable'];
  const binCat: Array<Cat | null> = bins.map((b) => {
    const total = b.billable + b.nonbillable;
    if (total < 150) return null; // minority-covered bin -> gap
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
  // INVARIANT: no visible Away sliver shorter than the 15-min grace. A short
  // unpainted run BETWEEN painted bins can only be bin-rounding or a knife-edge
  // idle run (e.g. 14.9 min chained just under the grace) — under the policy
  // "gone < 15 min = still working" it must read as continuation, so absorb it
  // into the preceding category. Real absences are >= 3 bins and stay gray.
  for (let b = 0; b < N_BINS; b++) {
    if (binCat[b] != null) continue;
    let e = b;
    while (e < N_BINS && binCat[e] == null) e++;
    const prev = b > 0 ? binCat[b - 1] : null;
    const next = e < N_BINS ? binCat[e] : null;
    if (prev && next && e - b < 3) {
      for (let i = b; i < e; i++) binCat[i] = prev;
    }
    b = e;
  }
  const segments: Segment[] = [];
  for (let b = 0; b < N_BINS; b++) {
    const c = binCat[b];
    if (!c) continue;
    const secs = bins[b]![c];
    const last = segments[segments.length - 1];
    if (last && last.cat === c && last.to === b) {
      last.to = b + 1;
      last.seconds += secs;
    } else {
      segments.push({ cat: c, from: b, to: b + 1, seconds: secs });
    }
  }
  return segments;
}

const binToMin = (bin: number) => DAY_START_MIN + bin * BIN_MIN;
const pctOfDay = (bin: number) => (bin / N_BINS) * 100;

function prepareSegments(segments: Segment[]): PreparedStripSegment[] {
  const out: PreparedStripSegment[] = [];
  const pushAway = (from: number, to: number) => {
    if (to <= from) return;
    out.push({
      leftPct: pctOfDay(from),
      widthPct: pctOfDay(to - from),
      color: 'transparent', // the gray track IS the color; this is the click target
      ghost: true,
      durLabel: fmtDur((to - from) * BIN_MIN * 60),
      catLabel: 'Away / off',
      rangeLabel: `${fmtMin(binToMin(from))}–${fmtMin(binToMin(to))}`,
    });
  };
  // Away ghosts only BETWEEN painted work — the empty early morning and the
  // night after the last block aren't "away stretches" worth a bubble.
  let cursor: number | null = null;
  for (const s of segments) {
    if (cursor != null) pushAway(cursor, s.from);
    out.push({
      leftPct: pctOfDay(s.from),
      widthPct: pctOfDay(s.to - s.from),
      color: COLOR[s.cat],
      durLabel: fmtDur(s.seconds),
      catLabel: LABEL[s.cat],
      rangeLabel: `${fmtMin(binToMin(s.from))}–${fmtMin(binToMin(s.to))}`,
    });
    cursor = s.to;
  }
  return out;
}

function prepareTicks(stepMin: number): PreparedStripTick[] {
  const ticks: PreparedStripTick[] = [];
  for (let m = DAY_START_MIN; m <= DAY_END_MIN; m += stepMin) {
    ticks.push({ label: fmtMin(m), leftPct: ((m - DAY_START_MIN) / (DAY_END_MIN - DAY_START_MIN)) * 100 });
  }
  return ticks;
}

/** Horizontal Today strip from a prepared day model (click a block → bubble). */
export function DayStrip({ model, label }: { model: DayModel; label?: string }) {
  return <DayStripView segments={prepareSegments(model.segments)} ticks={prepareTicks(60)} label={label} />;
}

/** Same horizontal strip, from server-aggregated bins (Reporting's day view). */
export function DayStripBinned({ bins, label }: { bins: BinnedInput[]; label?: string }) {
  return <DayStripView segments={prepareSegments(segmentsFromBins(bins))} ticks={prepareTicks(60)} label={label} />;
}

/** Multi-day "when did they work" view: one vertical bar per day. Used on
 *  Reporting for week/month. Heavy per-day work (binning) happens here on the
 *  server; the interactive shell (click-to-show worked-hours popup) is the small
 *  client component WorkdayColumnsView. Time axis (5a→1a) runs down the left. */
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

/** Shared legend for the strips. */
export function DayStripLegend() {
  return (
    <div className="legend" style={{ marginTop: 2 }}>
      <span><i style={{ background: COLOR.billable }} />Billable</span>
      <span><i style={{ background: COLOR.nonbillable }} />Non-billable / unattributed</span>
      <span><i style={{ background: 'rgba(150,158,168,0.35)' }} />Away / off</span>
    </div>
  );
}
