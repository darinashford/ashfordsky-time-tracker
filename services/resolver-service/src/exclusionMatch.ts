import { type Exclusion, matchValue, normalizeDomain, normalizeText } from '@tt/shared';
import type { Signals } from '@tt/resolvers';

function fieldValue(field: string, s: Signals): string {
  switch (field) {
    case 'app':
      return s.appNorm;
    case 'domain':
      return s.host;
    case 'url':
      return s.urlNorm;
    case 'title':
      return s.titleNorm;
    default:
      return '';
  }
}

function normalizePattern(field: string, raw: string): string {
  if (field === 'domain') return normalizeDomain(raw);
  if (field === 'url') return raw.toLowerCase();
  return normalizeText(raw);
}

/** First matching exclusion for these signals, or null. */
export function matchExclusion(s: Signals, exclusions: Exclusion[]): Exclusion | null {
  for (const ex of exclusions) {
    if (!ex.enabled) continue;
    const value = fieldValue(ex.field, s);
    if (!value) continue;
    const pattern = ex.normalized || normalizePattern(ex.field, ex.pattern);
    if (matchValue(value, pattern, ex.matchKind)) return ex;
  }
  return null;
}
