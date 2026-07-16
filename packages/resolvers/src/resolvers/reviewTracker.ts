import type { Resolver } from '../types';
import { clientName, extractSignals } from '../match';

/**
 * Review Tracker (notes.ashfordsky.com): every project page names its client and
 * the URL carries the project id (/projects/503). The graph maps that id to a
 * client straight from the tracker's own table, so reviewing a return bills to
 * that client instead of landing in firm tooling. An exact id link — the URL
 * can't mean two clients — so it auto-finalizes.
 */
export const reviewTrackerResolver: Resolver = {
  type: 'review_tracker',
  resolve(interval, ctx) {
    const s = extractSignals(interval);
    if (!s.reviewProjectId) return null;
    const clientId = ctx.graph.byReviewProject.get(s.reviewProjectId);
    if (!clientId) return null;
    return {
      clientId,
      clientGroupId: ctx.graph.clients.get(clientId)?.clientGroupId ?? null,
      confidence: 0.95,
      resolverType: 'review_tracker',
      evidence: {
        reason: `Review Tracker project ${s.reviewProjectId} belongs to ${clientName(ctx.graph, clientId)}`,
        matchedOn: 'review_project',
        matchedValue: s.reviewProjectId,
        sourceField: 'url',
        sourceSystem: 'review_tracker',
      },
      needsReview: false,
    };
  },
};
