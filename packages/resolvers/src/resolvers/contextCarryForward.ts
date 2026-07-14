import type { Resolver } from '../types';
import { clientName } from '../match';

/**
 * Lowest-priority direct resolver: inherit the rolling current client from
 * recent high-confidence activity, always at reduced confidence so it can never
 * auto-finalize on its own.
 */
export const contextCarryForwardResolver: Resolver = {
  type: 'context_carry_forward',
  resolve(_interval, ctx) {
    const a = ctx.currentAnchor;
    if (!a || !a.clientId) return null;
    const confidence = Math.min(0.6, a.confidence * 0.7);
    return {
      clientId: a.clientId,
      clientGroupId: a.clientGroupId ?? null,
      confidence,
      resolverType: 'context_carry_forward',
      evidence: {
        reason: `Carried forward from recent ${a.anchorResolverType} attribution`,
        sourceField: 'context',
        candidates: [
          { clientId: a.clientId, clientName: clientName(ctx.graph, a.clientId), confidence },
        ],
      },
      needsReview: confidence < ctx.config.reviewThreshold,
    };
  },
};
