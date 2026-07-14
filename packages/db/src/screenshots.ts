import type pg from 'pg';
import type { OcrStatus, ScreenshotPolicy, ScreenshotStatus, StoredScreenshot } from '@tt/shared';
import { validIdent } from './pool';

export async function loadActivePolicies(
  pool: pg.Pool,
  schema: string,
): Promise<ScreenshotPolicy[]> {
  const s = validIdent(schema);
  const res = await pool.query(
    `select id, name, enabled,
            only_below_confidence::float    as "onlyBelowConfidence",
            min_stable_seconds              as "minStableSeconds",
            capture_interval_seconds        as "captureIntervalSeconds",
            retention_days                  as "retentionDays",
            applies_scope                   as "appliesScope",
            applies_pattern                 as "appliesPattern"
       from ${s}.screenshot_policies
      where enabled = true`,
  );
  return res.rows as ScreenshotPolicy[];
}

export async function recordScreenshotIntent(
  pool: pg.Pool,
  schema: string,
  x: {
    intervalId: string | null;
    status: ScreenshotStatus;
    reason?: string | null;
    app?: string | null;
    windowTitle?: string | null;
  },
): Promise<string> {
  const s = validIdent(schema);
  const res = await pool.query(
    `insert into ${s}.screenshots (interval_id, status, reason, app, window_title)
     values ($1,$2,$3,$4,$5) returning id`,
    [x.intervalId, x.status, x.reason ?? null, x.app ?? null, x.windowTitle ?? null],
  );
  return res.rows[0].id as string;
}

/** Record a capture intent only if the interval has no active screenshot yet. */
export async function ensureScreenshotIntent(
  pool: pg.Pool,
  schema: string,
  x: {
    intervalId: string;
    status: ScreenshotStatus;
    reason?: string | null;
    app?: string | null;
    windowTitle?: string | null;
  },
): Promise<string | null> {
  const s = validIdent(schema);
  const existing = await pool.query(
    `select id from ${s}.screenshots where interval_id = $1 and status <> 'deleted' limit 1`,
    [x.intervalId],
  );
  if (existing.rows.length) return null;
  return recordScreenshotIntent(pool, schema, x);
}

/** Existing (non-deleted) screenshot id for an interval, or create one. */
export async function getOrCreateScreenshotId(
  pool: pg.Pool,
  schema: string,
  x: { intervalId: string; status: ScreenshotStatus; reason?: string | null; app?: string | null; windowTitle?: string | null },
): Promise<string> {
  const s = validIdent(schema);
  const existing = await pool.query(
    `select id from ${s}.screenshots where interval_id = $1 and status <> 'deleted' order by created_at desc limit 1`,
    [x.intervalId],
  );
  if (existing.rows.length) return existing.rows[0].id as string;
  return recordScreenshotIntent(pool, schema, x);
}

/**
 * Recent email-app windows with no OCR yet — the sidecar's inbox target. Unlike
 * listCaptureTargets, this does NOT require a resolve-created 'needed' flag
 * (capture runs before resolve, so that flag never fired), so it reliably picks
 * up the email window you're in right now. Newest first.
 */
export async function listEmailWindowsNeedingOcr(
  pool: pg.Pool,
  schema: string,
  maxAgeSeconds: number,
  limit = 5,
): Promise<Array<{ intervalId: string; app: string | null; windowTitle: string | null }>> {
  const s = validIdent(schema);
  const res = await pool.query(
    `select i.id as "intervalId", i.app, i.window_title as "windowTitle"
       from ${s}.intervals i
      where i.is_afk = false
        and i.end_ts > now() - ($1 || ' seconds')::interval
        and (lower(coalesce(i.app, '')) like '%missive%'
          or lower(coalesce(i.app, '')) like '%outlook%'
          or lower(coalesce(i.app, '')) like '%olk%')
        and not exists (
          select 1 from ${s}.screenshots sc
           where sc.interval_id = i.id and sc.ocr_status = 'done'
        )
      order by i.end_ts desc
      limit $2`,
    [String(maxAgeSeconds), limit],
  );
  return res.rows as Array<{ intervalId: string; app: string | null; windowTitle: string | null }>;
}

export async function attachStoredScreenshot(
  pool: pg.Pool,
  schema: string,
  id: string,
  stored: StoredScreenshot,
  capturedAt: string,
): Promise<void> {
  const s = validIdent(schema);
  await pool.query(
    `update ${s}.screenshots set
       status='available', storage_kind=$2, storage_path=$3, file_url=$4, sha256=$5,
       bytes=$6, width=$7, height=$8, captured_at=$9::timestamptz
     where id=$1`,
    [
      id, stored.storageKind, stored.storagePath, stored.fileUrl ?? null, stored.sha256,
      stored.bytes, stored.width ?? null, stored.height ?? null, capturedAt,
    ],
  );
}

