import { secondsToHours } from '@tt/shared';
import { DayStripView, type PreparedStripSegment, type PreparedStripTick } from './DayStripView';
import { WorkdayColumnsView, type PreparedDay, type PreparedTick } from './WorkdayColumnsView';

/**
 * "When did they work" strips, color-coded —
 *   green  = billable client time (any client-attributed block, incl. Uncertain)
 *   slate  = non-billable + unattributed worked time
 *   blue   = idle at the desk (a no-input stretch past the 15-min grace but
 *            under the away cutoff — at the machine, not counted as worked)
 *   track  = translucent gray: away (long idle, locked, off)
 * The day runs 5:00 AM → 1:00 AM (MT) in 5-minute bins; each bin takes its
 * dominant category so the strip reads as clean runs, not slivers. Worked =
 * sensor-active OR grace-promoted (afk_promoted — see migration 0015). Clicking
 * a segment shows a bubble with its duration.
 *
 * `DayStrip` (via buildDayModel) is the horizontal single-day bar (Today).
 * `WorkdayColumns` is the multi-day Reporting version: one vertical bar per day.
 */

const DAY_START_MIN = 5 * 60; // 5:00 AM local
const DAY_END_MIN = 25 * 60; // 1:00 AM next day
const BIN_MIN = 5;
const N_BINS = (DAY_END_MIN - DAY_START_MIN) / BIN_MIN;

type Cat = 'billable' | 'nonbillable' | 'idle';

const COLOR: Record<Cat, string> = {
  billable: '#1f8a4c',
  nonbillable: '#566573',
  idle: '#5b8def',
};
const LABEL: Record<Cat, string> = {
  billable: 'Billable',
  nonbillable: 'Non-billable / unattributed',
  idle: 'Idle (at desk)',
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

/** A prepared day model: strip segments plus the true idle-at-desk total (for
 *  the Today "Idle" card — same computation, so the card and the blue segments
 *  always agree). */
export interface DayModel {
  segments: Segment[];
  idleSeconds: number;
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

const isLock = (app: string | null | undefined) => (app ?? '').toLowerCase().includes('lockapp');

/**
 * Classify one day's rows and bin them:
 *  - worked (not AFK, or AFK but grace-promoted) → billable / nonbillable
 *  - idle-at-desk: sensor-AFK, NOT promoted, not the lock screen, in a
 *    contiguous run (5-min bridge, same as the resolver) no longer than the
 *    away cutoff → blue. Runs longer than the cutoff, and lock time, are away.
 */
export function buildDayModel(
  rows: StripInput[],
  day: string,
  tz: string,
  awayCutoffSeconds: number,
): DayModel {
  // idle-at-desk run detection over the residual AFK rows
  const afk = rows
    .filter((r) => r.isAfk && !r.afkPromoted && !isLock(r.app))
    .sort((a, b) => Date.parse(a.startTs) - Date.parse(b.startTs));
  const idleIds = new Set<string>();
  let idleSeconds = 0;
  for (let i = 0; i < afk.length; ) {
    let j = i;
    let total = 0;
    let lastEnd = Date.parse(afk[i]!.startTs);
    const ids: string[] = [];
    while (j < afk.length && Date.parse(afk[j]!.startTs) - lastEnd <= 300_000) {
      total += afk[j]!.durationSeconds;
      lastEnd = Date.parse(afk[j]!.endTs);
      ids.push(afk[j]!.id);
      j++;
    }
    if (total <= awayCutoffSeconds) {
      for (const id of ids) idleIds.add(id);
      idleSeconds += total;
    }
    i = j;
  }

  const bins: Array<Record<Cat, number>> = Array.from({ length: N_BINS }, () => ({
    billable: 0,
    nonbillable: 0,
    idle: 0,
  }));
  for (const r of rows) {
    let cat: Cat;
    const worked = !r.isAfk || !!r.afkPromoted;
    if (worked) {
      cat =
        r.clientId && r.isBillable !== false && BILLABLE_STATUSES.has(r.status ?? '')
          ? 'billable'
          : 'nonbillable';
    } else if (idleIds.has(r.id)) {
      cat = 'idle';
    } else {
      continue; // away / locked / long idle -> gap
    }
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

  return { segments: mergeBinTotals(bins), idleSeconds };
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
    idle: 0,
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
  const PRIORITY: Cat[] = ['billable', 'nonbillable', 'idle'];
  const binCat: Array<Cat | null> = bins.map((b) => {
    const total = b.billable + b.nonbillable + b.idle;
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
  return segments.map((s) => ({
    leftPct: pctOfDay(s.from),
    widthPct: pctOfDay(s.to - s.from),
    color: COLOR[s.cat],
    durLabel: fmtDur(s.seconds),
    catLabel: LABEL[s.cat],
    rangeLabel: `${fmtMin(binToMin(s.from))}–${fmtMin(binToMin(s.to))}`,
  }));
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

/** Shared legend. Today passes showIdle (its strip paints idle blue); the
 *  Reporting columns don't paint idle, so the swatch stays off there. */
export function DayStripLegend({ showIdle = false }: { showIdle?: boolean }) {
  return (
    <div className="legend" style={{ marginTop: 2 }}>
      <span><i style={{ background: COLOR.billable }} />Billable</span>
      <span><i style={{ background: COLOR.nonbillable }} />Non-billable / unattributed</span>
      {showIdle && <span><i style={{ background: COLOR.idle }} />Idle (at desk)</span>}
      <span><i style={{ background: 'rgba(150,158,168,0.35)' }} />Away / off</span>
    </div>
  );
}
