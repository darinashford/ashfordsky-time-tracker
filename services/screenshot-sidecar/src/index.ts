import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { assertDatabaseUrl, loadConfig, localDate } from '@tt/shared';
import {
  attachStoredScreenshot,
  closePool,
  countNeededScreenshots,
  getOrCreateScreenshotId,
  getPool,
  listWindowsNeedingOcr,
  listExpiredScreenshots,
  purgeExpiredScreenshotImages,
  setScreenshotOcr,
  setScreenshotStatus,
  softDeleteScreenshot,
  storeScreenshotImage,
} from '@tt/db';
import { createCapturer } from './capture';
import { createOcrAdapter } from './ocr';
import { createStorageAdapter } from './storage';

for (const p of ['.env', '../.env', '../../.env', '../../../.env']) {
  const f = resolve(process.cwd(), p);
  if (existsSync(f)) {
    dotenv.config({ path: f });
    break;
  }
}

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main(): Promise<void> {
  const cfg = loadConfig();
  assertDatabaseUrl(cfg);
  const pool = getPool(cfg.databaseUrl);
  const storage = createStorageAdapter('local', cfg.screenshotDir);

  try {
    // 1) Retention purge — always runs, even when capture is disabled.
    const expired = await listExpiredScreenshots(pool, cfg.schema, cfg.screenshotRetentionDays);
    for (const row of expired) {
      if (row.storageKind === 'local' && row.storagePath) await storage.remove(row.storagePath);
      await softDeleteScreenshot(pool, cfg.schema, row.id);
    }
    if (expired.length) console.log(`[sidecar] purged ${expired.length} expired screenshots`);
    const purgedImages = await purgeExpiredScreenshotImages(pool, cfg.schema, cfg.screenshotRetentionDays);
    if (purgedImages) console.log(`[sidecar] purged ${purgedImages} expired screenshot images`);

    const pending = await countNeededScreenshots(pool, cfg.schema);

    if (!cfg.screenshotsEnabled) {
      console.log(
        `[sidecar] capture is DISABLED (SCREENSHOTS_ENABLED=false). ${pending} interval(s) flagged 'needed'. ` +
          `Enable in .env to capture conditional evidence.`,
      );
      return;
    }

    const capturer = createCapturer();
    if (capturer.name === 'noop') {
      console.log(`[sidecar] no capturer for platform ${process.platform}; skipping. ${pending} pending.`);
      return;
    }

    const max = Number(arg('--max') ?? '3');
    // Screen OCR: find the window you're in right now (active within the last few
    // minutes) that hasn't been OCR'd and could use it — an email window, or any
    // block whose attribution is weak (unresolved / needs-review / carried over).
    // Capture runs before resolve on purpose, so what's read off the screen can
    // attribute the block the SAME cycle.
    const targets = await listWindowsNeedingOcr(pool, cfg.schema, 200, max);
    if (targets.length === 0) {
      console.log('[sidecar] no current window needs OCR.');
      return;
    }

    const ocr = createOcrAdapter();
    const dateFolder = localDate(new Date().toISOString(), cfg.timezone);

    // Capture the screen ONCE (it shows the email on screen now) and attribute it
    // to the most-recent email window. Older un-OCR'd windows aren't on screen, so
    // they get picked up on a later run while they're current.
    const row = targets[0]!;
    const shotId = await getOrCreateScreenshotId(pool, cfg.schema, {
      intervalId: row.intervalId,
      status: 'needed',
      reason: 'Screen OCR: weak attribution — read the client off the screen',
      app: row.app,
      windowTitle: row.windowTitle,
    });
    try {
      const shot = await capturer.capture();
      if (!shot) {
        await setScreenshotStatus(pool, cfg.schema, shotId, 'blocked', 'Capture returned no image');
        return;
      }
      const stored = await storage.store(shot.buffer, { width: shot.width, height: shot.height, dateFolder });
      await attachStoredScreenshot(pool, cfg.schema, shotId, stored, new Date().toISOString());
      // Also upload the bytes so the dashboard can display the image (size-capped
      // inside; the local file + OCR path is unaffected when this skips).
      const uploaded = await storeScreenshotImage(pool, cfg.schema, shotId, shot.buffer, 'image/png');
      if (!uploaded) console.log(`[sidecar] image too large to upload (${shot.buffer.length}b); OCR only`);
      const recognized = await ocr.recognize(shot.buffer);
      if (recognized && recognized.text.trim()) {
        await setScreenshotOcr(pool, cfg.schema, shotId, recognized.text, 'done');
        console.log(`[sidecar] captured + OCR'd ${recognized.text.length} chars for ${row.intervalId}`);
      } else {
        await setScreenshotOcr(pool, cfg.schema, shotId, '', 'failed');
        console.log(`[sidecar] captured (no OCR text) for ${row.intervalId}`);
      }
    } catch (err) {
      await setScreenshotStatus(
        pool,
        cfg.schema,
        shotId,
        'blocked',
        `Capture failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error('[sidecar] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
