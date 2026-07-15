// Pure text-normalization + fuzzy-matching primitives used by the resolvers.
// Everything here is deterministic and dependency-free so it is easy to unit test.

export function stripAccents(s: string): string {
  // Decompose, then drop combining diacritical marks (ASCII-safe property escape).
  return s.normalize('NFKD').replace(/\p{Diacritic}/gu, '');
}

/** Lowercase, strip accents/punctuation, collapse whitespace. */
export function normalizeText(s: string | null | undefined): string {
  if (!s) return '';
  return stripAccents(String(s))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bare registrable host: strips protocol, `www.`, path, query, trailing dots. */
export function normalizeDomain(s: string | null | undefined): string {
  if (!s) return '';
  let d = String(s).trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '');
  d = d.split('/')[0]!.split('?')[0]!.split('#')[0]!;
  d = d.replace(/[.]+$/, '');
  return d;
}

export function emailDomain(email: string | null | undefined): string {
  if (!email) return '';
  const at = String(email).toLowerCase().trim();
  const idx = at.lastIndexOf('@');
  return idx >= 0 ? normalizeDomain(at.slice(idx + 1)) : '';
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** Pull all email addresses out of free text (e.g. a Missive/Outlook title). */
export function extractEmails(text: string | null | undefined): string[] {
  if (!text) return [];
  const m = String(text).match(EMAIL_RE);
  return m ? Array.from(new Set(m.map((e) => e.toLowerCase()))) : [];
}

/** Best-effort host extraction from a URL or bare host string. */
export function parseHost(url: string | null | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url.includes('://') ? url : `https://${url}`);
    return normalizeDomain(u.hostname);
  } catch {
    return normalizeDomain(url);
  }
}

// Common legal/organizational suffixes that add noise to name matching.
export const COMPANY_SUFFIXES = new Set([
  'llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd',
  'limited', 'pllc', 'pc', 'plc', 'lp', 'llp', 'group', 'holdings', 'enterprises',
  'the',
]);

/** Significant tokens (length >= 2), accents/punctuation removed. */
export function tokenize(s: string | null | undefined): string[] {
  const n = normalizeText(s);
  if (!n) return [];
  return n.split(' ').filter((t) => t.length >= 2);
}

/** Normalized entity name with legal suffixes / leading "the" stripped. */
export function normalizeEntityName(name: string | null | undefined): {
  norm: string;
  tokens: string[];
} {
  const tokens = tokenize(name).filter((t) => !COMPANY_SUFFIXES.has(t));
  return { norm: tokens.join(' '), tokens };
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s.slice(i, i + 2);
    m.set(bg, (m.get(bg) ?? 0) + 1);
  }
  return m;
}

/** Sorensen-Dice similarity over character bigrams, 0..1. */
export function diceCoefficient(a: string, b: string): number {
  const x = normalizeText(a).replace(/ /g, '');
  const y = normalizeText(b).replace(/ /g, '');
  if (!x.length || !y.length) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const ba = bigrams(x);
  const bb = bigrams(y);
  let inter = 0;
  let total = 0;
  for (const v of ba.values()) total += v;
  for (const [k, v] of bb) {
    total += v;
    inter += Math.min(ba.get(k) ?? 0, v);
  }
  return (2 * inter) / total;
}

/** Jaccard similarity over token sets, 0..1. */
export function jaccard(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union ? inter / union : 0;
}

/** True when every `needle` token appears as a whole word in `haystackTokens`. */
export function tokensSubset(needle: string[], haystackTokens: Set<string>): boolean {
  if (!needle.length) return false;
  return needle.every((t) => haystackTokens.has(t));
}

