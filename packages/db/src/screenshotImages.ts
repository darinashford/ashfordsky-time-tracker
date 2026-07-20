import type pg from 'pg';
import { validIdent } from './pool';

// Screenshot image bytes stored alongside their screenshots row so the dashboard
// can display them (the file on the capture machine is unreachable from the web).
// Writers cap size; retention mirrors the screenshots purge.

/** Max stored image size. Bigger captures are simply not uploaded (OCR still is). */
export const SCREENSHOT_IMAGE_MAX_BYTES = 2_500_000;

export async function storeScreenshotImage(
  pool: pg.Pool,
  schema: string,
  screenshotId: string,
  bytes: Buffer,
  contentType = 'image/png',
): Promise<boolean> {
  if (bytes.length === 0 || bytes.length > SCREENSHOT_IMAGE_MAX_BYTES) return false;
  const s = validIdent(schema);
  await pool.query(
    `insert into ${s}.screenshot_images (screenshot_id, content_type, bytes)
     values ($1, $2, $3)
     on conflict (screenshot_id) do nothing`,
    [screenshotId, contentType, bytes],
  );
  return true;
}

export interface ScreenshotImage {
  bytes: Buffer;
  contentType: string;
  hostname: string | null;
}

/** The image plus whose machine it came from (for per-person access checks). */
export async function getScreenshotImage(
  pool: pg.Pool,
  schema: string,
  screenshotId: string,
): Promise<ScreenshotImage | null> {
  const s = validIdent(schema);
  const res = await pool.query(
    `select si.bytes, si.content_type as "contentType", i.hostname
       from ${s}.screenshot_images si
       join ${s}.screenshots sc on sc.id = si.screenshot_id
       left join ${s}.intervals i on i.id = sc.interval_id
      where si.screenshot_id = $1 and sc.status <> 'deleted'`,
    [screenshotId],
  );
  if (!res.rows.length) return null;
  const r = res.rows[0] as { bytes: Buffer; contentType: string; hostname: string | null };
  return { bytes: r.bytes, contentType: r.contentType, hostname: r.hostname };
}

/** Drop image bytes past retention or whose screenshot was soft-deleted. */
export async function purgeExpiredScreenshotImages(
  pool: pg.Pool,
  schema: string,
  retentionDays: number,
): Promise<number> {
  const s = validIdent(schema);
  const res = await pool.query(
    `delete from ${s}.screenshot_images si
      using ${s}.screenshots sc
      where sc.id = si.screenshot_id
        and (sc.status = 'deleted' or si.created_at < now() - make_interval(days => $1))`,
    [Math.max(1, Math.round(retentionDays))],
  );
  return res.rowCount ?? 0;
}

export interface ScreenshotDayStats {
  taken: number; // screenshots captured this local day (with OCR text)
  utilized: number; // blocks whose attribution came from screenshot OCR
  utilizedSeconds: number;
}

/** Today-card numbers: how many screenshots were taken, and how many blocks the
 *  screen text actually attributed (resolver_type = screenshot_ocr). */
export async function getScreenshotStats(
  pool: pg.Pool,
  schema: string,
  day: string,
  tz: string,
  host?: string | null,
): Promise<ScreenshotDayStats> {
  const s = validIdent(schema);
  const res = await pool.query(
    `select
       (select count(*)::int
          from ${s}.screenshots sc
          left join ${s}.intervals i on i.id = sc.interval_id
         where sc.status = 'available'
           and (sc.captured_at at time zone $2)::date = $1::date
           and ($3::text is null or i.hostname = $3)) as taken,
       (select count(*)::int
          from ${s}.resolutions r
          join ${s}.intervals i2 on i2.id = r.interval_id
         where r.resolver_type = 'screenshot_ocr'
           and (i2.start_ts at time zone $2)::date = $1::date
           and ($3::text is null or i2.hostname = $3)) as utilized,
       (select coalesce(sum(i3.duration_seconds), 0)::float
          from ${s}.resolutions r2
          join ${s}.intervals i3 on i3.id = r2.interval_id
         where r2.resolver_type = 'screenshot_ocr'
           and (i3.start_ts at time zone $2)::date = $1::date
           and ($3::text is null or i3.hostname = $3)) as "utilizedSeconds"`,
    [day, tz, host ?? null],
  );
  const r = res.rows[0] as ScreenshotDayStats;
  return { taken: r.taken ?? 0, utilized: r.utilized ?? 0, utilizedSeconds: r.utilizedSeconds ?? 0 };
}
