// Shared, side-effect-free logic for what a "set client" reassignment can LEARN,
// used by both the server action (to create the rule) and the Raw Data picker
// (to preview it) so the two never disagree.

// Generic words that shouldn't become a "remember this" rule on their own.
const LEARN_STOPWORDS = new Set([
  'inbox', 'google', 'chrome', 'microsoft', 'edge', 'outlook', 'gmail', 'mail',
  'dashboard', 'invoice', 'invoices', 'return', 'returns', 'workbook', 'summary',
  'report', 'reports', 'client', 'clients', 'tasks', 'excel', 'sheet', 'sheets',
  'income', 'individual', 'partnership', 'parent', 'company', 'entity', 'entities',
  'review', 'note', 'tracker', 'financial', 'cents', 'quickbooks', 'window', 'untitled',
  'meeting', 'calendar', 'search', 'settings', 'krisp', 'zoom', 'teams', 'webex',
]);

// Shared platforms whose host identifies no single client — never learn a host rule there.
const SHARED_HOSTS = [
  'missiveapp.com', 'mail.google.com', 'google.com', 'accounts.google.com', 'drive.google.com',
  'docs.google.com', 'outlook.office.com', 'outlook.office365.com', 'gmail.com', 'proton.me',
  'financial-cents.com', 'intuit.com', 'qbo.intuit.com', 'accounts.intuit.com', 'chatgpt.com',
  'claude.ai', 'slack.com', 'notion.so', 'boldsign.com', 'onespan.com', 'gusto.com',
];

export type LearnSignal = { kind: 'host'; value: string } | { kind: 'title'; value: string };

/**
 * The strongest generalizable signal on a block, or null when there's nothing
 * safe to learn (a plain call, a shared inbox, a generic title) — in which case
 * a reassignment only fixes that block, no rule.
 */
export function deriveLearn(url: string | null, title: string | null): LearnSignal | null {
  let host = '';
  try {
    if (url) host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    /* not a URL */
  }
  if (host && !SHARED_HOSTS.some((s) => host === s || host.endsWith('.' + s))) {
    return { kind: 'host', value: host };
  }
  const token = ((title ?? '').toLowerCase().match(/[a-z]{6,}/g) ?? []).find((w) => !LEARN_STOPWORDS.has(w));
  if (token) return { kind: 'title', value: token };
  return null;
}

/** Human phrase for what will be remembered, or null when nothing generalizes. */
export function describeLearn(url: string | null, title: string | null): string | null {
  const d = deriveLearn(url, title);
  if (!d) return null;
  return d.kind === 'host' ? `the website ${d.value}` : `windows with “${d.value}” in the title`;
}
