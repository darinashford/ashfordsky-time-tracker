// Core domain types shared across ingestor, resolvers, db, and dashboard.
// These intentionally mirror the time_tracker SQL schema but use camelCase.

// ---------------------------------------------------------------------------
// Enums (string unions that match the Postgres enums)
// ---------------------------------------------------------------------------

export type AttributionStatus =
  | 'unresolved'
  | 'suggested'
  | 'needs_review'
  | 'auto_finalized'
  | 'confirmed'
  | 'nonbillable'
  | 'rejected';

export type ScreenshotStatus =
  | 'not_needed'
  | 'optional'
  | 'needed'
  | 'available'
  | 'blocked'
  | 'deleted';

export type OcrStatus = 'none' | 'pending' | 'done' | 'failed';

export type MatchKind = 'exact' | 'contains' | 'prefix' | 'suffix' | 'regex' | 'domain';

/** Stable identifiers for each resolver, in rough priority order. */
export const RESOLVER_TYPES = [
  'rule', // durable correction-created rules win first
  'calendar_event', // a scheduled meeting is authoritative for who you're with
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
  'ai_chat',
  'browser_url',
  'browser_title',
  'window_title_name',
  'screenshot_ocr',
  'context_carry_forward',
  'neighbor',
  'manual',
] as const;

export type ResolverType = (typeof RESOLVER_TYPES)[number];

// ---------------------------------------------------------------------------
// Sensor + interval shapes
// ---------------------------------------------------------------------------

/** What a SensorAdapter emits — already normalized away from any vendor format. */
export interface ActivityEvent {
  source: string; // 'activitywatch'
  hostname?: string | null;
  bucket?: string | null;
  eventType: 'window' | 'afk' | 'web';
  app?: string | null;
  windowTitle?: string | null;
  url?: string | null;
  afk?: boolean | null;
  timestamp: string; // ISO-8601
  durationSeconds: number;
  data?: Record<string, unknown>;
}

/** A merged, AFK-aware block of activity — the unit resolvers attribute. */
export interface Interval {
  id: string;
  source: string;
  hostname?: string | null;
  startTs: string; // ISO-8601
  endTs: string; // ISO-8601
  durationSeconds: number;
  app?: string | null;
  windowTitle?: string | null;
  url?: string | null;
  browser?: string | null;
  isAfk: boolean;
  rawEventIds?: string[];
}

// ---------------------------------------------------------------------------
// Resolver inputs/outputs
// ---------------------------------------------------------------------------

export interface EvidenceCandidate {
  clientId: string;
  clientName?: string;
  confidence: number;
  why?: string;
}

/** Structured "why" stored as jsonb on every resolution + audit row. */
export interface Evidence {
  reason: string;
  matchedOn?: string; // e.g. 'email_domain', 'sheet_id'
  matchedValue?: string; // e.g. 'brightkidsco.example'
  sourceField?: 'app' | 'window_title' | 'url' | 'browser' | 'context' | 'ocr';
  sourceSystem?: string; // public.source_systems.key
  ruleId?: string;
  similarity?: number;
  candidates?: EvidenceCandidate[];
  [k: string]: unknown;
}

/** Returned by a single resolver; `null` means "no opinion". */
export interface ResolverResult {
  clientId: string;
  clientGroupId?: string | null;
  confidence: number; // 0..1
  resolverType: ResolverType;
  evidence: Evidence;
  needsReview: boolean;
  isBillable?: boolean; // default true
}

/** The final decision persisted for an interval. */
export interface Resolution {
  intervalId: string;
  clientId: string | null;
  clientGroupId: string | null;
  status: AttributionStatus;
  confidence: number;
  resolverType: string | null;
  isBillable: boolean;
  needsReview: boolean;
  evidence: Evidence | Record<string, unknown>;
  resolverVersion?: string;
  category?: string | null; // non-client bucket (social_media, music, firm_internal, ...)
}

// ---------------------------------------------------------------------------
// Client graph (in-memory snapshot the resolvers match against)
// ---------------------------------------------------------------------------

export interface ClientRef {
  id: string;
  name: string;
  clientGroupId?: string | null;
  status?: string | null;
}

export interface FolderMapping {
  /** Folder id and/or normalized path; either may match. */
  externalId?: string | null;
  path?: string | null;
  clientId: string;
  sourceSystem: string;
}

export interface NameEntry {
  norm: string; // normalized full name
  tokens: string[]; // significant tokens (suffixes stripped)
  clientId: string;
  kind: 'entity_name' | 'person_name' | 'client_name';
}

/**
 * Everything a resolver needs, pre-indexed for O(1) exact lookups and
 * cheap fuzzy name matching. Built once from the DB per run.
 */
export interface ClientGraph {
  clients: Map<string, ClientRef>;

