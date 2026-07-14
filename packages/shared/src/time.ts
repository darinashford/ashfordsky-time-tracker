// Timezone-aware helpers. We never store local time; we bucket/display in the
// configured zone (default America/Denver) using Intl, with no date libs.

export function secondsBetween(aIso: string, bIso: string): number {
  return (new Date(bIso).getTime() - new Date(aIso).getTime()) / 1000;
}

export function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

// Intl.DateTimeFormat construction is one of the most expensive calls in JS
// (~1ms each). These run once per row on data-heavy pages (a day has 1000+
// blocks), so cache one formatter per timezone instead of rebuilding.
const dateFmtCache = new Map<string, Intl.DateTimeFormat>();
const clockFmtCache = new Map<string, Intl.DateTimeFormat>();

/** Local calendar date (YYYY-MM-DD) for an instant, in the given zone. */
export function localDate(iso: string, tz: string): string {
  let f = dateFmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    dateFmtCache.set(tz, f);
  }
  const parts = f.formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Local wall-clock time (HH:mm, 24h) for an instant, in the given zone. */
export function localClock(iso: string, tz: string): string {
  let f = clockFmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    clockFmtCache.set(tz, f);
  }
  return f.format(new Date(iso));
}

/** Human duration: "45s", "12m", "1h 23m". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

/** Hours rounded to 2 decimals (for billing display). */
export function secondsToHours(totalSeconds: number): number {
  return Math.round((totalSeconds / 3600) * 100) / 100;
}
