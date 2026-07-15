import {
  type ClientGraph,
  type Evidence,
  type Interval,
  type ResolverResult,
  type ResolverType,
  canonicalName,
  extractEmails,
  normalizeText,
  parseHost,
  tokensSubset,
} from '@tt/shared';

/** Structured signals extracted once from an interval and shared by resolvers. */
export interface Signals {
  app: string | null;
  appNorm: string;
  title: string | null;
  titleNorm: string;
  url: string | null;
  urlNorm: string;
  host: string;
  emails: string[];
  sheetId: string | null;
  driveFolderId: string | null;
  fcId: string | null;
  qboRealm: string | null;
}

const SHEET_RE = /(?:spreadsheets\/d\/|document\/d\/|\/d\/)([a-z0-9-_]{20,})/i;
const DRIVE_FOLDER_RE = /(?:drive\/folders\/|folders\/)([a-z0-9-_]{10,})/i;
// FC identifies the client two ways: a /clients/{id} path (a client page) OR a
// ?client_id={id} query param (on /project and /task pages — a CPA's actual work).
const FC_RE = /financial-cents\.com\/clients\/(\d+)/i;
const FC_CLIENT_PARAM_RE = /[?&]client_id=(\d+)/i;
// QBO identifies the company (= realm) in the URL as realmid, but the
// switch-company and app URLs use companyId= / cid= — same 15-16 digit id. These
// often surface in the window title (the switchCompany URL shows there), so
// extractSignals reads title too. Require >=12 digits so cid=1 noise is ignored.
const QBO_REALM_RE = /[?&](?:realmid|companyid|cid)=(\d{12,})/i;

function firstMatch(re: RegExp, ...inputs: Array<string | null | undefined>): string | null {
  for (const input of inputs) {
    if (!input) continue;
    const m = input.match(re);
    if (m && m[1]) return m[1];
  }
  return null;
}

export function extractSignals(interval: Interval): Signals {
  const url = interval.url ?? null;
  const title = interval.windowTitle ?? null;
  return {
    app: interval.app ?? null,
    appNorm: normalizeText(interval.app),
    title,
    titleNorm: normalizeText(title),
    url,
    urlNorm: (url ?? '').toLowerCase(),
    host: parseHost(url),
    emails: Array.from(new Set([...extractEmails(title), ...extractEmails(url)])),
    sheetId: firstMatch(SHEET_RE, url, title),
    driveFolderId: firstMatch(DRIVE_FOLDER_RE, url, title),
    fcId: firstMatch(FC_RE, url, title) ?? firstMatch(FC_CLIENT_PARAM_RE, url, title),
    qboRealm: firstMatch(QBO_REALM_RE, url, title),
  };
}

export function clientName(graph: ClientGraph, id: string): string {
  return graph.clients.get(id)?.name ?? id;
}

export interface NameMatch {
  clientId: string;
  score: number;
  matchedTokens: number;
  phrase: boolean;
  /** Which name-index entry won for this client: the client's own primary name,
   *  or a secondary alias (entity/person). Used to break ties — a client's own
   *  name outranks another client's alias carrying the same text. */
  kind: 'client_name' | 'entity_name' | 'person_name';
}

/**
 * Rank clients whose name/alias tokens all appear in `text`. Returns best score
 * per client, highest first. Conservative: skips weak single short tokens.
 */
