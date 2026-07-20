import { NextResponse } from 'next/server';
import { getScreenshotImage } from '@tt/db';
import { getDb } from '../../../../lib/db';
import { getViewerScope } from '../../../../lib/viewer';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Serve a screenshot's image bytes to the signed-in dashboard. Access follows
 * the viewing policy: the owner can see anyone's; everyone else only their own
 * machine's captures. Images are immutable once stored, so cache privately.
 */
export async function GET(_req: Request, { params }: { params: { id: string } }): Promise<Response> {
  const id = params.id;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 });

  const scope = await getViewerScope();
  // With auth on, an unauthenticated request has no email — middleware normally
  // blocks it first, but don't rely on that for image bytes.
  if (process.env.AUTH_MICROSOFT_ENTRA_ID_ID && !scope.email) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { pool, schema } = getDb();
  const img = await getScreenshotImage(pool, schema, id);
  if (!img) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!scope.isOwner && scope.selfHost && img.hostname && img.hostname !== scope.selfHost) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  return new Response(new Uint8Array(img.bytes), {
    headers: {
      'content-type': img.contentType || 'image/png',
      'cache-control': 'private, max-age=3600',
    },
  });
}
