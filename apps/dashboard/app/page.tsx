import { redirect } from 'next/navigation';
import { loadConfig, localDate } from '@tt/shared';
import { ensureEnv } from '../lib/env';

export default function Home() {
  ensureEnv();
  const cfg = loadConfig();
  redirect(`/day/${localDate(new Date().toISOString(), cfg.timezone)}`);
}