// Common given-name nicknames -> a canonical form, so a "William … Smith"
// window matches a "Bill … Smith" client (and vice versa). Both the nickname
// and the formal name collapse to the same key; a plain name (not in the map)
// is returned unchanged. Surname/other tokens still have to match, so this only
// unifies people, never merges two different clients.
const NICKNAMES: Record<string, string> = {
  bill: 'william', billy: 'william', will: 'william', willy: 'william',
  mike: 'michael', mikey: 'michael', mick: 'michael',
  bob: 'robert', bobby: 'robert', rob: 'robert', robbie: 'robert',
  jim: 'james', jimmy: 'james', jamie: 'james',
  tom: 'thomas', tommy: 'thomas',
  dave: 'david', davey: 'david',
  dan: 'daniel', danny: 'daniel',
  joe: 'joseph', joey: 'joseph',
  chris: 'christopher',
  matt: 'matthew', matty: 'matthew',
  nick: 'nicholas', nicky: 'nicholas',
  tony: 'anthony',
  andy: 'andrew',
  ben: 'benjamin', benji: 'benjamin', benny: 'benjamin',
  sam: 'samuel', sammy: 'samuel',
  alex: 'alexander',
  eddie: 'edward',
  ron: 'ronald', ronnie: 'ronald',
  don: 'donald', donnie: 'donald',
  steve: 'steven', stevie: 'steven',
  ken: 'kenneth', kenny: 'kenneth',
  greg: 'gregory',
  jeff: 'jeffrey',
  rick: 'richard', ricky: 'richard', rich: 'richard', richie: 'richard',
  fred: 'frederick', freddie: 'frederick',
  charlie: 'charles', chuck: 'charles',
  kate: 'katherine', katie: 'katherine', kathy: 'katherine',
  liz: 'elizabeth', lizzie: 'elizabeth', beth: 'elizabeth', betsy: 'elizabeth',
  sue: 'susan', susie: 'susan',
  jen: 'jennifer', jenny: 'jennifer',
  becky: 'rebecca',
  maggie: 'margaret', peggy: 'margaret',
  cathy: 'catherine',
};

/** Canonicalize a single name token through the nickname map (unchanged if not a
 *  known nickname). Used by name matching so nicknames and formal names unify. */
export function canonicalName(token: string): string {
  return NICKNAMES[token] ?? token;
}

/** Normalize an email subject: strip repeated Re:/Fwd: prefixes, then normalize. */
export function normalizeSubject(s: string | null | undefined): string {
  let t = (s ?? '').trim();
  let prev: string;
  do {
    prev = t;
    t = t.replace(/^\s*(re|fw|fwd|aw|tr)\s*(\[\d+\])?\s*:\s*/i, '');
  } while (t !== prev);
  return normalizeText(t);
}

// Subject words too generic to identify a client on their own: email chrome,
// pleasantries, and CPA-universal terms (every client has "tax", "financials", a
// "monthly close"). A subject built ONLY from these — "Re: Tax question", "quick
// question", "documents" — is a coincidental match, so it must not index a client.
const GENERIC_SUBJECT_WORDS = new Set([
  're', 'fwd', 'fw', 'aw', 'tr', 'reply', 'hi', 'hello', 'hey', 'thanks', 'thank',
  'please', 'fyi', 'regards', 'best', 'quick', 'question', 'questions', 'follow',
  'followup', 'help', 'urgent', 'important', 'reminder', 'update', 'updates', 'info',
  'information', 'request', 'meeting', 'call', 'sync', 'chat', 'checking', 'touch',
  'base', 'note', 'notes', 'document', 'documents', 'doc', 'docs', 'file', 'files',
  'review', 'status', 'intro', 'introduction', 'morning', 'afternoon', 'your', 'you',
  'our', 'the', 'and', 'for', 'about', 'regarding', 'from', 'with', 'new', 'next',
  'last', 'this', 'today', 'tomorrow',
  'tax', 'taxes', 'return', 'returns', 'filing', 'extension', 'statement', 'statements',
  'invoice', 'invoices', 'payment', 'payments', 'books', 'bookkeeping', 'financials',
  'financial', 'report', 'reports', 'accounting', 'payroll', 'close', 'month', 'monthly',
  'quarterly', 'annual', 'year', 'ledger', 'reconciliation',
]);

