import { describe, expect, it } from 'vitest';
import type { ActivityEvent } from '@tt/shared';
import { normalizeEvents } from '../src/normalize';

const iso = (ms: number): string => new Date(ms).toISOString();
const T0 = Date.parse('2026-07-15T20:00:00.000Z');
const MIN = 60_000;

function win(startMs: number, mins: number, app: string, title = 'x'): ActivityEvent {
  return {
    source: 'activitywatch',
    hostname: 'keith',
    eventType: 'window',
    app,
    windowTitle: title,
    timestamp: iso(startMs),
    durationSeconds: (mins * MIN) / 1000,
  };
}

function afk(startMs: number, mins: number, isAfk: boolean): ActivityEvent {
  return {
    source: 'activitywatch',
    hostname: 'keith',
    eventType: 'afk',
    afk: isAfk,
    timestamp: iso(startMs),
    durationSeconds: (mins * MIN) / 1000,
  };
}

const activeSeconds = (rows: Array<{ isAfk: boolean; durationSeconds: number }>): number =>
  rows.filter((r) => !r.isAfk).reduce((a, r) => a + r.durationSeconds, 0);

/** Active seconds for one app only. normalizeEvents also emits "(no window
 *  captured)" filler for the afk bucket's own spans, which isn't under test here. */
const activeSecondsFor = (
  rows: Array<{ app?: string | null; isAfk: boolean; durationSeconds: number }>,
  app: string,
): number => activeSeconds(rows.filter((r) => (r.app ?? '').toLowerCase().includes(app.toLowerCase())));

describe('normalizeEvents — locked / slept machines are never active', () => {
  // The real bug: Keith locked at night, the afk watcher went silent, and the next
  // reading came 13h later the next morning. The last "active" reading carried
  // across the whole gap, so LockApp.exe was recorded as 13h of active time.
  it('does not bill an overnight lock screen as active time', () => {
    const events: ActivityEvent[] = [
      afk(T0, 5, false), // last reading before locking: active
      win(T0 + 5 * MIN, 13 * 60, 'LockApp.exe', 'Windows Default Lock Screen'), // locked 13h
      afk(T0 + 5 * MIN + 13 * 60 * MIN, 5, false), // next morning, unlocked
    ];
    const out = normalizeEvents(events);
    const lock = out.filter((r) => (r.app ?? '').includes('LockApp'));
    expect(lock.length).toBeGreaterThan(0);
    // Every second of lock-screen time must be idle, not active.
    expect(activeSeconds(lock)).toBe(0);
    expect(lock.every((r) => r.isAfk)).toBe(true);
  });

  it('marks the lock screen idle even when the afk feed claims active', () => {
    const events: ActivityEvent[] = [
      afk(T0, 60, false), // feed says active the whole hour
      win(T0, 60, 'LockApp.exe', 'Windows Default Lock Screen'),
    ];
    const out = normalizeEvents(events);
    expect(activeSecondsFor(out, 'LockApp')).toBe(0);
  });

  it('caps how far an active reading carries across a silent feed', () => {
    // Active reading, then the feed goes silent for 8h while a normal app stays
    // "focused" (machine slept). Only the short carry-forward may count as active.
    const events: ActivityEvent[] = [
      afk(T0, 5, false),
      win(T0 + 5 * MIN, 8 * 60, 'excel.exe', 'Book1.xlsx'),
      afk(T0 + 5 * MIN + 8 * 60 * MIN, 5, false),
    ];
    const out = normalizeEvents(events);
    // 10-minute cap, not 8 hours.
    expect(activeSecondsFor(out, 'excel')).toBeLessThanOrEqual(10 * 60);
  });

  it('still counts real work through a brief watcher hiccup', () => {
    // A short silence after an active reading is a watcher blip, not a nap —
    // the window stays active so a normal working stretch isn't lost.
    const events: ActivityEvent[] = [
      afk(T0, 5, false),
      win(T0 + 5 * MIN, 4, 'excel.exe', 'Book1.xlsx'),
      afk(T0 + 9 * MIN, 5, false),
    ];
    const out = normalizeEvents(events);
    expect(activeSecondsFor(out, 'excel')).toBe(4 * 60);
  });

  it('keeps an explicit afk stretch idle', () => {
    const events: ActivityEvent[] = [
      afk(T0, 30, true),
      win(T0, 30, 'excel.exe', 'Book1.xlsx'),
    ];
    const out = normalizeEvents(events);
    expect(activeSecondsFor(out, 'excel')).toBe(0);
  });
});
