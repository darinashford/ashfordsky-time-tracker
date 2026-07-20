'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Left navigation. Each section owns a route prefix; "today" as the date param
// falls back to the current local day server-side, so these links always land
// on the live day without the sidebar needing to know the date.
const NAV = [
  { href: '/day/today', prefix: '/day', ico: '📅', label: 'Today', ownerOnly: false },
  { href: '/range/week/today', prefix: '/range', ico: '📊', label: 'Reporting', ownerOnly: false },
  { href: '/raw/today', prefix: '/raw', ico: '🗂️', label: 'Raw Data', ownerOnly: false },
  { href: '/rules', prefix: '/rules', ico: '📏', label: 'Manual Rules', ownerOnly: false },
  { href: '/settings', prefix: '/settings', ico: '⚙️', label: 'Settings', ownerOnly: true },
  { href: '/how', prefix: '/how', ico: '❓', label: 'How this works', ownerOnly: false },
];

// showSettings doubles as the "is owner" flag (owner-only items are hidden for
// teammates). Only Settings (tokens/people) is owner-only now; Manual Rules is
// firm-wide but every staff member can view and toggle rules.
export function Sidebar({ showSettings = true }: { showSettings?: boolean }) {
  const pathname = usePathname() ?? '';
  const nav = showSettings ? NAV : NAV.filter((n) => !n.ownerOnly);
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
