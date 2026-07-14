import type { Resolver } from '../types';
import { extractSignals, isBrowser, matchClientsByText, nameMatchResult } from '../match';

/** Generic browser fallback: client name in the tab title (lower confidence). */
export const browserResolver: Resolver = {
  type: 'browser_title',
  resolve(interval, ctx) {
    const s = extractSignals(interval);
    if (!isBrowser(s.appNorm) && !s.url) return null;
    const matches = matchClientsByText(s.title, ctx.graph);
    if (matches.length === 0) return null;
    return nameMatchResult(matches, ctx.graph, Math.min(0.7, matches[0]!.score - 0.02), 'browser_title', {
      reason: 'Client name matched in browser tab title',
      sourceField: 'window_title',
    });
  },
};
