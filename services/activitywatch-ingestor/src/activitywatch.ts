import type { ActivityEvent } from '@tt/shared';
import type { FetchOpts, SensorAdapter } from './adapter';

interface AwBucket {
  id: string;
  type?: string;
  hostname?: string;
}
interface AwEvent {
  timestamp: string;
  duration: number;
  data: Record<string, unknown>;
}

/** Reads window/afk/web buckets from the local ActivityWatch REST API. */
export class ActivityWatchAdapter implements SensorAdapter {
  readonly name = 'activitywatch';

  constructor(private readonly baseUrl: string) {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) throw new Error(`ActivityWatch ${path} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async fetchEvents({ since, until }: FetchOpts): Promise<ActivityEvent[]> {
    const buckets = await this.get<Record<string, AwBucket>>('/api/0/buckets/');
    const out: ActivityEvent[] = [];

    for (const [id, bucket] of Object.entries(buckets)) {
      const type = (bucket.type ?? '').toLowerCase();
      const lid = id.toLowerCase();
      const isAfk = type.includes('afk') || lid.includes('afk');
      const isWeb = type.includes('web') || lid.includes('web');
      const isWindow = type.includes('window') || lid.includes('window') || lid.includes('currentwindow');
      if (!isAfk && !isWeb && !isWindow) continue;

      // NOTE: some aw-server versions don't treat limit=-1 as "all" and cap the
      // result, dropping older events. Use an explicit high limit instead.
      const qs =
        `?start=${encodeURIComponent(since)}&end=${encodeURIComponent(until)}&limit=1000000`;
      const events = await this.get<AwEvent[]>(`/api/0/buckets/${encodeURIComponent(id)}/events${qs}`);

      for (const e of events) {
        const d = e.data ?? {};
        out.push({
          source: 'activitywatch',
          hostname: bucket.hostname ?? null,
          bucket: id,
          eventType: isAfk ? 'afk' : isWeb ? 'web' : 'window',
          app: (d.app as string) ?? null,
          windowTitle: (d.title as string) ?? null,
          url: (d.url as string) ?? null,
          afk: isAfk ? d.status === 'afk' : null,
          timestamp: e.timestamp,
          durationSeconds: e.duration ?? 0,
          data: d,
        });
      }
    }
    return out;
  }
}
