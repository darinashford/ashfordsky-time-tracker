import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Liveness probe for Railway's healthcheck. Deliberately touches NOTHING — no
 * database, no auth — so a busy pooler can never make the platform think the
 * app is down and yank it out of rotation. "Up" here means exactly one thing:
 * the Next server is accepting requests.
 */
export function GET(): Response {
  return NextResponse.json({ ok: true });
}
