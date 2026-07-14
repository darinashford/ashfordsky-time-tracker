import { readFile } from 'node:fs/promises';
import type { ActivityEvent } from '@tt/shared';
import type { FetchOpts, SensorAdapter } from './adapter';

/** Reads ActivityEvents from a JSON fixture. Great for first-run + offline dev. */
export class MockAdapter implements SensorAdapter {
  readonly name = 'mock';

  constructor(
    private readonly fixturePath: string,
    private readonly rebaseToToday = false,
  ) {}

  async fetchEvents({ since, until }: FetchOpts): Promise<ActivityEvent[]> {
    const raw = JSON.parse(await readFile(this.fixturePath, 'utf8')) as ActivityEvent[];
    const events = this.rebaseToToday ? rebase(raw) : raw;
    return events.filter((e) => e.timestamp >= since && e.timestamp < until);
  }
}

/** Shift every fixture timestamp forward so the demo day lands on "today". */
function rebase(events: ActivityEvent[]): ActivityEvent[] {
  if (events.length === 0) return events;
  const first = Math.min(...events.map((e) => Date.parse(e.timestamp)));
  const fixtureMidnight = new Date(first);
  fixtureMidnight.setUTCHours(0, 0, 0, 0);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const offset = today.getTime() - fixtureMidnight.getTime();
  return events.map((e) => ({
    ...e,
    timestamp: new Date(Date.parse(e.timestamp) + offset).toISOString(),
  }));
}
