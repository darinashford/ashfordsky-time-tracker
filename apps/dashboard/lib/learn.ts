// Shared, side-effect-free logic for what a "set client" reassignment can LEARN,
// used by both the server action (to create the rule) and the Raw Data picker
// (to preview it) so the two never disagree.

// Generic words that must NEVER become a "remember this" title rule on their own
// — they appear across many clients and would mis-attribute hundreds of blocks
// (this is exactly how "accounting"/"request" got wrongly pinned to one client).
// Only genuinely distinctive tokens (a client/brand/person name) should learn.
const LEARN_STOPWORDS = new Set([
  // apps / browser / OS chrome
  'inbox', 'google', 'chrome', 'microsoft', 'edge', 'outlook', 'gmail', 'mail', 'firefox',
  'window', 'untitled', 'settings', 'search', 'login', 'signin', 'home', 'page', 'portal',
  'krisp', 'zoom', 'teams', 'webex', 'slack', 'missive', 'quickbooks', 'intuit', 'excel',
  // accounting / tax / finance vocabulary
  'accounting', 'account', 'accounts', 'tax', 'taxes', 'return', 'returns', 'income',
  'invoice', 'invoices', 'billing', 'payroll', 'ledger', 'journal', 'entry', 'entries',
  'balance', 'sheet', 'sheets', 'profit', 'loss', 'statement', 'statements', 'financial',
  'financials', 'cents', 'reconciliation', 'recon', 'depreciation', 'asset', 'assets',
  'liability', 'liabilities', 'expense', 'expenses', 'revenue', 'deduction', 'deductions',
  'audit', 'engagement', 'planning', 'preparation', 'filing', 'extension', 'quarterly',
  'annual', 'monthly', 'individual', 'partnership', 'corporate', 'fixed', 'general',
  'workbook', 'summary', 'k1', 'w2', '1040', '1065', '1120',
  // email / comms
  'email', 'message', 'messages', 'thread', 'reply', 'forward', 'follow', 'followup',
  'update', 'updates', 'question', 'questions', 'discussion', 'meeting', 'call', 'calls',
  'chat', 'channel', 'notes', 'memo', 'agenda', 'sync', 'calendar', 'schedule',
  // project / task / doc vocabulary
  'project', 'projects', 'task', 'tasks', 'ticket', 'tickets', 'assignment', 'assignments',
  'review', 'tracker', 'dashboard', 'report', 'reports', 'status', 'workflow', 'center',
  'response', 'request', 'requests', 'document', 'documents', 'file', 'files', 'folder',
  'data', 'details', 'overview', 'results', 'list', 'lists',
  // generic business nouns/verbs
  'client', 'clients', 'customer', 'customers', 'company', 'companies', 'business',
  'holdings', 'holding', 'group', 'corp', 'entity', 'entities', 'parent', 'service',
  'services', 'support', 'purchase', 'order', 'orders', 'payment', 'payments', 'transfer',
  'working', 'other', 'misc', 'information', 'contact', 'contacts', 'form', 'forms',
  // common US state names (a place is not a client identifier)
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut',
  'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa',
  'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan',
  'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'hampshire',
  'jersey', 'mexico', 'york', 'carolina', 'dakota', 'ohio', 'oklahoma', 'oregon',
  'pennsylvania', 'rhode', 'island', 'tennessee', 'texas', 'utah', 'vermont', 'virginia',
  'washington', 'wisconsin', 'wyoming',
]);

// Shared platforms whose host identifies no single client — never learn a host rule there.
const SHARED_HOSTS = [
  // The firm's OWN sites: the tracker, the review tool, the profitability app,
  // the brain. These serve every client, so a host rule here mis-bills all of it
  // to one client (this is how time/notes.ashfordsky.com got pinned to Bullhorn).
  'ashfordsky.com',
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

/**
 * Why an existing rule looks over-broad, or null if it looks sound. Same lists
 * as the learner, so the audit view flags exactly what the learner now refuses
 * to create: a firm/shared host, or a single common word. Older rules made
 * before those guards still get surfaced here for a human to disable.
 */
export function ruleRisk(ruleType: string, pattern: string): string | null {
  const p = (pattern ?? '').trim().toLowerCase();
  if (!p) return null;
  if (ruleType === 'url_host') {
    if (SHARED_HOSTS.some((s) => p === s || p.endsWith('.' + s))) {
      return 'a firm or shared site — it serves every client, not one';
    }
    return null;
  }
  if (ruleType === 'title_pattern') {
    const tokens = p.split(/\s+/).filter(Boolean);
    if (tokens.length === 1 && (p.length < 5 || LEARN_STOPWORDS.has(p))) {
      return 'a single common word — it matches many unrelated windows';
    }
  }
  return null;
}
