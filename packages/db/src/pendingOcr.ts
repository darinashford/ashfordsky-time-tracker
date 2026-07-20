import type pg from 'pg';
import { validIdent } from './pool';

/**
 * Stage OCR text sent by a teammate's token-mode screenshot loop. Their machine
 * has no DB access, so it can't attach OCR to an interval directly — it lands here
 * keyed by (hostname, captured_at) and is matched to the interval later, once that
 * interval has been ingested. See attachPendingOcr.
 */
export async function stagePendingOcr(
  pool: pg.Pool,
  schema: string,
  x: {
    hostname: string;
    app: string | null;
    windowTitle: string | null;
    capturedAt: string;
    ocrText: string;
    /** Optional screenshot bytes (rides the same row; becomes viewable in Raw Data). */
    image?: Buffer | null;
    imageContentType?: string | null;
  },
): Promise<void> {
  const s = validIdent(schema);
  await pool.query(
    `insert into ${s}.pending_ocr (hostname, app, window_title, captured_at, ocr_text, image, image_content_type)
     values ($1, $2, $3, $4::timestamptz, $5, $6, $7)`,
    [x.hostname, x.app, x.windowTitle, x.capturedAt, x.ocrText, x.image ?? null, x.image ? (x.imageContentType ?? 'image/png') : null],
  );
}

/**
 * Turn a host's staged OCR text into real screenshot rows: for each pending row,
 * find that person's interval whose window covers the capture time (same app), and
 * write an OCR-only screenshot the resolver's OCR pass can read. Called at the end
 * of each token ingest, so an email OCR'd at T attaches once the interval covering
 * T is synced (<=10 min). Matched rows are consumed; stale rows (>12h, never
 * matched — the window closed before an interval formed) are purged. Best-effort:
 * never blocks the ingest itself. Returns how many were attached.
 */
export async function attachPendingOcr(pool: pg.Pool, schema: string, host: string): Promise<number> {
  const s = validIdent(schema);
  const res = await pool.query(
    `with matched as (
       select p.id as pending_id, i.id as interval_id, p.ocr_text, p.app, p.window_title, p.captured_at,
              p.image, p.image_content_type
         from ${s}.pending_ocr p
         join lateral (
           select i2.id, i2.start_ts
             from ${s}.intervals i2
            where i2.hostname = p.hostname
              and lower(coalesce(i2.app, '')) = lower(coalesce(p.app, ''))
              and p.captured_at >= i2.start_ts - interval '1 minute'
              and p.captured_at <  i2.end_ts   + interval '2 minutes'
            order by abs(extract(epoch from (i2.start_ts - p.captured_at)))
            limit 1
         ) i on true
        where p.hostname = $1
          and not exists (
            select 1 from ${s}.screenshots sc
             where sc.interval_id = i.id and sc.ocr_status = 'done' and sc.status <> 'deleted'
          )
     ),
     ins as (
       insert into ${s}.screenshots
         (interval_id, status, storage_kind, ocr_status, ocr_text, ocr_ran_at, app, window_title, captured_at)
       select interval_id, 'available', 'none', 'done', ocr_text, now(), app, window_title, captured_at from matched
       returning id, interval_id, captured_at
     ),
     img as (
       -- Carry the image (when the agent sent one) onto the new screenshot row,
       -- so the dashboard can display it. Joined by interval+capture time.
       insert into ${s}.screenshot_images (screenshot_id, content_type, bytes)
       select ins.id, coalesce(m.image_content_type, 'image/png'), m.image
         from ins
         join matched m on m.interval_id = ins.interval_id and m.captured_at = ins.captured_at
        where m.image is not null
       on conflict (screenshot_id) do nothing
     ),
     del as (
       delete from ${s}.pending_ocr where id in (select pending_id from matched)
     )
     select count(*)::int as attached from ins`,
    [host],
  );
  await pool.query(
    `delete from ${s}.pending_ocr where hostname = $1 and created_at < now() - interval '12 hours'`,
    [host],
  );
  return (res.rows[0]?.attached as number) ?? 0;
}
