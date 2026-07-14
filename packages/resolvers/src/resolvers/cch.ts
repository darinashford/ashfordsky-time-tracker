import type { Resolver } from '../types';
import { extractSignals, matchClientsByText, nameMatchResult } from '../match';

/**
 * CCH Axcess is the strongest anchor. If we can read a known CCH client id from
 * the title we use it; otherwise we match the client name in the title, boosted
 * because we know this is the tax application.
 */
export const cchResolver: Resolver = {
  type: 'cch_axcess',
  resolve(interval, ctx) {
    const s = extractSignals(interval);
    const isCch =
      s.appNorm.includes('axcess') ||
      s.appNorm.includes('cch') ||
      s.titleNorm.includes('axcess') ||
      s.host.includes('cchaxcess') ||
      s.host.includes('wolterskluwer');
    if (!isCch) return null;

    // Known CCH client id present in the title (canonical map fills over time).
    for (const [cchId, clientId] of ctx.graph.byCchId) {
      if (cchId && s.titleNorm.includes(cchId)) {
        return {
          clientId,
          clientGroupId: ctx.graph.clients.get(clientId)?.clientGroupId ?? null,
          confidence: 0.96,
          resolverType: 'cch_axcess',
          evidence: {
            reason: `CCH Axcess client id "${cchId}" found in window title`,
            matchedOn: 'cch_client_id',
            matchedValue: cchId,
            sourceField: 'window_title',
            sourceSystem: 'cch_axcess',
          },
          needsReview: false,
        };
      }
    }

    const matches = matchClientsByText(s.title, ctx.graph);
    if (matches.length === 0) return null;
    const confidence = Math.min(0.9, matches[0]!.score + 0.06);
    return nameMatchResult(matches, ctx.graph, confidence, 'cch_axcess', {
      reason: 'Client name matched in CCH Axcess window title',
      matchedOn: 'entity_name',
      sourceField: 'window_title',
      sourceSystem: 'cch_axcess',
    });
  },
};