/**
 * True when a normalized email subject is too generic to identify a client on its
 * own — nothing distinctive beyond email chrome, pleasantries, or CPA-universal
 * words. "tax question" / "quick question" / "documents" -> true; "nimbus tax" /
 * "northwind financials" -> false (the name carries it). Keeps the subject resolver from
 * coincidentally billing a generic thread to whoever last used that phrase.
 */
export function isGenericSubject(normalized: string | null | undefined): boolean {
  const tokens = (normalized ?? '').split(' ').filter(Boolean);
  const distinctive = tokens.filter(
    (t) => t.length >= 3 && !GENERIC_SUBJECT_WORDS.has(t) && !/^\d+$/.test(t),
  );
  return distinctive.length === 0;
}

// Trailing UI chrome of mail/chat apps. When matched, everything from the
// marker to the end of the title is app shell, not content.
const MAIL_TRAILING: RegExp[] = [
  /\s*\|\s*Microsoft Teams.*$/i, // "... | Microsoft Teams [| Pinned window]"
  /\s-\s[^-]+\s-\s\d+\s+new\s+items?\s-\sSlack\s*$/i, // "... - Workspace - 1 new item - Slack"
  /\s-\s[^-]+\s-\sSlack\s*$/i, // "... - Workspace - Slack"
  /\s-\sSlack\s*$/i,
  // Missive/Outlook folder labels + everything after (account names, etc.)
  /\s-\s(Inbox|Sent|Drafts|Archive|Closed|Snoozed|Trash|Spam|Outbox|My Tasks|Mentions|Assigned to me|Assigned to others|Assigned to)\b.*$/i,
];

/**
 * Strip the surrounding app shell off a Missive/Outlook/Gmail/Teams/Slack window
 * title, leaving the actual subject or meeting name. Tested against real titles:
 *   "Move invoices - Inbox - Darin - Ashford"            -> "Move invoices"
 *   "Vantage Holding BV ... - My Tasks - (Darin) - Ashford..." -> "Vantage Holding BV ..."
 *   "Lantern Labs - May financials | Microsoft Teams"      -> "Lantern Labs - May financials"
 *   "Inbox - Ashford Sky - Meridian"                     -> "Inbox"
 *   "Gmail - Tax letter Kernelworks 2024 - sam@meridian.example" -> "Tax letter Kernelworks 2024"
 */
export function stripMailChrome(raw: string | null | undefined): string {
  let t = (raw ?? '').trim();
  // "(18) Subject…" webmail unread counter (web Missive/Gmail tabs). 1–3 digits
  // only, so a subject starting with a year "(2024) K-1 question" is untouched.
  t = t.replace(/^\s*\(\d{1,3}\)\s*/, '');
  t = t.replace(/^Chat\s*\|\s*/i, ''); // Teams "Chat | <name> | Microsoft Teams"
  t = t.replace(/^Gmail\s-\s/i, ''); // Gmail "Gmail - <subject> - <account>"
  t = t.replace(/\s-\s[\w.+-]+@[\w.-]+\s*$/i, ''); // trailing "- name@domain" account
  for (const re of MAIL_TRAILING) t = t.replace(re, '');
  t = t.replace(/\s-\sAshford\s+Sky\b.*$/i, ''); // "... - Ashford Sky - Meridian" / "Ashford Sky CPA"
  return t.trim();
}

/** Apply a MatchKind-style comparison between a normalized value and pattern. */
export function matchValue(
  value: string,
  pattern: string,
  kind: 'exact' | 'contains' | 'prefix' | 'suffix' | 'regex' | 'domain',
): boolean {
  if (!value || !pattern) return false;
  switch (kind) {
    case 'exact':
    case 'domain':
      return value === pattern;
    case 'contains':
      return value.includes(pattern);
    case 'prefix':
      return value.startsWith(pattern);
    case 'suffix':
      return value.endsWith(pattern);
    case 'regex':
      try {
        return new RegExp(pattern, 'i').test(value);
      } catch {
        return false;
      }
    default:
      return false;
  }
}