  // exact, normalized-key maps. Emails/domains/company-names can legitimately
  // map to several related clients, so those are lists; a key with >1 client is
  // treated as ambiguous by the resolvers (suggest/needs-review, never silent).
  byEmail: Map<string, string[]>;
  byDomain: Map<string, string[]>;
  byQboCompany: Map<string, string[]>; // normalized company name
  // Identifiers that are unique per client by construction.
  bySheetId: Map<string, string>;
  byCchId: Map<string, string>;
  byFinancialCentsId: Map<string, string>;
  byQboRealm: Map<string, string>;

  // prefix-matched folder maps
  folders: FolderMapping[];

  // name index for window/title/doc matching
  names: NameEntry[];

  // normalized email subject -> client, built from the firm's already-attributed
  // inbox (inbox_messages.matched_subject_id). Powers Missive/Outlook/Gmail.
  emailSubjects: Map<string, { clientId: string; ambiguous: boolean }>;

  // firm staff first-name tokens (EXCLUDING the device owner) for flagging
  // internal staff meetings, e.g. "Dana Brooks | Microsoft Teams".
  staffNameTokens: Set<string>;

  // meetings (public.meetings) pre-matched to a client — by a confirmed firm-brain
  // link or by the client named in the title. An interval whose time falls inside a
  // window is attributed to that client. confidence carries the source's strength.
  // participants: lowercased emails of who was IN the meeting (recorder owner +
  // logged participants) — a meeting only attributes a person's time if THEY were
  // in it (host "alex" ↔ alex@<internal domain>); empty = unknown, applies to all.
  calendarEvents: Array<{
    startMs: number;
    endMs: number;
    clientId: string;
    subject: string;
    confidence: number;
    participants?: string[];
  }>;

  // negative signals
  internalDomains: Set<string>; // never attribute (the firm itself)
  freemailDomains: Set<string>; // domain match disallowed; exact email still ok
  vendorDomains: Set<string>; // outside parties, not clients
  partnerDomains: Set<string>; // referral partners, not clients
}

// ---------------------------------------------------------------------------
// Overlay rules + exclusions
// ---------------------------------------------------------------------------

export interface AttributionRule {
  id: string;
  ruleType: string;
  matchKind: MatchKind;
  pattern: string;
  normalized?: string | null;
  clientId: string | null;
  clientGroupId?: string | null;
  sourceSystem?: string | null;
  confidence: number;
  isBillable?: boolean | null;
  enabled: boolean;
  priority: number;
}

export interface Exclusion {
  id: string;
  kind: 'no_screenshot' | 'nonbillable' | 'ignore';
  field: 'app' | 'domain' | 'url' | 'title';
  matchKind: MatchKind;
  pattern: string;
  normalized?: string | null;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Context engine
// ---------------------------------------------------------------------------

export interface ClientAnchor {
  asOf: string; // ISO; the time this anchor became "current"
  clientId: string;
  clientGroupId?: string | null;
  confidence: number;
  anchorResolverType: string;
  sourceIntervalId?: string | null;
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

export interface ScreenshotPolicy {
  id: string;
  name: string;
  enabled: boolean;
  onlyBelowConfidence: number;
  minStableSeconds: number;
  captureIntervalSeconds: number;
  retentionDays: number;
  appliesScope: 'low_confidence' | 'app' | 'domain' | 'title' | 'all';
  appliesPattern?: string | null;
}

export interface ScreenshotEvidence {
  id: string;
  intervalId: string | null;
  status: ScreenshotStatus;
  reason?: string | null;
  storageKind: 'local' | 'sharepoint';
  storagePath?: string | null;
  fileUrl?: string | null;
  sha256?: string | null;
  width?: number | null;
  height?: number | null;
  bytes?: number | null;
  app?: string | null;
  windowTitle?: string | null;
  capturedAt?: string | null;
  ocrStatus: OcrStatus;
  ocrText?: string | null;
}

/** Result returned by a ScreenshotStorageAdapter after persisting bytes. */
export interface StoredScreenshot {
  storageKind: 'local' | 'sharepoint';
  storagePath: string;
  fileUrl?: string | null;
  sha256: string;
  bytes: number;
  width?: number | null;
  height?: number | null;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export interface DailyClientSummaryRow {
  day: string;
  clientId: string | null;
  clientGroupId: string | null;
  clientName: string | null;
  totalSeconds: number;
  // MECE disposition buckets — these sum to totalSeconds.
  autoFinalizedSeconds: number;
  confirmedSeconds: number;
  suggestedSeconds: number;
  needsReviewSeconds: number;
  unresolvedSeconds: number;
  nonbillableSeconds: number;
  // Convenience rollup (not a separate bucket): auto + confirmed + suggested.
  billableSeconds: number;
  intervalCount: number;
}

export interface CoverageReportRow {
  day: string;
  activeSeconds: number;
  autoFinalizedSeconds: number;
  confirmedSeconds: number;
  suggestedSeconds: number;
  needsReviewSeconds: number;
  unresolvedSeconds: number;
  nonbillableSeconds: number;
  screenshotSupportedSeconds: number;
}
