import type { TimelineRow } from '@tt/db';

/**
 * "When did they work" strip for the Today view: one horizontal bar from
 * 6:00 AM to 1:00 AM (MT), color-coded —
 *   green  = billable client time (auto-finalized / confirmed / suggested)
 *   slate  = non-billable + unattributed active time
 *   blue   = idle at the desk (short no-input stretches; still on the computer)
 *   track  = translucent gray: not working (away, locked screen, off)
 * The day is bucketed into 5-minute bins and each bin takes its dominant
 * category, so the strip reads as clean runs instead of hundreds of slivers.
 */

const DAY_START_MIN = 6 * 60; // 6:00 AM local
const DAY_END_MIN = 25 * 60; // 1:00 AM next day
const BIN_MIN = 5;
const N_BINS = (DAY_END_MIN - DAY_START_MIN) / BIN_MIN;

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

type Cat = 'billable' | 'nonbillable' | 'idle';
const BILLABLE_STATUSES = new Set(['auto_finalized', 'confirmed', 'suggested']);

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

export function DayStrip({
  rows,
  day,
  tz,
  label,
  awayCutoffSeconds,
}: {
  rows: TimelineRow[];
  day: string;
  tz: string;
  label?: string;
  awayCutoffSeconds: number;
}) {
  // 1) Contiguous AFK runs (chained across ≤2-min gaps): short runs = idle at the
  //    desk; long runs = away (lunch, gone) -> not working. Locked screen = away.
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

  // 2) Score each 5-minute bin by overlapped seconds per category.
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
    } else if (
      r.clientId &&
      r.isBillable !== false &&
      BILLABLE_STATUSES.has(r.status ?? '')
    ) {
      cat = 'billable';
    } else {
      cat = 'nonbillable'; // needs_review, unresolved, non-billable buckets
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

  // 3) Dominant category per bin (billable wins ties), then merge into segments.
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
  const segments: Array<{ cat: Cat; from: number; to: number }> = [];
  for (let b = 0; b < N_BINS; b++) {
    const c = binCat[b];
    if (!c) continue;
    const last = segments[segments.length - 1];
    if (last && last.cat === c && last.to === b) last.to = b + 1;
    else segments.push({ cat: c, from: b, to: b + 1 });
  }

  const pct = (bin: number) => (bin / N_BINS) * 100;
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
        {segments.map((s, i) => {
          const fromMin = DAY_START_MIN + s.from * BIN_MIN;
          const toMin = DAY_START_MIN + s.to * BIN_MIN;
          return (
            <span
              key={i}
              title={`${fmtMin(fromMin)}–${fmtMin(toMin)} · ${LABEL[s.cat]}`}
              style={{
                position: 'absolute',
                left: `${pct(s.from)}%`,
                width: `${pct(s.to - s.from)}%`,
                top: 0,
                bottom: 0,
                background: COLOR[s.cat],
              }}
            />
          );
        })}
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

/** Shared legend for one or more DayStrips. */
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
