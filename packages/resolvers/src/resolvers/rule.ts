import { matchValue } from '@tt/shared';
import type { Resolver } from '../types';
import { clientName, extractSignals } from '../match';
import { normalizeRuleValue, valuesForRuleType } from '../ruleMatching';

/**
 * Highest priority: durable rules created from your corrections. The first
 * matching rule (rules are pre-sorted by priority) wins.
 */
export const ruleResolver: Resolver = {
  type: 'rule',
  resolve(interval, ctx) {
    if (ctx.rules.length === 0) return null;
    const s = extractSignals(interval);
    for (const rule of ctx.rules) {
      if (!rule.enabled || !rule.clientId) continue;
      const pattern = rule.normalized || normalizeRuleValue(rule.ruleType, rule.pattern);
      if (!pattern) continue;
      const values = valuesForRuleType(rule.ruleType, s).map((v) =>
        normalizeRuleValue(rule.ruleType, v),
      );
      if (values.some((v) => matchValue(v, pattern, rule.matchKind))) {
        const id = rule.clientId;
        return {
          clientId: id,
          clientGroupId: rule.clientGroupId ?? ctx.graph.clients.get(id)?.clientGroupId ?? null,
          confidence: rule.confidence,
          resolverType: 'rule',
          evidence: {
            reason: `Matched learned rule (${rule.ruleType} / ${rule.matchKind})`,
            matchedOn: rule.ruleType,
            matchedValue: rule.pattern,
            ruleId: rule.id,
            sourceSystem: rule.sourceSystem ?? undefined,
            candidates: [{ clientId: id, clientName: clientName(ctx.graph, id), confidence: rule.confidence }],
          },
          needsReview: false,
          isBillable: rule.isBillable ?? undefined,
        };
      }
    }
    return null;
  },
};
