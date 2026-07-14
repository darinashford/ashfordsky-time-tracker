import { NextResponse } from 'next/server';
import { resolveIngestToken, stagePendingOcr, touchIngestToken } from '@tt/db';
import { getDb } from '../../../../lib/db';

export const dynamic = 'force-dynamic';

/**
 * Token-authenticated OCR ingest for teammate machines. Their screenshot loop
 * captures + OCRs the current email window LOCALLY (the image never leaves their
 * machine) and POSTs only the extracted text here with its Bearer token. We stamp
 * the token's host and stage it; the next /api/ingest cycle attaches it to the
 * matching interval as a screenshot the resolver can read. No DB creds on their box.
 */
export async function POST(req: Request): Promise<Response> {
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!token) return NextResponse.json({ error: 'missing bearer token' }, { status: 401 });

  const { pool, schema } = getDb();
  const t = await resolveIngestToken(pool, schema, token);
  if (!t) return NextResponse.json({ error: 'invalid token' }, { status: 401 });

  let body: { app?: string | null; windowTitle?: string | null; capturedAt?: string; ocrText?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const ocrText = (body.ocrText ?? '').trim();
  const capturedAt = body.capturedAt;
  if (!ocrText) return NextResponse.json({ error: 'ocrText is required' }, { status: 400 });
  if (!capturedAt || Number.isNaN(Date.parse(capturedAt))) {
    return NextResponse.json({ error: 'valid capturedAt (ISO) is required' }, { status: 400 });
  }
  // Cap absurd payloads; a screen of text is well under this.
  const text = ocrText.slice(0, 100_000);

  await stagePendingOcr(pool, schema, {
    hostname: t.hostname,
    app: body.app ?? null,
    windowTitle: body.windowTitle ?? null,
    capturedAt,
    ocrText: text,
  });
  await touchIngestToken(pool, schema, t.id);
  return NextResponse.json({ ok: true, host: t.hostname, staged: text.length });
}