export async function setScreenshotStatus(
  pool: pg.Pool,
  schema: string,
  id: string,
  status: ScreenshotStatus,
  reason?: string | null,
): Promise<void> {
  const s = validIdent(schema);
  await pool.query(`update ${s}.screenshots set status=$2, reason=coalesce($3, reason) where id=$1`, [
    id,
    status,
    reason ?? null,
  ]);
}

export async function softDeleteScreenshot(
  pool: pg.Pool,
  schema: string,
  id: string,
): Promise<{ storagePath: string | null; storageKind: string } | null> {
  const s = validIdent(schema);
  const res = await pool.query(
    `update ${s}.screenshots set status='deleted', deleted_at=now()
      where id=$1
      returning storage_path as "storagePath", storage_kind as "storageKind"`,
    [id],
  );
  return res.rows[0] ?? null;
}

/** Screenshots flagged 'needed' by the resolver, newest first. */
export async function listNeededScreenshots(
  pool: pg.Pool,
  schema: string,
  limit = 10,
): Promise<Array<{ id: string; intervalId: string | null; app: string | null; windowTitle: string | null }>> {
  const s = validIdent(schema);
  const res = await pool.query(
    `select id, interval_id as "intervalId", app, window_title as "windowTitle"
       from ${s}.screenshots
      where status = 'needed'
      order by created_at desc
      limit $1`,
    [limit],
  );
  return res.rows as Array<{ id: string; intervalId: string | null; app: string | null; windowTitle: string | null }>;
}

/** Write OCR text + status back to a screenshot. */
export async function setScreenshotOcr(
  pool: pg.Pool,
  schema: string,
  id: string,
  text: string,
  status: OcrStatus = 'done',
): Promise<void> {
  const s = validIdent(schema);
  await pool.query(`update ${s}.screenshots set ocr_text = $2, ocr_status = $3 where id = $1`, [id, text, status]);
}

/**
 * Capture targets for the sidecar: screenshots flagged 'needed' whose interval
 * ended within maxAgeSeconds (so "capture now" still reflects that activity).
 * Newest first. The sidecar additionally gates to email apps for the inbox case.
 */
export async function listCaptureTargets(
  pool: pg.Pool,
  schema: string,
  maxAgeSeconds: number,
  limit = 5,
): Promise<Array<{ id: string; intervalId: string | null; app: string | null; windowTitle: string | null }>> {
  const s = validIdent(schema);
  const res = await pool.query(
    `select sc.id, sc.interval_id as "intervalId", sc.app, sc.window_title as "windowTitle"
       from ${s}.screenshots sc
       join ${s}.intervals i on i.id = sc.interval_id
      where sc.status = 'needed'
        and i.end_ts > now() - ($1 || ' seconds')::interval
      order by i.end_ts desc
      limit $2`,
    [String(maxAgeSeconds), limit],
  );
  return res.rows as Array<{ id: string; intervalId: string | null; app: string | null; windowTitle: string | null }>;
}

/** OCR text keyed by interval id, for a local day (drives the OCR resolver). */
export async function getOcrTextByInterval(
  pool: pg.Pool,
  schema: string,
  day: string,
  tz: string,
): Promise<Map<string, string>> {
  const s = validIdent(schema);
  const res = await pool.query(
    `select sc.interval_id as "intervalId", sc.ocr_text as "ocrText"
       from ${s}.screenshots sc
       join ${s}.intervals i on i.id = sc.interval_id
      where sc.ocr_text is not null and sc.status <> 'deleted'
        and (i.start_ts at time zone $2)::date = $1::date`,
    [day, tz],
  );
  const m = new Map<string, string>();
  for (const r of res.rows as Array<{ intervalId: string | null; ocrText: string | null }>) {
    if (r.intervalId && r.ocrText) m.set(r.intervalId, r.ocrText);
  }
  return m;
}

export async function countNeededScreenshots(pool: pg.Pool, schema: string): Promise<number> {
  const s = validIdent(schema);
  const res = await pool.query(`select count(*)::int as n from ${s}.screenshots where status = 'needed'`);
  return (res.rows[0]?.n as number) ?? 0;
}

/** Available screenshots whose retention window has elapsed (for the sidecar). */
export async function listExpiredScreenshots(
  pool: pg.Pool,
  schema: string,
  retentionDays: number,
): Promise<Array<{ id: string; storagePath: string | null; storageKind: string }>> {
  const s = validIdent(schema);
  const res = await pool.query(
    `select id, storage_path as "storagePath", storage_kind as "storageKind"
       from ${s}.screenshots
      where status = 'available'
        and captured_at < now() - ($1 || ' days')::interval`,
    [String(retentionDays)],
  );
  return res.rows as Array<{ id: string; storagePath: string | null; storageKind: string }>;
}
