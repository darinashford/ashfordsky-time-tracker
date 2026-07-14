import { type ClientAnchor, type Interval, type ResolverResult, type ResolverType, secondsBetween } from '@tt/shared';

/** Resolver types strong enough to (re)set the rolling current-client anchor. */
export const ANCHOR_RESOLVER_TYPES = new Set<ResolverType>([
  'rule',
  'calendar_event',
  'cch_axcess',
  'google_sheet_id',
  'sharepoint_folder',
  'google_drive_folder',
  'email_address',
  'email_domain',
  'email_subject',
  'qbo',
  'financial_cents',
  'excel_path',
  // Title/name matches are weaker but real direct evidence (e.g. a Teams client
  // meeting or a client Sheet). They anchor so follow-on Claude/ChatGPT inherits.
  'browser_title',
  'window_title_name',
  'screenshot_ocr',
]);

export interface ContextEngineOptions {
  ttlSeconds?: number;
  minAnchorConfidence?: number;
}

/**
 * Maintains a rolling "current client" derived from recent high-confidence,
 * direct-evidence activity. Lets ambiguous follow-on activity (ChatGPT, Claude,
 * a blank browser tab) inherit context — always at reduced confidence.
 */
export class ContextEngine {
  private anchor: ClientAnchor | null = null;
  private readonly ttlSeconds: number;
  private readonly minAnchorConfidence: number;

  constructor(opts: ContextEngineOptions = {}) {
    this.ttlSeconds = opts.ttlSeconds ?? 1800;
    this.minAnchorConfidence = opts.minAnchorConfidence ?? 0.7;
  }

  /** The anchor, if still fresh relative to this interval's start. */
  anchorFor(interval: Interval): ClientAnchor | null {
    if (!this.anchor) return null;
    const gap = secondsBetween(this.anchor.asOf, interval.startTs);
    if (gap < 0 || gap > this.ttlSeconds) return null;
    return this.anchor;
  }

  /** Update the anchor when an interval resolves via strong direct evidence. */
  observe(interval: Interval, winner: ResolverResult | null): void {
    if (!winner || !winner.clientId) return;
    if (!ANCHOR_RESOLVER_TYPES.has(winner.resolverType)) return;
    if (winner.needsReview) return;
    if (winner.confidence < this.minAnchorConfidence) return;
    this.anchor = {
      asOf: interval.endTs,
      clientId: winner.clientId,
      clientGroupId: winner.clientGroupId ?? null,
      confidence: winner.confidence,
      anchorResolverType: winner.resolverType,
      sourceIntervalId: interval.id,
    };
  }

  get current(): ClientAnchor | null {
    return this.anchor;
  }

  reset(): void {
    this.anchor = null;
  }
}
