// Token-mode screenshot loop for a teammate's machine. Mirrors what the owner's
// sidecar does (read the current email window, OCR it so the resolver can identify
// the client from the sender on screen) — but holds NO database credentials. It
// captures + OCRs LOCALLY and POSTs only the extracted text to /api/ingest/ocr
// with the person's token. The image never leaves the machine. Runs every ~2 min.
//
// Env (same .env the sync agent uses):
//   INGEST_URL   = https://<dashboard>/api/ingest   (OCR endpoint derived from it)
//   INGEST_TOKEN = ttk_...
//   ACTIVITYWATCH_URL (optional, default http://localhost:5600)
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import dotenv from 'dotenv';
import { categorizeActivity, isEmailContext, loadConfig, normalizeText, parseHost } from '@tt/shared';
import { createCapturer } from './capture';
import { createOcrAdapter } from './ocr';

for (const p of ['.env', '../.env', '../../.env', '../../../.env']) {
  const f = resolve(process.cwd(), p);
  if (existsSync(f)) {
    dotenv.config({ path: f });
    break;
  }
}

interface AwBucket { type?: string }
interface AwEvent { timestamp: string; duration: number; data: Record<string, unknown> }

async function awGet<T>(baseUrl: string, path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`);
  if (!res.ok) throw new Error(`ActivityWatch ${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** The window focused right now (most recent window event), its URL if a browser,
 *  and whether the machine is idle — read straight from ActivityWatch. */
async function currentWindow(
  baseUrl: string,
): Promise<{ app: string | null; title: string | null; url: string | null; afk: boolean } | null> {
  const buckets = await awGet<Record<string, AwBucket>>(baseUrl, '/api/0/buckets/');
  const since = new Date(Date.now() - 180_000).toISOString();
  const until = new Date(Date.now() + 1000).toISOString();
  const latest = async (id: string): Promise<AwEvent | null> => {
    const evs = await awGet<AwEvent[]>(
      baseUrl,
      `/api/0/buckets/${encodeURIComponent(id)}/events?start=${encodeURIComponent(since)}&end=${encodeURIComponent(until)}&limit=1000`,
    );
    return evs.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0] ?? null;
  };
  let win: AwEvent | null = null;
  let web: AwEvent | null = null;
  let afk: AwEvent | null = null;
  for (const [id, b] of Object.entries(buckets)) {
    const type = (b.type ?? '').toLowerCase();
    const lid = id.toLowerCase();
    const ev = await latest(id).catch(() => null);
    if (!ev) continue;
    const newer = (cur: AwEvent | null) => (!cur || Date.parse(ev.timestamp) > Date.parse(cur.timestamp) ? ev : cur);
    if (type.includes('afk') || lid.includes('afk')) afk = newer(afk);
    else if (type.includes('web') || lid.includes('web')) web = newer(web);
    else if (type.includes('window') || lid.includes('window') || lid.includes('currentwindow')) win = newer(win);
  }
  if (!win) return null;
  return {
    app: (win.data.app as string) ?? null,
    title: (win.data.title as string) ?? null,
    url: web ? ((web.data.url as string) ?? null) : null,
    afk: afk ? afk.data.status === 'afk' : false,
  };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const ingestUrl = process.env.INGEST_URL;
  const token = process.env.INGEST_TOKEN;
  if (!ingestUrl || !token) {
    console.error('[shot-agent] set INGEST_URL and INGEST_TOKEN in .env.');
    process.exit(1);
  }
  const ocrUrl = /\/ingest\/?$/.test(ingestUrl) ? ingestUrl.replace(/\/ingest\/?$/, '/ingest/ocr') : `${ingestUrl}/ocr`;

  const cur = await currentWindow(cfg.activitywatchUrl);
  if (!cur || cur.afk) {
    console.log('[shot-agent] no active window (or idle); nothing to OCR.');
    return;
  }
  // Capture any WORK window, not just email — the server-side resolver reads
  // client emails AND names off the screen now. Known non-billable contexts
  // (social, music, entertainment, personal, system chrome) are never captured.
  const isEmail = isEmailContext(cur.app, cur.url);
  const cat = categorizeActivity({
    appNorm: normalizeText(cur.app),
    host: parseHost(cur.url),
    title: cur.title,
    url: cur.url,
  });
  if (!isEmail && cat?.tier === 'hard') {
    console.log(`[shot-agent] current window is ${cat.key} (non-billable); skip.`);
    return;
  }

  // Don't re-capture the same email over and over: skip if the focused email
  // window is unchanged since the last run.
  const marker = join(tmpdir(), 'tt-last-ocr-window.txt');
  const key = `${normalizeText(cur.app)}|${normalizeText(cur.title)}`;
  const prev = await readFile(marker, 'utf8').catch(() => '');
  if (prev.trim() === key) {
    console.log('[shot-agent] same email window as last run; skip.');
    return;
  }

  const capturer = createCapturer();
  if (capturer.name === 'noop') {
    console.log(`[shot-agent] no capturer for ${process.platform}; skip.`);
    return;
  }
  const capturedAt = new Date().toISOString();
  const shot = await capturer.capture();
  if (!shot) {
    console.log('[shot-agent] capture returned no image; skip.');
    return;
  }
  const ocr = createOcrAdapter();
  const recognized = await ocr.recognize(shot.buffer);
  const text = (recognized?.text ?? '').trim();
  await writeFile(marker, key, 'utf8').catch(() => undefined);
  if (!text) {
    console.log('[shot-agent] captured (no OCR text); nothing to send.');
    return;
  }

  // Send the image too (base64, size-capped) so the dashboard can display it.
  // Over the cap we still send the OCR text — attribution never depends on the image.
  const MAX_IMAGE_BYTES = 2_500_000;
  const imageBase64 = shot.buffer.length <= MAX_IMAGE_BYTES ? shot.buffer.toString('base64') : undefined;
  const res = await fetch(ocrUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      app: cur.app,
      windowTitle: cur.title,
      capturedAt,
      ocrText: text,
      ...(imageBase64 ? { imageBase64, imageContentType: 'image/png' } : {}),
    }),
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`[shot-agent] OCR ingest failed (HTTP ${res.status}): ${body}`);
    process.exit(1);
  }
  console.log(`[shot-agent] sent ${text.length} chars of OCR for the current email window; server: ${body}`);
}

main().catch((err) => {
  console.error('[shot-agent] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
