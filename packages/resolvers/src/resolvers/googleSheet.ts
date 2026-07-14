import type { Resolver } from '../types';
import { extractSignals } from '../match';

/** Exact Google Sheet id -> client. Unknown sheets fall through (surface in the
 *  "top unresolved" report so you can map them once, forever). */
export const googleSheetResolver: Resolver = {
  type: 'google_sheet_id',
  resolve(interval, ctx) {
    const s = extractSignals(interval);
    if (!s.sheetId) return null;
    const clientId = ctx.graph.bySheetId.get(s.sheetId);
    if (!clientId) return null;
    return {
      clientId,
      clientGroupId: ctx.graph.clients.get(clientId)?.clientGroupId ?? null,
      confidence: 0.95,
      resolverType: 'google_sheet_id',
      evidence: {
        reason: 'Google Sheet id is mapped to this client',
        matchedOn: 'google_sheet_id',
        matchedValue: s.sheetId,
        sourceField: 'url',
        sourceSystem: 'google_sheets',
      },
      needsReview: false,
    };
  },
};
