import type {
  AttributionRule,
  ClientAnchor,
  ClientGraph,
  Interval,
  ResolverResult,
  ResolverType,
} from '@tt/shared';

export interface ResolverConfig {
  autoFinalizeThreshold: number;
  reviewThreshold: number;
}

/** Everything a resolver may read. Resolvers are pure: same inputs => same output. */
export interface ResolverContext {
  graph: ClientGraph;
  rules: AttributionRule[];
  config: ResolverConfig;
  /** Rolling current-client anchor from preceding high-confidence activity. */
  currentAnchor?: ClientAnchor | null;
  /** OCR text from a screenshot of this interval (sidecar-captured), if any. */
  ocrText?: string | null;
}

export interface Resolver {
  type: ResolverType;
  resolve(interval: Interval, ctx: ResolverContext): ResolverResult | null;
}
