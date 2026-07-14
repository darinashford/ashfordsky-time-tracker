import type { ReactNode } from 'react';
import { auth, signOut } from '@/auth';
import { Sidebar } from '../components/Sidebar';
import { getViewerScope } from '../lib/viewer';
import './globals.css';

export const metadata = {
  title: 'Ashford Sky — Time Tracker',
  description: 'Client time attribution review',
};

const AUTH_ON = !!process.env.AUTH_MICROSOFT_ENTRA_ID_ID;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = AUTH_ON ? await auth() : null;
  const scope = await getViewerScope();
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <Sidebar showSettings={scope.isOwner} />
          <main className="main">
            <div className="main-inner">
              {session?.user && (
                <div className="authbar">
                  <span className="muted small">{session.user.email ?? session.user.name}</span>
                  <form
                    action={async () => {
                      'use server';
                      await signOut({ redirectTo: '/' });
                    }}
                  >
                    <button className="btn" type="submit">
                      Sign out
                    </button>
                  </form>
                </div>
              )}
              {children}
            </div>
          </main>
        </div>
      </body>
    </html>
  );
}
