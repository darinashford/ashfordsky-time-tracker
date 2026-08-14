import { secondsToHours } from '@tt/shared';
import { DayStripView, type PreparedStripCell, type PreparedStripSegment, type PreparedStripTick } from './DayStripView';
import { WorkdayColumnsView, type PreparedDay, type PreparedTick } from './WorkdayColumnsView';

/**
 * "When did they work" strips —
 *   green  = billable client time (any client-attributed block, incl. Uncertain)
 *   slate  = non-billable + unattributed worked time
 *   track  = translucent gray: Away / off (no-input past the 15-min grace,
 *            locked, or simply not there)
 * The day runs 5:00 AM → 1:00 AM (MT) in 5-minute cells. Each cell is painted
 * PROPORTIONALLY: a slate band sized to its non-billable share sits on top of
 * the green. The old winner-take-all cell coloring buried the minority — a day
 * with 1.7h of scattered email showed almost no slate because green won nearly
 * every mixed cell, so the strip visibly disagreed with the Non-billable card.
 * Proportional cells make strip mass equal card mass by construction.
 * Worked = sensor-active OR grace-promoted (afk_promoted — migration 0015).
 * Clicking any stretch — worked or away — shows a bubble with its duration,
 * split into billable / non-billable for worked stretches.
 *
 * `DayStrip` (via buildDayModel) is the horizontal single-day bar (Today).
 * `WorkdayColumns` is the multi-day Reporting version: one vertical bar per day.
 */

const DAY_START_MIN = 5 * 60; // 5:00 AM local
const DAY_END_MIN = 25 * 60; // 1:00 AM next day
const BIN_MIN = 5;
const N_BINS = (DAY_END_MIN - DAY_START_MIN) / BIN_MIN;

const COLOR = {
  billable: '#1f8a4c',
  nonbillable: '#566573',
} as const;

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

/** One contiguous painted run of cells, carrying the REAL seconds of both
 *  categories inside it — the unit of clicking/bubbles. */
interface Stretch {
  from: number; // bin index (inclusive)
  to: number; // bin index (exclusive)
  billableSec: number;
  nonbillableSec: number;
}

/** A run of adjacent cells sharing the same (quantized) non-billable share —
 *  the unit of painting. Quantizing to 10% steps keeps the DOM small enough
 *  for a month of Reporting columns. */
interface CellRun {
  from: number;
  to: number;
  grayFrac: number; // 0..1 share of the cells' worked seconds that is non-billable
}

