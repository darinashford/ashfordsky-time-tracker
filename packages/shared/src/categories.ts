import { normalizeText, parseHost, stripMailChrome } from './text';

export type CategoryTier = 'hard' | 'firm' | 'soft';

export interface CategoryHit {
  key: string;
  label: string;
  tier: CategoryTier;
}

/** Human-readable labels for every non-client bucket (shared by CLI + dashboard). */
export const CATEGORY_LABELS: Record<string, string> = {
  system: 'System / OS',
  music: 'Music',
  entertainment: 'Entertainment / video',
  social_media: 'Social media',
  news: 'News',
  shopping: 'Shopping',
  prospecting: 'Prospecting / BD',
  firm_admin: 'Firm admin',
  research: 'Research',
  ai_assistant: 'AI assistant',
  development: 'Development / tools',
  firm_tooling: 'Firm tooling / internal dev',
  firm_internal: 'Firm / internal',
  email_admin: 'Email / internal',
  external_call: 'Calls — prospects / vendors',
  personal: 'Personal',
  excluded: 'Excluded (rule)',
};

export function categoryLabel(key: string | null | undefined): string {
  if (!key) return 'Uncategorized';
  return CATEGORY_LABELS[key] ?? key;
}

interface BucketDef {
  key: string;
  tier: CategoryTier;
  apps?: string[]; // substring match vs normalized app
  hosts?: string[]; // exact-or-suffix match vs host
  titles?: string[]; // brand keyword in the window title, for when the URL wasn't captured
}

