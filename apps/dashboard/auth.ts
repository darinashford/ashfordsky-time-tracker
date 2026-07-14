import NextAuth from 'next-auth';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';

// Only firm accounts may sign in. The single-tenant issuer (below) already limits
// login to the Ashford Sky Entra tenant; this is a second, explicit gate on the
// email domain so a guest/personal account in the tenant still can't get in.
const allowedDomain = (process.env.AUTH_ALLOWED_DOMAIN ?? 'ashfordsky.com').toLowerCase();

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Railway terminates TLS at a proxy; trust the forwarded host for callback URLs.
  trustHost: true,
  providers: [
    MicrosoftEntraID({
      clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID,
      clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
      // Single-tenant issuer: https://login.microsoftonline.com/<TENANT_ID>/v2.0
      issuer: process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
    }),
  ],
  callbacks: {
    async signIn({ profile }) {
      const p = profile as
        | { email?: string; preferred_username?: string; upn?: string }
        | undefined;
      const email = (p?.email ?? p?.preferred_username ?? p?.upn ?? '').toLowerCase();
      return email.endsWith('@' + allowedDomain);
    },
  },
});
