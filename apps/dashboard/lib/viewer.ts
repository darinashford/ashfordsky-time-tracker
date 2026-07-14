import { auth } from '@/auth';

// Owners manage Settings (tokens, people). Everyone else is a normal viewer.
// Comma-separated env override; defaults to the firm owner.
const OWNERS = (process.env.OWNER_EMAILS ?? 'darin@ashfordsky.com')
  .toLowerCase()
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export interface ViewerScope {
  email: string | null;
  isOwner: boolean;
  /**
   * The signed-in person's own machine. Convention: a person's short id (their
   * hostname on every synced block) IS their email name —
   * alex@ashfordsky.com -> "alex". Per-tab policy (Darin's):
   * Today is ALWAYS this host; Raw Data defaults to it (switchable to anyone);
   * Reporting defaults to everyone. Null when auth is off (local dev).
   */
  selfHost: string | null;
}

export async function getViewerScope(): Promise<ViewerScope> {
  // Auth disabled (local dev): unscoped, exactly as before.
  if (!process.env.AUTH_MICROSOFT_ENTRA_ID_ID) return { email: null, isOwner: true, selfHost: null };
  const session = await auth();
  const email = (session?.user?.email ?? '').toLowerCase().trim() || null;
  return {
    email,
    isOwner: !!email && OWNERS.includes(email),
    selfHost: email ? email.split('@')[0]! : null,
  };
}