// First match wins. 'hard' = never client work (pre-empts carry-forward);
// 'soft' = a tool/topic that should still inherit a client when one is in context.
const BUCKETS: BucketDef[] = [
  {
    key: 'system',
    tier: 'hard',
    apps: [
      'shellhost', 'searchhost', 'startmenuexperiencehost', 'shellexperiencehost',
      'applicationframehost', 'openwith', 'lockapp', 'systemsettings', 'textinputhost',
      'sihost', 'dwm', 'taskmgr', 'snippingtool', 'acrotray', 'widgets', 'searchapp',
    ],
    titles: ['new tab', 'untitled', 'program manager'],
  },
  {
    key: 'music',
    tier: 'hard',
    apps: ['spotify', 'itunes', 'apple music', 'tidal'],
    hosts: ['spotify.com', 'music.apple.com', 'pandora.com', 'tidal.com', 'music.youtube.com'],
    // The player often shows in the window title even when the URL wasn't
    // captured ("… - Now Playing on Pandora - …"), so match the title too.
    titles: ['spotify', 'pandora', 'now playing on'],
  },
  {
    key: 'entertainment',
    tier: 'hard',
    apps: ['netflix'],
    hosts: ['youtube.com', 'youtu.be', 'netflix.com', 'hulu.com', 'disneyplus.com', 'twitch.tv', 'hbomax.com', 'max.com'],
    titles: ['youtube', 'netflix', 'hulu', 'twitch'],
  },
  {
    key: 'social_media',
    tier: 'hard',
    hosts: [
      'facebook.com', 'x.com', 'twitter.com', 'instagram.com', 'linkedin.com', 'reddit.com',
      'tiktok.com', 'threads.net', 'bsky.app', 'snapchat.com', 'pinterest.com', 'discord.com',
    ],
    titles: ['linkedin', 'facebook', 'instagram', 'reddit', 'tiktok', 'pinterest', 'discord'],
  },
  {
    key: 'news',
    tier: 'hard',
    hosts: ['nytimes.com', 'wsj.com', 'cnn.com', 'bloomberg.com', 'foxnews.com', 'npr.org', 'apnews.com', 'washingtonpost.com', 'reuters.com'],
    titles: ['new york times', 'wall street journal', 'bloomberg', 'reuters'],
  },
  {
    key: 'shopping',
    tier: 'hard',
    hosts: ['amazon.com', 'ebay.com', 'walmart.com', 'etsy.com', 'target.com', 'bestbuy.com'],
  },
  {
    // Business development / deal sourcing — not client work, never inherits a client.
    key: 'prospecting',
    tier: 'hard',
    hosts: ['searchfunder.com', 'duedilio.com', 'axial.net', 'bizbuysell.com', 'dealroom.com'],
  },
  {
    // Payroll / AP / expense platforms. A CPA firm runs these BOTH for its own
    // books AND on behalf of clients (Gusto payroll for a client, Bill.com AP
    // for a client, etc.), and those pages name the client in the title/URL
    // (e.g. "Inputs | Pay | Acme Holdings LLC | Gusto"). So this is 'firm', not
    // 'hard': a real client signal wins (billable to that client), and only with
    // NO client in context does it fall to firm overhead. See bucketFor.
    key: 'firm_admin',
    tier: 'firm',
    hosts: ['ramp.com', 'bill.com', 'gusto.com', 'justworks.com', 'expensify.com', 'brex.com', 'melio.com'],
    // Firm-wide planning artifacts that span every client, not one (the master client
    // list, the project/returns planning lists). 'firm' tier yields to a real client
    // signal, so a client-named workbook still bills to that client.
    titles: ['master client list', 'client list', 'project list', 'returns list and planning'],
  },
  {
    // Personal time — travel booking, airlines, car rentals, hotels, leisure,
    // church. Never client work for the firm, so 'hard' (never bills a client).
    key: 'personal',
    tier: 'hard',
    hosts: [
      'expedia.com', 'priceline.com', 'kayak.com', 'booking.com', 'airbnb.com', 'vrbo.com', 'hotels.com', 'tripadvisor.com',
      'hertz.com', 'avis.com', 'alamo.com', 'budget.com', 'enterprise.com', 'nationalcar.com', 'rentalcars.com', 'pricelesscarrental.com', 'turo.com',
      'southwest.com', 'delta.com', 'united.com', 'aa.com', 'jetblue.com', 'flybreeze.com', 'alaskaair.com', 'spirit.com', 'frontier.com',
      'yelp.com', 'opentable.com', 'floridastateparks.org', 'visitstpeteclearwater.com',
      'churchofjesuschrist.org',
    ],
    titles: ['vacation'],
  },
  {
    // The firm's own internal software/AI platforms (not a client's books).
    key: 'firm_tooling',
    tier: 'hard',
    hosts: ['brain.ashfordsky.com', 'time.ashfordsky.com', 'notes.ashfordsky.com'],
    titles: ['ashford agentos', 'quickbooks connector'],
  },
  {
    key: 'ai_assistant',
    tier: 'soft',
    apps: ['claude', 'chatgpt'],
    hosts: ['claude.ai', 'chatgpt.com', 'chat.openai.com', 'gemini.google.com', 'copilot.microsoft.com', 'perplexity.ai', 'bard.google.com'],
    titles: ['chatgpt', 'perplexity'],
  },
  {
    key: 'development',
    tier: 'soft',
    apps: ['code', 'windowsterminal', 'cursor', 'codex', 'powershell'],
    hosts: ['replit.com', 'github.com', 'stackoverflow.com', 'localhost', '127.0.0.1', 'vercel.com', 'npmjs.com'],
    titles: ['replit', 'github', 'stack overflow'],
  },
  {
    // Professional reference. 'soft' so research done while anchored to a client
    // still attributes to that client; only un-anchored research falls here.
    key: 'research',
    tier: 'soft',
    hosts: ['thetaxadviser.com', 'journalofaccountancy.com', 'aicpa.org', 'investopedia.com', 'en.wikipedia.org', 'irs.gov', 'taxnotes.com'],
  },
];

