/**
 * "When did they work" strips, color-coded —
 *   green  = billable client time (any client-attributed block, incl. Uncertain)
 *   slate  = non-billable + unattributed active time
 *   blue   = idle at the desk (short no-input stretches; still on the computer)
 *   track  = translucent gray: not working (away, locked screen, off)
 * The day runs 6:00 AM → 1:00 AM (MT), bucketed into 5-minute bins; each bin
 * takes its dominant category so the strip reads as clean runs, not slivers.
 *
 * `DayStrip` is the horizontal single-day bar (Today). `WorkdayColumns` is the
 * multi-day version for Reporting: one vertical bar per day, time top→bottom.
 */

const DAY_START_MIN = 6 * 60; // 6:00 AM local
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

/** The fields the strip logic needs — TimelineRow and the db StripRow both satisfy it. */
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

/** Contiguous AFK runs (chained across ≤2-min gaps): short runs = idle at the
 *  desk; long runs = away (not working). Locked screen is dropped upstream. */
function idleIdSet(rows: StripInput[], awayCutoffSeconds: number): Set<string> {
  const afk = rows
    .filter((r) => r.isAfk && !(r.app ?? '').toLowerCase().includes('lockapp'))
    .sort((a, b) => Date.parse(a.startTs) - Date.parse(b.startTs));
  const idleIds = new Set<string>();
  for (let i = 0; i < afk.length; ) {
    let j = i;
    let total = 0;
    let lastEnd = Date.parse(afk[i]!.startTs);
    const ids: string[] = [];
    while (j < afk.length && Date.parse(afk[j]!.startTs) - lastEnd <= 120_000) {
      total += afk[j]!.durationSeconds;
      lastEnd = Date.parse(afk[j]!.endTs);
      ids.push(afk[j]!.id);
      j++;
    }
    if (total <= awayCutoffSeconds) for (const id of ids) idleIds.add(id);
    i = j;
  }
  return idleIds;
}

/** Bucket one day's rows into 5-min bins, pick each bin's dominant category, and
 *  merge adjacent same-category bins into segments (billable wins ties). */
export function daySegments(
  rows: StripInput[],
  day: string,
  tz: string,
  awayCutoffSeconds: number,
): Segment[] {
  const idleIds = idleIdSet(rows, awayCutoffSeconds);
  const bins: Array<Record<Cat, number>> = Array.from({ length: N_BINS }, () => ({
    billable: 0,
    nonbillable: 0,
    idle: 0,
  }));
  for (const r of rows) {
    let cat: Cat;
    if (r.isAfk) {
      if (!idleIds.has(r.id)) continue; // away / locked -> gap
      cat = 'idle';
    } else if (r.clientId && r.isBillable !== false && BILLABLE_STATUSES.has(r.status ?? '')) {
      cat = 'billable';
    } else {
      cat = 'nonbillable'; // unresolved / no-client, or non-billable buckets
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

  const PRIORITY: Cat[] = ['billable', 'nonbillable', 'idle'];
  const binCat: Array<Cat | null> = bins.map((b) => {
    const total = b.billable + b.nonbillable + b.idle;
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
  awayCutoffSeconds,
}: {
  rows: StripInput[];
  day: string;
  tz: string;
  label?: string;
  awayCutoffSeconds: number;
}) {
  const segments = daySegments(rows, day, tz, awayCutoffSeconds);
  const ticks: number[] = [];
  for (let m = DAY_START_MIN; m <= DAY_END_MIN; m += 120) ticks.push(m);

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

/** One vertical day column: 6a at the top → 1a at the bottom, filled by segment. */
function DayColumn({
  rows,
  day,
  label,
  sublabel,
  tz,
  awayCutoffSeconds,
  height,
  width,
}: {
  rows: StripInput[];
  day: string;
  label: string;
  sublabel?: string;
  tz: string;
  awayCutoffSeconds: number;
  height: number;
  width: number;
}) {
  const segments = daySegments(rows, day, tz, awayCutoffSeconds);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width, flex: '0 0 auto' }}>
      <div
        style={{
          position: 'relative',
          width: '100%',
          height,
          borderRadius: 5,
          background: 'rgba(150,158,168,0.18)',
          overflow: 'hidden',
        }}
      >
        {segments.map((s, i) => (
          <span
            key={i}
            title={`${label}: ${fmtMin(binToMin(s.from))}–${fmtMin(binToMin(s.to))} · ${LABEL[s.cat]}`}
            style={{
              position: 'absolute',
              top: `${pctOfDay(s.from)}%`,
              height: `${pctOfDay(s.to - s.from)}%`,
              left: 0,
              right: 0,
              background: COLOR[s.cat],
            }}
          />
        ))}
      </div>
      <div className="muted" style={{ fontSize: 10, marginTop: 3, textAlign: 'center', lineHeight: 1.2 }}>
        <div style={{ fontWeight: 600 }}>{label}</div>
        {sublabel && <div>{sublabel}</div>}
      </div>
    </div>
  );
}

/** Multi-day "when did they work" view: one vertical bar per day. Used on
 *  Reporting for week/month. Time axis (6a→1a) runs down the left. */
export function WorkdayColumns({
  days,
  tz,
  awayCutoffSeconds,
  height = 240,
  colWidth = 26,
}: {
  days: Array<{ day: string; rows: StripInput[]; label: string; sublabel?: string }>;
  tz: string;
  awayCutoffSeconds: number;
  height?: number;
  colWidth?: number;
}) {
  const ticks: number[] = [];
  for (let m = DAY_START_MIN; m <= DAY_END_MIN; m += 180) ticks.push(m); // every 3h
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
      {/* left time axis, aligned to the bar height */}
      <div style={{ position: 'relative', width: 30, height, flex: '0 0 auto' }}>
        {ticks.map((m) => (
          <span
            key={m}
            className="muted"
            style={{
              position: 'absolute',
              top: `${((m - DAY_START_MIN) / (DAY_END_MIN - DAY_START_MIN)) * 100}%`,
              right: 2,
              transform: 'translateY(-50%)',
              fontSize: 10,
              whiteSpace: 'nowrap',
            }}
          >
            {fmtMin(m)}
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        {days.map((d) => (
          <DayColumn
            key={d.day}
            rows={d.rows}
            day={d.day}
            label={d.label}
            sublabel={d.sublabel}
            tz={tz}
            awayCutoffSeconds={awayCutoffSeconds}
            height={height}
            width={colWidth}
          />
        ))}
      </div>
    </div>
  );
}

/** Shared legend for one or more strips. */
export function DayStripLegend() {
  return (
    <div className="legend" style={{ marginTop: 2 }}>
      <span><i style={{ background: COLOR.billable }} />Billable</span>
      <span><i style={{ background: COLOR.nonbillable }} />Non-billable / unattributed</span>
      <span><i style={{ background: COLOR.idle }} />Idle (at desk)</span>
      <span><i style={{ background: 'rgba(150,158,168,0.35)' }} />Off / away</span>
    </div>
  );
}
