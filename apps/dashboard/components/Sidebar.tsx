'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Left navigation. Each section owns a route prefix; "today" as the date param
// falls back to the current local day server-side, so these links always land
// on the live day without the sidebar needing to know the date.
const NAV = [
  { href: '/day/today', prefix: '/day', ico: '📅', label: 'Today' },
  { href: '/range/week/today', prefix: '/range', ico: '📊', label: 'Reporting' },
  { href: '/raw/today', prefix: '/raw', ico: '🗂️', label: 'Raw Data' },
  { href: '/settings', prefix: '/settings', ico: '⚙️', label: 'Settings' },
  { href: '/how', prefix: '/how', ico: '❓', label: 'How this works' },
];

export function Sidebar({ showSettings = true }: { showSettings?: boolean }) {
  const pathname = usePathname() ?? '';
  const nav = showSettings ? NAV : NAV.filter((n) => n.prefix !== '/settings');
  return (
    <nav className="sidebar">
      <div className="brand">
        <div className="b1">Ashford Sky</div>
        <div className="b2">Time Tracker</div>
      </div>
      {nav.map((n) => (
        <Link key={n.prefix} className={`navlink${pathname.startsWith(n.prefix) ? ' active' : ''}`} href={n.href}>
          <span className="ico">{n.ico}</span>
          {n.label}
        </Link>
      ))}
      <div className="spacer" />
    </nav>
  );
}