const MEETING_APPS = ['teams', 'zoom', 'webex', 'meet', 'slack', 'quo', 'openphone', 'krisp'];
// Real-time call apps (chat-only apps like Slack are excluded). A call on one of
// these that doesn't resolve to a client or name a staff member is time with a
// prospect or vendor we can't identify yet.
const CALL_APPS = ['teams', 'zoom', 'webex', 'openphone', 'krisp', 'ringcentral', 'gotomeeting', 'dialpad', 'whereby'];
// Browser-hosted meetings: the call runs in a tab, so the app is the browser and
// the signal is the host (or a Google Meet "Meet - …" tab title when no URL was
// captured). Native Teams/Zoom are already covered by CALL_APPS above.
const CALL_HOSTS = ['meet.google.com', 'whereby.com', 'meet.jit.si'];
const STOPWORDS = new Set([
  'and', 'with', 'the', 'chat', 'call', 'meeting', 'sync', 'pinned', 'window', 'new',
  'message', 'microsoft', 'teams', 'huddle', 'channel', 'dm', 'item', 'items',
]);

const EMAIL_APPS = ['missive', 'outlook', 'olk', 'thunderbird', 'mailspring', 'emclient'];
const EMAIL_HOSTS = ['mail.google.com', 'outlook.office.com', 'outlook.office365.com', 'mail.proton.me', 'mail.missiveapp.com', 'missiveapp.com'];

function hostMatches(host: string, patterns: string[]): boolean {
  return patterns.some((h) => host === h || host.endsWith('.' + h));
}

/**
 * A real-time call/meeting — a native call app (CALL_APPS) OR a browser meeting
 * (Google Meet / Whereby / Jitsi by host, or a Google Meet "Meet - …" tab title
 * when the URL wasn't captured). Lets browser calls get the same "engaged time"
 * treatment as native ones: counted, and exempt from the idle "away" cutoff.
 */
export function isRealtimeCall(app?: string | null, host?: string | null, title?: string | null): boolean {
  const a = normalizeText(app ?? '');
  if (a && CALL_APPS.some((m) => a.includes(m))) return true;
  const h = (host ?? '').toLowerCase();
  if (h && hostMatches(h, CALL_HOSTS)) return true;
  return /^\s*meet\s*[-–—]\s/i.test(title ?? '');
}

/**
 * Is this interval an actual email window (a mail client, or a webmail host)?
 * The email-subject resolver gates on this so it never fires on a non-mail
 * browser tab — e.g. a Chrome tab on the Financial Cents web app titled
 * "Financial Cents" must not match an inbox subject and bill a client.
 */
export function isEmailContext(app?: string | null, url?: string | null): boolean {
  const a = normalizeText(app);
  if (a && EMAIL_APPS.some((m) => a.includes(m))) return true;
  const host = parseHost(url);
  return !!host && hostMatches(host, EMAIL_HOSTS);
}

export interface CategorizeInput {
  appNorm?: string | null;
  host?: string | null;
  title?: string | null; // raw window title
  url?: string | null; // full URL, for path-aware buckets (e.g. Financial Cents)
}

/**
 * A cross-client Financial Cents surface (dashboard / project & task lists /
 * reports / inbox / the clients list) — practice-management overhead, not one
 * client's work. Excludes a specific client's pages (/clients/{id}, /project/…,
 * which the FC resolver bills to the client), so this never hides billable time.
 */
