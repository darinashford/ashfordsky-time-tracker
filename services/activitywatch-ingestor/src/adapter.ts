import type { ActivityEvent } from '@tt/shared';

export interface FetchOpts {
  since: string; // ISO-8601 inclusive
  until: string; // ISO-8601 exclusive
}

/**
 * A sensor is anything that can produce normalized ActivityEvents for a time
 * range. ActivityWatch is the first implementation; ManicTime / a custom watcher
 * could be dropped in behind the same interface.
 */
export interface SensorAdapter {
  readonly name: string;
  fetchEvents(opts: FetchOpts): Promise<ActivityEvent[]>;
}
