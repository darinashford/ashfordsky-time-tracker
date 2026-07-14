import type { AttributionStatus, Interval, Resolution, ResolverResult } from '@tt/shared';
import type { Resolver, ResolverContext } from './types';
import {
  aiChatResolver,
  browserResolver,
  calendarResolver,
  cchResolver,
  chatWorkspaceResolver,
  contextCarryForwardResolver,
  emailResolver,
  emailSubjectResolver,
  excelResolver,
  financialCentsResolver,
  folderResolver,
  googleSheetResolver,
  nameInTitleResolver,
  ocrResolver,
  qboResolver,
  ruleResolver,
} from './resolvers';

export const RESOLVER_VERSION = '0.1.0';

/** Priority order. Earlier = higher priority; the first match wins. */
export const DEFAULT_RESOLVERS: Resolver[] = [
  ruleResolver,
  calendarResolver,
  cchResolver,
  googleSheetResolver,
  folderResolver,
  emailSubjectResolver,
  emailResolver,
  qboResolver,
  financialCentsResolver,
  excelResolver,
  browserResolver,
  aiChatResolver,
  chatWorkspaceResolver,
  nameInTitleResolver,
  ocrResolver,
  contextCarryForwardResolver,
];

const CONTEXTUAL = new Set(['context_carry_forward', 'neighbor']);

export interface RunResult {
  resolution: Resolution;
  votes: ResolverResult[];
  winner: ResolverResult | null;
}

/** Run the chain over one interval: collect votes, pick a winner, decide status. */
export function runResolvers(
  interval: Interval,
  ctx: ResolverContext,
  resolvers: Resolver[] = DEFAULT_RESOLVERS,
): RunResult {
  const votes: ResolverResult[] = [];
  for (const r of resolvers) {
    let res: ResolverResult | null = null;
    try {
      res = r.resolve(interval, ctx);
    } catch {
      res = null;
    }
    if (res && res.clientId) votes.push(res);
  }

  const winner = votes[0] ?? null;
  if (winner && !CONTEXTUAL.has(winner.resolverType)) {
    // Two independent direct-evidence resolvers disagree -> force review.
    const conflict = votes.some(
      (v) =>
        v !== winner &&
        v.clientId !== winner.clientId &&
        v.confidence >= ctx.config.reviewThreshold &&
        !CONTEXTUAL.has(v.resolverType),
    );
    if (conflict) winner.needsReview = true;
  }

  return { resolution: decide(interval, winner, ctx), votes, winner };
}

function decide(interval: Interval, winner: ResolverResult | null, ctx: ResolverContext): Resolution {
  if (!winner || !winner.clientId) {
    return {
      intervalId: interval.id,
      clientId: null,
      clientGroupId: null,
      status: 'unresolved',
      confidence: 0,
      resolverType: null,
      isBillable: true,
      needsReview: false,
      evidence: { reason: 'No resolver matched this activity' },
      resolverVersion: RESOLVER_VERSION,
    };
  }

  const { autoFinalizeThreshold, reviewThreshold } = ctx.config;
  let status: AttributionStatus;
  if (winner.needsReview) status = 'needs_review';
  else if (winner.confidence >= autoFinalizeThreshold) status = 'auto_finalized';
  else if (winner.confidence >= reviewThreshold) status = 'suggested';
  else status = 'needs_review';

  return {
    intervalId: interval.id,
    clientId: winner.clientId,
    clientGroupId: winner.clientGroupId ?? null,
    status,
    confidence: winner.confidence,
    resolverType: winner.resolverType,
    isBillable: winner.isBillable ?? true,
    needsReview: status === 'needs_review',
    evidence: winner.evidence,
    resolverVersion: RESOLVER_VERSION,
  };
}
