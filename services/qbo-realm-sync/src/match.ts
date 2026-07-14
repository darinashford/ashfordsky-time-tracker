import { normalizeText } from '@tt/shared';

/** A client name or alias, flattened to (clientId, value) for indexing. */
export interface NameRow {
  clientId: string;
  value: string;
}

/**
 * Index client names + aliases by their normalized form. normalizeText is the
 * SAME normalizer the resolver uses to key `byQboCompany`, so a match here means
 * the resolver will also match this company name off the QBO window title.
 * A normalized key can map to several clients (shared aliases in the
 * consolidation graph) — we keep them all and treat >1 as ambiguous.
 */
export function buildNameIndex(rows: NameRow[]): Map<string, Set<string>> {
  const idx = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = normalizeText(r.value);
    if (!key) continue;
    let set = idx.get(key);
    if (!set) {
      set = new Set<string>();
      idx.set(key, set);
    }
    set.add(r.clientId);
  }
  return idx;
}

export type MatchResult =
  | { kind: 'matched'; clientId: string }
  | { kind: 'ambiguous'; clientIds: string[] }
  | { kind: 'none' };

/**
 * Resolve a QBO company name to exactly one client by exact normalized-name
 * equality. Deliberately conservative: a name that differs from the client
 * record (e.g. "BIJOU CORP" vs "Bijou Build") returns `none` and is left for a
 * human rather than guessed — fuzzy auto-mapping is how books get mis-billed.
 */
export function matchCompany(company: string, idx: Map<string, Set<string>>): MatchResult {
  const key = normalizeText(company);
  if (!key) return { kind: 'none' };
  const set = idx.get(key);
  if (!set || set.size === 0) return { kind: 'none' };
  if (set.size === 1) return { kind: 'matched', clientId: [...set][0]! };
  return { kind: 'ambiguous', clientIds: [...set] };
}
