import type { ActivityEvent } from '@tt/shared';
import type { IntervalInput, RawEventInput } from '@tt/db';
import { hashKey } from './dedupe';

const BROWSERS = ['chrome', 'edge', 'firefox', 'brave', 'arc', 'opera', 'safari', 'msedge'];

function isBrowserApp(app?: string | null): boolean {
  const a = (app ?? '').toLowerCase();
  return BROWSERS.some((b) => a.includes(b));
}
const ms = (iso: string): number => Date.parse(iso);
function overlap(aS: number, aE: number, bS: number, bE: number): number {
  return Math.max(0, Math.min(aE, bE) - Math.max(aS, bS));
}

/**
 * Merge [s,e) ranges into a sorted, disjoint set, bridging gaps up to `gapMs`.
 * For window coverage we bridge 60s so the inevitable sub-minute gaps between
 * focus changes aren't mistaken for "no window" — only a real minutes-long
 * stretch with nothing focused (RDP, secure desktop) survives as a gap.
 */
function mergeRanges(rs: Array<{ s: number; e: number }>, gapMs = 0): Array<{ s: number; e: number }> {
  const sorted = rs.filter((r) => r.e > r.s).sort((a, b) => a.s - b.s);
  const out: Array<{ s: number; e: number }> = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.s <= last.e + gapMs) last.e = Math.max(last.e, r.e);
    else out.push({ ...r });
  }
  return out;
}

/** The parts of [s,e) not covered by the (merged, sorted) `covered` ranges. */
function subtractCovered(s: number, e: number, covered: Array<{ s: number; e: number }>): Array<{ s: number; e: number }> {
  const gaps: Array<{ s: number; e: number }> = [];
  let cur = s;
  for (const c of covered) {
    if (c.e <= cur) continue;
    if (c.s >= e) break;
    if (c.s > cur) gaps.push({ s: cur, e: c.s });
    cur = Math.max(cur, c.e);
    if (cur >= e) break;
  }
  if (cur < e) gaps.push({ s: cur, e });
  return gaps;
}

export function toRawEventInput(e: ActivityEvent): RawEventInput {
  return {
    source: e.source,
    hostname: e.hostname ?? null,
    bucket: e.bucket ?? null,
    eventType: e.eventType,
    app: e.app ?? null,
    windowTitle: e.windowTitle ?? null,
    url: e.url ?? null,
    afk: e.afk ?? null,
    ts: e.timestamp,
    durationSeconds: e.durationSeconds,
    data: e.data ?? {},
    dedupeKey: hashKey('raw', e.source, e.bucket, e.timestamp, e.app, e.windowTitle, e.url),
  };
}

export interface NormalizeOptions {
  mergeGapSeconds?: number;
}

interface Candidate {
  start: number;
  end: number;
  app: string | null;
  title: string | null;
  url: string | null;
  browser: string | null;
  isAfk: boolean;
  hostname: string | null;
  source: string;
}

/**
 * Turn raw window/afk/web events into merged, AFK-aware intervals:
 *  - enrich browser windows with the overlapping web event's URL,
 *  - flag intervals mostly covered by an AFK span,
 *  - merge consecutive same-activity blocks (volatile title/url chrome ignored)
 *    within a small gap.
 */