export function isFinancialCentsAdminPage(url?: string | null): boolean {
  if (!url) return false;
  let host = '';
  let path = '';
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch {
    return false;
  }
  if (!host.endsWith('financial-cents.com')) return false;
  if (/^\/project\//.test(path)) return false; // a specific client's project/task
  if (/^\/clients\/\d/.test(path)) return false; // a specific client's page
  return path === '/' || /^\/(dashboard|home|reports|inbox|clients)(\/|$)/.test(path);
}

export interface CategorizeOptions {
  staffNameTokens?: Set<string>; // firm staff first names, EXCLUDING the device owner
}

/**
 * Bucket non-client activity into a named category (social media, music, AI, a
 * firm-internal staff meeting, etc.). Returns null when nothing matches, so those
 * intervals stay genuinely "unresolved" and the worklist keeps meaning.
 */
export function categorizeActivity(input: CategorizeInput, opts: CategorizeOptions = {}): CategoryHit | null {
  const app = input.appNorm ?? '';
  const host = input.host ?? '';
  const titleNorm = normalizeText(input.title);

  for (const b of BUCKETS) {
    if (b.apps && app && b.apps.some((a) => app.includes(a))) {
      return { key: b.key, label: categoryLabel(b.key), tier: b.tier };
    }
    if (b.hosts && host && hostMatches(host, b.hosts)) {
      return { key: b.key, label: categoryLabel(b.key), tier: b.tier };
    }
    // A brand keyword in the title (e.g. "Sam Boyle | LinkedIn", "ChatGPT") when
    // the URL wasn't captured. Less certain than a host/app match, so a hard bucket
    // is softened to 'firm': it still pre-empts carry-forward (LinkedIn browsing
    // won't bill the previous client) but yields to a real client match (a client
    // doc that merely mentions the brand stays with the client).
    if (b.titles && titleNorm && b.titles.some((t) => titleNorm.includes(t))) {
      return { key: b.key, label: categoryLabel(b.key), tier: b.tier === 'hard' ? 'firm' : b.tier };
    }
  }

  // Cross-client Financial Cents navigation (the practice-management app itself,
  // not a specific client's page) — firm overhead. Path-aware so a client's own
  // project/task/client page still bills to that client via the FC resolver.
  if (isFinancialCentsAdminPage(input.url)) {
    return { key: 'firm_admin', label: categoryLabel('firm_admin'), tier: 'firm' };
  }

  // Firm-internal staff meeting: a meeting app whose title names another staff
  // member (e.g. "Dana Brooks | Microsoft Teams", "Jamie / Darin").
  const staff = opts.staffNameTokens;
  if (staff && staff.size && (MEETING_APPS.some((m) => app.includes(m)) || isRealtimeCall(app, host, input.title))) {
    const tokens = normalizeText(stripMailChrome(input.title ?? ''))
      .split(' ')
      .filter((t) => t && !STOPWORDS.has(t));
    if (tokens.some((t) => staff.has(t))) return { key: 'firm_internal', label: categoryLabel('firm_internal'), tier: 'firm' };
  }

  // A real-time call that didn't name a staff member is time with an outside party
  // we can't identify yet — a prospect or vendor. 'firm' tier: a real client match
  // (calendar / email / sheet) still wins, but it pre-empts carry-forward so a
  // prospect call isn't billed to whoever you were with just before.
  if (isRealtimeCall(app, host, input.title)) {
    return { key: 'external_call', label: categoryLabel('external_call'), tier: 'firm' };
  }

  // Email stays 'firm', NOT 'soft': you context-switch between clients inside the
  // mail app, so inheriting the carried-forward client guesses wrong (it would
  // bill the previous client for an unrelated email). Email attributes to a client
  // only on a REAL signal — a subject/title rule or alias, an address match, or
  // OCR of the sender — each of which is a direct match that overrides this bucket.
  // Otherwise it's internal email.
  if (EMAIL_APPS.some((m) => app.includes(m)) || (host && hostMatches(host, EMAIL_HOSTS))) {
    return { key: 'email_admin', label: categoryLabel('email_admin'), tier: 'firm' };
  }

  return null;
}

export interface ClientOutcome {
  clientId: string | null;
  resolverType: string | null;
  confidence: number;
}

/**
 * Decide the non-client bucket for an interval given the resolver outcome and a
 * category hit. Returns the bucket key, or null to keep the client attribution
 * (or leave it unresolved). Shared by the resolver runner and the inspect tool.
 */
export function bucketFor(outcome: ClientOutcome, cat: CategoryHit | null, reviewThreshold: number): string | null {
  const directClient =
    !!outcome.clientId &&
    outcome.resolverType !== 'context_carry_forward' &&
    outcome.resolverType !== 'neighbor' &&
    outcome.confidence >= reviewThreshold;

  if (cat?.tier === 'hard') return cat.key; // never client work — pre-empts everything
  if (directClient) return null; // real direct evidence wins
  if (cat?.tier === 'firm') return cat.key; // staff meeting — pre-empts carry-forward
  if (outcome.clientId && outcome.confidence >= reviewThreshold) return null; // carry-forward / neighbor client
  if (cat) return cat.key; // soft bucket (AI/dev/research) with no client in context
  return null; // genuinely unresolved
}