export function matchClientsByText(text: string | null | undefined, graph: ClientGraph): NameMatch[] {
  const norm = normalizeText(text);
  if (!norm) return [];
  // Canonicalize given-name nicknames on both sides so "William" matches a
  // "Bill" client (and vice versa); surname/other tokens must still line up.
  const hay = new Set(norm.split(' ').filter(Boolean).map(canonicalName));
  const best = new Map<string, NameMatch>();
  for (const e of graph.names) {
    if (!e.tokens.length) continue;
    const distinctive = e.tokens.length >= 2 || (e.tokens[0]?.length ?? 0) >= 5;
    if (!distinctive) continue;
    if (!tokensSubset(e.tokens.map(canonicalName), hay)) continue;
    const phrase = e.norm.length >= 4 && norm.includes(e.norm);
    let score = e.tokens.length >= 3 ? 0.8 : e.tokens.length === 2 ? 0.74 : 0.62;
    if (phrase) score += 0.08;
    if (e.kind === 'person_name') score -= 0.05;
    score = Math.min(score, 0.9);
    const cur = best.get(e.clientId);
    if (!cur || score > cur.score) {
      best.set(e.clientId, { clientId: e.clientId, score, matchedTokens: e.tokens.length, phrase, kind: e.kind });
    }
  }
  return [...best.values()].sort(
    (a, b) => b.score - a.score || b.matchedTokens - a.matchedTokens,
  );
}

/**
 * Turn one or more candidate client ids into a ResolverResult, handling the
 * ambiguous (>1 distinct client) case by lowering confidence + flagging review.
 */
export function buildResult(
  clientIds: string[],
  graph: ClientGraph,
  confidence: number,
  resolverType: ResolverType,
  evidence: Evidence,
  isBillable?: boolean,
): ResolverResult | null {
  const uniq = [...new Set(clientIds.filter(Boolean))];
  if (uniq.length === 0) return null;

  if (uniq.length === 1) {
    const id = uniq[0]!;
    return {
      clientId: id,
      clientGroupId: graph.clients.get(id)?.clientGroupId ?? null,
      confidence,
      resolverType,
      evidence: {
        ...evidence,
        candidates: [{ clientId: id, clientName: clientName(graph, id), confidence, why: evidence.reason }],
      },
      needsReview: false,
      isBillable,
    };
  }

  // Ambiguous: keep all candidates, suggest the first, force review.
  const lowered = Math.min(confidence * 0.6, 0.49);
  return {
    clientId: uniq[0]!,
    clientGroupId: graph.clients.get(uniq[0]!)?.clientGroupId ?? null,
    confidence: Number(lowered.toFixed(3)),
    resolverType,
    evidence: {
      ...evidence,
      reason: `${evidence.reason} (ambiguous: ${uniq.length} clients share this signal)`,
      candidates: uniq.map((id) => ({
        clientId: id,
        clientName: clientName(graph, id),
        confidence: Number((confidence * 0.6).toFixed(3)),
      })),
    },
    needsReview: true,
    isBillable,
  };
}

/**
 * Convert ranked name matches into a result, detecting near-ties between
 * different clients as ambiguity (-> review).
 */
export function nameMatchResult(
  matches: NameMatch[],
  graph: ClientGraph,
  confidence: number,
  resolverType: ResolverType,
  evidence: Evidence,
  isBillable?: boolean,
): ResolverResult | null {
  if (matches.length === 0) return null;
  let top = matches[0]!;
  // A client's OWN primary name outranks another client's alias carrying the same
  // text. The roster sync scatters sibling entity-names across a group (one
  // client's name also lands on several unrelated clients as an alias), which
  // would otherwise read as ambiguous and drop real client work to needs-review.
  // If a primary-name match is within reach of the top score, promote it.
  const primary = matches.find((m) => m.kind === 'client_name');
  if (primary && top.kind !== 'client_name' && primary.score >= top.score - 0.06) {
    top = primary;
  }
  // Ambiguous only if a DIFFERENT client ties at the same authority: an alias on
  // another client does not make a primary-name match ambiguous.
  const tie = matches.find(
    (m) =>
      m.clientId !== top.clientId &&
      m.score >= top.score - 0.03 &&
      !(top.kind === 'client_name' && m.kind !== 'client_name'),
  );
  const ids = tie ? [top.clientId, tie.clientId] : [top.clientId];
  return buildResult(ids, graph, confidence, resolverType, evidence, isBillable);
}

export const BROWSER_APPS = ['chrome', 'edge', 'firefox', 'brave', 'arc', 'opera', 'safari', 'msedge'];

export function isBrowser(appNorm: string): boolean {
  return BROWSER_APPS.some((b) => appNorm.includes(b));
}