function stripVolatileTitle(title: string | null): string {
  return (title ?? '')
    .toLowerCase()
    .replace(/^\s*[([]\s*\d+\s*[)\]]\s*/, '') // leading "(3)" / "[3]" unread badge
    .replace(/^\s*[•·*]\s+/, '') // leading bullet
    .replace(/\s*[-–—|]\s*\d+\s+(new|unread)\b[^-–—|]*/gi, ' ') // "- 1 new item(s)"
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Two adjacent blocks are "the same activity" when app + de-chromed title + afk
 * match. URL is deliberately excluded from the key: the web-watcher enriches it
 * only intermittently, so keying on it split one task into url / no-url blocks.
 * The de-chromed title identifies the activity, and the merge below adopts a url
 * from any block in the run so the resolver still gets the sheet/page id. This
 * collapses unread-count and per-cell title flicker that otherwise shatters one
 * task into dozens of sub-20s blocks the resolver then drops.
 */
function mergeKeyOf(c: Candidate): string {
  return `${(c.app ?? '').toLowerCase()}|${stripVolatileTitle(c.title)}|${c.isAfk ? 1 : 0}`;
}

export function normalizeEvents(events: ActivityEvent[], opts: NormalizeOptions = {}): IntervalInput[] {
  const gap = (opts.mergeGapSeconds ?? 60) * 1000;
  const windows = events.filter((e) => e.eventType === 'window' && e.durationSeconds > 0);
  const webs = events.filter((e) => e.eventType === 'web');
  // Build a gapless afk-STATE timeline, then keep the spans where you were active
  // (not-afk). The afk watcher logs a reading only when the state changes, and on
  // this fleet it also goes silent for long stretches — so between two readings we
  // CARRY the earlier reading's state forward across the gap. That distinguishes
  // the two kinds of gap: a gap after an IDLE reading = you went idle and the
  // machine slept (away — the reason a left-open Teams window billed through
  // lunch), while a gap after an ACTIVE reading = a watcher hiccup while you kept
  // working (still active). A window counts as active only where this timeline
  // says not-afk; everywhere else is idle. No afk data at all (watcher missing) ->
  // fall back to active so it can't zero out a day.
  const afkEvents = events
    .filter((e) => e.eventType === 'afk' && e.durationSeconds > 0)
    .map((e) => ({ s: ms(e.timestamp), e: ms(e.timestamp) + e.durationSeconds * 1000, afk: !!e.afk }))
    .sort((a, b) => a.s - b.s);
  const hasAfk = afkEvents.length > 0;
  const activeRanges: Array<{ s: number; e: number }> = [];
  for (let i = 0; i < afkEvents.length; i++) {
    const curEv = afkEvents[i]!;
    const nextEv = afkEvents[i + 1];
    // Extend this reading to the next reading's start so the gap inherits its state.
    const spanEnd = nextEv ? Math.max(curEv.e, nextEv.s) : curEv.e;
    if (!curEv.afk) activeRanges.push({ s: curEv.s, e: spanEnd });
  }
  const activeSpans = mergeRanges(activeRanges);

  const candidates: Candidate[] = windows
    .flatMap((w) => {
      const start = ms(w.timestamp);
      const end = start + w.durationSeconds * 1000;
      if (end <= start) return [];
      let url = w.url ?? null;
      let title = w.windowTitle ?? null;
      const browser = isBrowserApp(w.app) ? (w.app ?? null) : null;

      if (browser && !url) {
        let best: ActivityEvent | null = null;
        let bestOv = 0;
        for (const web of webs) {
          const wS = ms(web.timestamp);
          const wE = wS + web.durationSeconds * 1000;
          const ov = overlap(start, end, wS, wE);
          if (ov > bestOv) {
            bestOv = ov;
            best = web;
          }
        }
        if (best) {
          url = best.url ?? url;
          if (!title) title = best.windowTitle ?? null;
        }
      }

      // Split this window span into active vs idle by the not-afk coverage: parts
      // covered by an active span are active; everything else (an explicit afk
      // stretch, or an afk-feed gap where the machine slept) is idle. activeSpans
      // is already merged + sorted. No afk data at all -> treat as active.
      const segs: Array<{ s: number; e: number; afk: boolean }> = [];
      if (!hasAfk) {
        segs.push({ s: start, e: end, afk: false });
      } else {
        const active = activeSpans
          .map((sp) => ({ s: Math.max(start, sp.s), e: Math.min(end, sp.e) }))
          .filter((x) => x.e > x.s);
        let cur = start;
        for (const sp of active) {
          if (sp.s > cur) segs.push({ s: cur, e: sp.s, afk: true });
          segs.push({ s: sp.s, e: sp.e, afk: false });
          cur = sp.e;
        }
        if (cur < end) segs.push({ s: cur, e: end, afk: true });
        if (segs.length === 0) segs.push({ s: start, e: end, afk: true });
      }

      return segs.map((sg) => ({
        start: sg.s,
        end: sg.e,
        app: w.app ?? null,
        title,
        url,
        browser,
        isAfk: sg.afk,
        hostname: w.hostname ?? null,
        source: w.source,
      }));
    })
    .sort((a, b) => a.start - b.start);

  // ---- fill no-window gaps so intervals cover the whole session --------------
  // The afk bucket spans every second the machine registered you (idle or not);
  // window events only cover focused-window time. The leftover (RDP, the Windows
  // secure desktop, fast app-switching) is real time at the machine with no app,
  // so emit it as "(no window captured)" blocks — inheriting the afk flag of the
  // span they fall in. This makes the stored total equal AW's full session and
  // the active total equal AW's not-afk total instead of only focused-window time.
  const sessionSpans = events
    .filter((e) => e.eventType === 'afk' && e.durationSeconds > 0)
    .map((e) => ({
      s: ms(e.timestamp),
      e: ms(e.timestamp) + e.durationSeconds * 1000,
      afk: !!e.afk,
      hostname: e.hostname ?? null,
      source: e.source,
    }))
    .filter((x) => x.e > x.s)
    .sort((a, b) => a.s - b.s);
  const windowCover = mergeRanges(
    windows.map((w) => ({ s: ms(w.timestamp), e: ms(w.timestamp) + w.durationSeconds * 1000 })),
    60_000,
  );
  for (const sp of sessionSpans) {
    for (const g of subtractCovered(sp.s, sp.e, windowCover)) {
      if (g.e - g.s < 30_000) continue; // only real no-window stretches (>=30s)
      candidates.push({
        start: g.s,
        end: g.e,
        app: null,
        title: '(no window captured)',
        url: null,
        browser: null,
        isAfk: sp.afk,
        hostname: sp.hostname,
        source: sp.source,
      });
    }
  }
  candidates.sort((a, b) => a.start - b.start);

  const merged: Candidate[] = [];
  let lastKey = '';
  for (const c of candidates) {
    const key = mergeKeyOf(c);
    const last = merged[merged.length - 1];
    if (last && key === lastKey && c.start <= last.end + gap) {
      // Extend the run. Keep the first block's title for display, but adopt a
      // url/browser from a later block when the first lacked one, so a Google
      // Sheet / SharePoint id still reaches the resolver.
      last.end = Math.max(last.end, c.end);
      if (!last.url && c.url) last.url = c.url;
      if (!last.browser && c.browser) last.browser = c.browser;
    } else {
      merged.push({ ...c });
      lastKey = key;
    }
  }

  return merged.map((c) => {
    const startTs = new Date(c.start).toISOString();
    const endTs = new Date(c.end).toISOString();
    return {
      source: c.source,
      hostname: c.hostname,
      startTs,
      endTs,
      durationSeconds: Math.round((c.end - c.start) / 1000),
      app: c.app,
      windowTitle: c.title,
      url: c.url,
      browser: c.browser,
      isAfk: c.isAfk,
      // Stable identity for a run: source + host + start + app + de-chromed title.
      // Deliberately EXCLUDES url and end — the merge adopts a url from a later
      // block and the run's end grows as events arrive, so keying on those gave a
      // settled interval a NEW key every cycle, which orphaned its resolution and
      // forced the whole day to re-attribute. Keying on the stable parts lets the
      // upsert update the same row in place, so attributions persist.
      dedupeKey: hashKey('iv', c.source, c.hostname, startTs, c.app, stripVolatileTitle(c.title), c.isAfk ? 'afk' : 'active'),
    } satisfies IntervalInput;
  });
}
