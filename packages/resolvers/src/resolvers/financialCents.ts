import type { Resolver } from '../types';
import { extractSignals, matchClientsByText, nameMatchResult } from '../match';

/** Financial Cents: exact client id from the URL, else client name in the title. */
export const financialCentsResolver: Resolver = {
  type: 'financial_cents',
  resolve(interval, ctx) {
    const s = extractSignals(interval);
    if (s.fcId) {
      const clientId = ctx.graph.byFinancialCentsId.get(s.fcId);
      if (clientId) {
        return {
          clientId,
          clientGroupId: ctx.graph.clients.get(clientId)?.clientGroupId ?? null,
          confidence: 0.96,
          resolverType: 'financial_cents',
          evidence: {
            reason: `Financial Cents client id ${s.fcId} mapped to client`,
            matchedOn: 'financial_cents_id',
            matchedValue: s.fcId,
            sourceField: 'url',
            sourceSystem: 'financial_cents',
          },
          needsReview: false,
        };
      }
    }
    if (s.host.includes('financial-cents')) {
      const matches = matchClientsByText(s.title, ctx.graph);
      if (matches.length) {
        return nameMatchResult(matches, ctx.graph, Math.min(0.8, matches[0]!.score), 'financial_cents', {
          reason: 'Client name matched in Financial Cents window title',
          sourceField: 'window_title',
          sourceSystem: 'financial_cents',
        });
      }
    }
    return null;
  },
};