/** A prepared day model for the strips. */
export interface DayModel {
  cellRuns: CellRun[];
  stretches: Stretch[];
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

interface BinTotals {
  billable: number;
  nonbillable: number;
}

/** Bin one day's rows into 5-min cells. Worked (not AFK, or AFK but
 *  grace-promoted) → billable / nonbillable seconds per cell. Everything else —
 *  idle past the grace, locked, gone — is Away/off and stays unpainted track. */
export function buildDayModel(rows: StripInput[], day: string, tz: string): DayModel {
  const bins: BinTotals[] = Array.from({ length: N_BINS }, () => ({ billable: 0, nonbillable: 0 }));
  for (const r of rows) {
    const worked = !r.isAfk || !!r.afkPromoted;
    if (!worked) continue; // Away / off -> track
    const cat: keyof BinTotals =
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
  return modelFromBins(bins);
}

/** Server-aggregated strip bins (see @tt/db getRangeStripBins) — worked seconds
 *  per 5-min display bin, already split billable/non-billable and localized. */
export interface BinnedInput {
  bin: number; // 0..N_BINS-1
  billableSeconds: number;
  nonbillableSeconds: number;
}

/** Same rules, from pre-aggregated bins — so Reporting never ships raw interval
 *  rows to render the strips. */
export function modelFromBinRows(binRows: BinnedInput[]): DayModel {
  const bins: BinTotals[] = Array.from({ length: N_BINS }, () => ({ billable: 0, nonbillable: 0 }));
  for (const b of binRows) {
    if (b.bin < 0 || b.bin >= N_BINS) continue;
    bins[b.bin]!.billable += b.billableSeconds;
    bins[b.bin]!.nonbillable += b.nonbillableSeconds;
  }
  return modelFromBins(bins);
}

/** Cells paint when MAJORITY covered (≥150s of 300s) so bar length tracks the
 *  cards; short interior gaps are absorbed (no sub-grace Away slivers — see the
 *  15-min policy); painted runs become stretches (clicking) and quantized
 *  cell-runs (painting). */
function modelFromBins(bins: BinTotals[]): DayModel {
  const painted: boolean[] = bins.map((b) => b.billable + b.nonbillable >= 150);

  // INVARIANT: no visible Away sliver shorter than the 15-min grace. A short
  // unpainted run BETWEEN painted cells is bin-rounding or a knife-edge idle
  // run — under "gone < 15 min = still working" it reads as continuation.
  for (let b = 0; b < N_BINS; b++) {
    if (painted[b]) continue;
    let e = b;
    while (e < N_BINS && !painted[e]) e++;
    if (b > 0 && painted[b - 1] && e < N_BINS && e - b < 3) {
      for (let i = b; i < e; i++) painted[i] = true;
    }
    b = e;
  }

  const stretches: Stretch[] = [];
  const cellRuns: CellRun[] = [];
  const quant = (b: BinTotals): number => {
    const tot = b.billable + b.nonbillable;
    if (tot <= 0) return 0; // absorbed gap cell: paint as pure carry (green)
    return Math.round((b.nonbillable / tot) * 10) / 10; // 10% steps
  };
  for (let b = 0; b < N_BINS; b++) {
    if (!painted[b]) continue;
    const s = stretches[stretches.length - 1];
    if (s && s.to === b) {
      s.to = b + 1;
      s.billableSec += bins[b]!.billable;
      s.nonbillableSec += bins[b]!.nonbillable;
    } else {
      stretches.push({ from: b, to: b + 1, billableSec: bins[b]!.billable, nonbillableSec: bins[b]!.nonbillable });
    }
    const g = quant(bins[b]!);
    const c = cellRuns[cellRuns.length - 1];
    if (c && c.to === b && c.grayFrac === g) c.to = b + 1;
    else cellRuns.push({ from: b, to: b + 1, grayFrac: g });
  }
  return { cellRuns, stretches };
}

const binToMin = (bin: number) => DAY_START_MIN + bin * BIN_MIN;
const pctOfDay = (bin: number) => (bin / N_BINS) * 100;

/** Bubble copy for a worked stretch: total, then the split when it's mixed. */
function stretchLabels(s: Stretch): { durLabel: string; catLabel: string } {
  const total = s.billableSec + s.nonbillableSec;
  const durLabel = fmtDur(total);
  if (s.nonbillableSec < 30) return { durLabel, catLabel: 'Billable' };
  if (s.billableSec < 30) return { durLabel, catLabel: 'Non-billable / unattributed' };
  return { durLabel, catLabel: `${fmtDur(s.billableSec)} billable · ${fmtDur(s.nonbillableSec)} non-billable` };
}

function prepareCells(cellRuns: CellRun[]): PreparedStripCell[] {
  return cellRuns.map((c) => ({
    leftPct: pctOfDay(c.from),
    widthPct: pctOfDay(c.to - c.from),
    grayFrac: c.grayFrac,
  }));
}

/** Click overlays: one per worked stretch (with the billable/non-billable split
 *  in the bubble) and one Away ghost per gap BETWEEN stretches. All transparent —
 *  the cells underneath are the paint. */
function prepareOverlays(stretches: Stretch[]): PreparedStripSegment[] {
  const out: PreparedStripSegment[] = [];
  const pushAway = (from: number, to: number) => {
    if (to <= from) return;
    out.push({
      leftPct: pctOfDay(from),
      widthPct: pctOfDay(to - from),
      ghost: true,
      durLabel: fmtDur((to - from) * BIN_MIN * 60),
      catLabel: 'Away / off',
      rangeLabel: `${fmtMin(binToMin(from))}–${fmtMin(binToMin(to))}`,
    });
  };
  let cursor: number | null = null;
  for (const s of stretches) {
    if (cursor != null) pushAway(cursor, s.from);
    const { durLabel, catLabel } = stretchLabels(s);
    out.push({
      leftPct: pctOfDay(s.from),
      widthPct: pctOfDay(s.to - s.from),
      durLabel,
      catLabel,
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
  return (
    <DayStripView
      cells={prepareCells(model.cellRuns)}
      segments={prepareOverlays(model.stretches)}
      ticks={prepareTicks(60)}
      label={label}
    />
  );
}

/** Same horizontal strip, from server-aggregated bins (Reporting's day view). */
export function DayStripBinned({ bins, label }: { bins: BinnedInput[]; label?: string }) {
  const model = modelFromBinRows(bins);
  return (
    <DayStripView
      cells={prepareCells(model.cellRuns)}
      segments={prepareOverlays(model.stretches)}
      ticks={prepareTicks(60)}
      label={label}
    />
  );
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
    const model = modelFromBinRows(d.bins);
    return {
      key: d.day,
      label: d.label,
      sublabel: d.sublabel,
      // Worked total from coverage_report — ties to the "Worked" card exactly.
      workedLabel: `${secondsToHours(d.workedSeconds).toFixed(2)}h`,
      cells: model.cellRuns.map((c) => ({
        topPct: pctOfDay(c.from),
        heightPct: pctOfDay(c.to - c.from),
        grayFrac: c.grayFrac,
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
