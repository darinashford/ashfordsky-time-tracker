import { NextResponse } from 'next/server';
import { auth } from '@/auth';

// Auth is "configured" once the Entra client id is present. Until then the site
// fails CLOSED (returns 503) so client data is never exposed by an unconfigured
// deploy. Set DASHBOARD_PUBLIC=true to deliberately run with no auth (local dev).
const CONFIGURED = !!process.env.AUTH_MICROSOFT_ENTRA_ID_ID;
const PUBLIC = process.env.DASHBOARD_PUBLIC === 'true';

const protect = auth((req) => {
  if (!req.auth) {
    const signInUrl = new URL('/api/auth/signin', req.nextUrl.origin);
    signInUrl.searchParams.set('callbackUrl', req.nextUrl.href);
    return NextResponse.redirect(signInUrl);
  }
  return NextResponse.next();
});

const blocked = () =>
  new NextResponse(
    "Ashford Sky Time Tracker — Microsoft 365 sign-in isn't configured yet. " +
      'Set AUTH_SECRET and AUTH_MICROSOFT_ENTRA_ID_ID / _SECRET / _ISSUER to enable login ' +
      '(or DASHBOARD_PUBLIC=true to run without auth).',
    { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } },
  );

const passthrough = () => NextResponse.next();

export default (PUBLIC ? passthrough : CONFIGURED ? protect : blocked);

export const config = {
  // Protect every route except the auth endpoints, the token-authed ingest API,
  // and static assets. /api/ingest authenticates with a per-person Bearer token,
  // not the M365 session, so it must bypass the login wall.
  matcher: ['/((?!api/auth|api/ingest|_next/static|_next/image|favicon.ico).*)'],
};
