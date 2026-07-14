import type { MatchKind } from '@tt/shared';
import { normalizeRuleValue } from './ruleMatching';

export interface RuleSpecOut {
  ruleType: string;
  matchKind: MatchKind;
  pattern: string;
  normalized: string;
  clientId: string;
  sourceSystem?: string;
  confidence: number;
  priority: number;
}

export interface CorrectionInputLike {
  action: string;
  clientId?: string | null;
  payload?: Record<string, unknown>;
}

/**
 * Pure mapping from a dashboard correction to the durable rule it should create
 * (or null if the action doesn't imply a rule). Persisting is the caller's job.
 */
export function correctionToRuleSpec(c: CorrectionInputLike): RuleSpecOut | null {
  const p = (c.payload ?? {}) as Record<string, string | undefined>;
  const clientId = c.clientId ?? p.clientId ?? null;
  if (!clientId) return null;

  const make = (
    ruleType: string,
    matchKind: MatchKind,
    raw: string | undefined,
    opts: { sourceSystem?: string; confidence?: number; priority?: number } = {},
  ): RuleSpecOut | null => {
    if (!raw) return null;
    return {
      ruleType,
      matchKind,
      pattern: String(raw),
      normalized: normalizeRuleValue(ruleType, String(raw)),
      clientId,
      sourceSystem: opts.sourceSystem,
      confidence: opts.confidence ?? 0.97,
      priority: opts.priority ?? 50,
    };
  };

  switch (c.action) {
    case 'map_domain':
      return make('email_domain', 'exact', p.domain ?? p.value, {
        sourceSystem: 'missive',
        confidence: 0.9,
        priority: 40,
      });
    case 'map_missive': {
      const kind = p.kind ?? 'domain';
      if (kind === 'address')
        return make('email', 'exact', p.value, { sourceSystem: 'missive', confidence: 0.95, priority: 30 });
      if (kind === 'label')
        return make('title_pattern', 'contains', p.value, { sourceSystem: 'missive', confidence: 0.8, priority: 80 });
      return make('email_domain', 'exact', p.value ?? p.domain, {
        sourceSystem: 'missive',
        confidence: 0.9,
        priority: 40,
      });
    }
    case 'map_sheet':
      return make('google_sheet_id', 'exact', p.sheetId, {
        sourceSystem: 'google_sheets',
        confidence: 0.98,
        priority: 10,
      });
    case 'map_folder': {
      const ss = p.sourceSystem === 'google_drive' ? 'google_drive' : 'sharepoint';
      const rt = ss === 'google_drive' ? 'google_drive_folder' : 'sharepoint_folder';
      return make(rt, 'contains', p.path ?? p.folderUrl, { sourceSystem: ss, confidence: 0.95, priority: 20 });
    }
    case 'map_cch':
      return make('cch_client_id', 'contains', p.cchId ?? p.value, {
        sourceSystem: 'cch_axcess',
        confidence: 0.95,
        priority: 15,
      });
    case 'map_qbo':
      if (p.realm)
        return make('qbo_realm', 'exact', p.realm, { sourceSystem: 'qbo', confidence: 0.96, priority: 18 });
      return make('qbo_company', 'contains', p.company ?? p.value, {
        sourceSystem: 'qbo',
        confidence: 0.85,
        priority: 60,
      });
    case 'map_url': {
      const matchKind = (p.matchKind as MatchKind) ?? 'contains';
      if (p.host) return make('url_host', 'exact', p.host, { confidence: 0.85, priority: 70 });
      return make('url_pattern', matchKind, p.pattern, { confidence: 0.8, priority: 70 });
    }
    case 'create_rule':
      return make(
        (p.ruleType as string) ?? 'title_pattern',
        (p.matchKind as MatchKind) ?? 'contains',
        p.pattern,
        {
          sourceSystem: p.sourceSystem,
          confidence: p.confidence ? Number(p.confidence) : 0.9,
          priority: p.priority ? Number(p.priority) : 60,
        },
      );
    default:
      return null;
  }
}
