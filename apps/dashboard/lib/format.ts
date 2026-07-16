export function pct(confidence: number | null | undefined): string {
  if (confidence == null) return '—';
  return `${Math.round(confidence * 100)}%`;
}

const STATUS_COLORS: Record<string, string> = {
  auto_finalized: '#1f8a4c',
  confirmed: '#1f8a4c',
  suggested: '#b8860b',
  needs_review: '#c0392b',
  unresolved: '#7f8c8d',
  nonbillable: '#566573',
  rejected: '#c0392b',
};

export function statusColor(status: string | null | undefined): string {
  return STATUS_COLORS[status ?? 'unresolved'] ?? '#7f8c8d';
}

// Confidence-first names (Darin's wording): how sure the matcher is, not a
// review workflow. auto_finalized -> confident, suggested -> likely,
// needs_review -> uncertain.
const STATUS_LABELS: Record<string, string> = {
  auto_finalized: 'confident',
  confirmed: 'confirmed',
  suggested: 'likely',
  needs_review: 'uncertain',
  unresolved: 'unknown',
  nonbillable: 'non-billable',
  rejected: 'rejected',
};

export function statusLabel(status: string | null | undefined): string {
  const s = status ?? 'unresolved';
  return STATUS_LABELS[s] ?? s.replace(/_/g, ' ');
}

/** The five summary buckets a block can fall into. */
export type Disposition = 'auto' | 'suggested' | 'needs_review' | 'unresolved' | 'nonbillable';

/**
 * Which summary column a block belongs to. Mirrors the priority CASE in the
 * daily_client_summary SQL view EXACTLY, so clicking a summary number filters
 * the timeline to the same set of blocks that number counted.
 * (auto_finalized + confirmed are merged into the "auto" column.)
 */
export function dispositionBucket(r: {
  status: string | null;
  isBillable: boolean | null;
  needsReview: boolean | null;
}): Disposition {
  if (r.status === 'nonbillable' || r.isBillable === false) return 'nonbillable';
  if (r.status === 'needs_review' || r.needsReview === true) return 'needs_review';
  if (r.status === 'auto_finalized' || r.status === 'confirmed') return 'auto';
  if (r.status === 'suggested') return 'suggested';
  return 'unresolved';
}

export const DISPOSITION_LABEL: Record<string, string> = {
  auto: 'confident',
  suggested: 'likely',
  needs_review: 'uncertain',
  unresolved: 'unknown',
  nonbillable: 'non-billable',
};

const SCREENSHOT_LABEL: Record<string, string> = {
  not_needed: '—',
  optional: 'optional',
  needed: '📷 needed',
  available: '🖼️ available',
  blocked: '⛔ blocked',
  deleted: 'deleted',
};

export function screenshotLabel(status: string | null | undefined): string {
  return SCREENSHOT_LABEL[status ?? 'not_needed'] ?? (status ?? '—');
}

/** Short, human name for how a block was attributed (shown under the client). */
const RESOLVER_LABEL: Record<string, string> = {
  manual: 'you confirmed',
  rule: 'your rule',
  email_subject: 'inbox subject',
  email: 'email match',
  email_domain: 'email domain',
  name_in_title: 'name in title',
  folder: 'mapped folder',
  google_sheet: 'mapped sheet',
  excel: 'mapped file',
  cch: 'CCH id',
  qbo: 'QuickBooks',
  financial_cents: 'Financial Cents id',
  review_tracker: 'review tracker project',
  browser: 'website',
  ai_chat: 'AI chat',
  chat_workspace: 'chat workspace',
  ocr: 'screen text',
  context_carry_forward: 'carried over',
  neighbor: 'nearby block',
  calendar: 'calendar',
  call_run: 'same call',
  llm: 'AI',
};

export function resolverLabel(type: string | null | undefined): string {
  if (!type) return '—';
  return RESOLVER_LABEL[type] ?? type.replace(/_/g, ' ');
}

/** Plain-English explanation of *why* a block got its client/category — what the
 *  resolver type actually means, not the code word. Used by the timeline "why". */
const RESOLVER_WHY: Record<string, string> = {
  manual: 'You set this client yourself.',
  rule: 'Matched a rule you created for this kind of window.',
  email_subject: 'The email subject matches messages in your inbox that are filed under this client.',
  email: 'An email address for this client was on screen.',
  email_domain: "This client's email domain was on screen.",
  name_in_title: "This client's name appears in the window title.",
  folder: 'This SharePoint/Drive folder is mapped to this client.',
  google_sheet: 'This Google Sheet is mapped to this client.',
  excel: 'This spreadsheet is mapped to this client.',
  cch: "Matched by this client's ID in CCH Axcess.",
  qbo: "Matched by this client's QuickBooks Online company.",
  financial_cents: "Matched by this client's ID in the Financial Cents URL.",
  review_tracker: 'A Review Tracker project page — that project belongs to this client, so reviewing it is their work.',
  browser: 'Matched by the website on screen.',
  ai_chat: 'Inferred from the AI chat content.',
  chat_workspace: 'Matched by the chat workspace/channel.',
  ocr: "Read this client's email/domain from the screen (OCR).",
  context_carry_forward:
    'This window had no client signal of its own, so it kept the client you were working on just before. Low confidence — confirm if it’s right.',
  neighbor:
    'Borrowed from an attributed block right next to it in time. Confirm if it’s right.',
  calendar: 'You had a meeting with this client on your calendar at this time.',
  call_run:
    'Part of the same continuous call as a meeting identified to this client — the call kept going past its logged end. Confirm if it’s right.',
};

export function explainEvidence(r: {
  resolverType: string | null;
  evidence: Record<string, unknown> | null;
}): string {
  const ev = r.evidence ?? {};
  const reason = typeof ev.reason === 'string' ? ev.reason : '';
  const matched = typeof ev.matchedValue === 'string' ? ev.matchedValue.trim() : '';

  // The LLM's reason IS the explanation — surface it directly.
  if (r.resolverType === 'llm' && reason) return reason.replace(/^LLM:\s*/i, 'AI judgement: ');

  let text = RESOLVER_WHY[r.resolverType ?? ''] ?? (reason || 'Attributed by the matcher.');
  if (matched && !text.includes(matched)) text += ` (matched: “${matched}”)`;
  return text;
}
