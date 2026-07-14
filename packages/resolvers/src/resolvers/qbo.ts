import type { Resolver } from '../types';
import { buildResult, extractSignals, matchClientsByText, nameMatchResult } from '../match';

/** QuickBooks Online: realm id (exact) or company name in the window title. */
export const qboResolver: Resolver = {
  type: 'qbo',
  resolve(interval, ctx) {
    const s = extractSignals(interval);
    // QBO is a SPA: the report pages capture as blob:https://qbo.intuit.com/<uuid>
    // (host often empty) and the switch-company step shows its URL only in the
    // window title with host accounts.intuit.com. So detect QBO from the title/URL
    // text and from a realm we managed to read — not just the parsed host — or the
    // switchCompany block (the one carrying the company id) gets rejected here.
    const isQbo =
      s.host.includes('qbo.intuit') ||
      s.host.includes('quickbooks.intuit') ||
      s.host.includes('qboaccountant') ||
      s.appNorm.includes('quickbooks') ||
      s.urlNorm.includes('qbo.intuit') ||
      s.titleNorm.includes('qbo intuit') ||
      s.titleNorm.includes('quickbooks online') ||
      s.qboRealm != null;
    if (!isQbo) return null;

    if (s.qboRealm) {
      const clientId = ctx.graph.byQboRealm.get(s.qboRealm);
      if (clientId) {
        return {
          clientId,
          clientGroupId: ctx.graph.clients.get(clientId)?.clientGroupId ?? null,
          confidence: 0.95,
          resolverType: 'qbo',
          evidence: {
            reason: `QuickBooks realm id ${s.qboRealm} mapped to client`,
            matchedOn: 'qbo_realm',
            matchedValue: s.qboRealm,
            sourceField: 'url',
            sourceSystem: 'qbo',
          },
          needsReview: false,
        };
      }
    }

    const company = s.titleNorm.replace(/\s*quickbooks online\s*$/, '').replace(/\s*qbo\s*$/, '').trim();
    const exact = ctx.graph.byQboCompany.get(company);
    if (exact && exact.length) {
      return buildResult(exact, ctx.graph, 0.85, 'qbo', {
        reason: 'QuickBooks company name mapped to client',
        matchedOn: 'qbo_company',
        matchedValue: company,
        sourceField: 'window_title',
        sourceSystem: 'qbo',
      });
    }

    const matches = matchClientsByText(company, ctx.graph);
    if (matches.length === 0) return null;
    return nameMatchResult(matches, ctx.graph, Math.min(0.82, matches[0]!.score + 0.02), 'qbo', {
      reason: 'Client name matched in QuickBooks Online window title',
      matchedOn: 'qbo_company',
      sourceField: 'window_title',
      sourceSystem: 'qbo',
    });
  },
};
