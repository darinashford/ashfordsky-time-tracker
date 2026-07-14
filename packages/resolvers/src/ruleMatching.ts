import { emailDomain, normalizeDomain, normalizeText } from '@tt/shared';
import type { Signals } from './match';

export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Normalize a rule pattern consistently with how interval values are derived. */
export function normalizeRuleValue(ruleType: string, raw: string): string {
  const r = (raw ?? '').trim();
  switch (ruleType) {
    case 'email_domain':
    case 'url_host':
    case 'domain':
      return normalizeDomain(r);
    case 'email':
      return r.toLowerCase();
    case 'google_sheet_id':
    case 'qbo_realm':
    case 'financial_cents_id':
      return r;
    case 'sharepoint_folder':
    case 'google_drive_folder':
      return safeDecode(r).toLowerCase();
    case 'cch_client_id':
      return r.toLowerCase();
    case 'qbo_company':
    case 'title_pattern':
    case 'app':
      return normalizeText(r);
    case 'url_pattern':
      return r.toLowerCase();
    default:
      return normalizeText(r);
  }
}

/** Interval-derived candidate values to test against a rule of this type. */
export function valuesForRuleType(ruleType: string, s: Signals): string[] {
  switch (ruleType) {
    case 'email_domain':
    case 'domain':
      return [...s.emails.map(emailDomain), s.host].filter(Boolean);
    case 'url_host':
      return [s.host].filter(Boolean);
    case 'email':
      return s.emails;
    case 'google_sheet_id':
      return s.sheetId ? [s.sheetId] : [];
    case 'google_drive_folder':
    case 'sharepoint_folder':
      return [safeDecode(s.urlNorm)].filter(Boolean);
    case 'qbo_realm':
      return s.qboRealm ? [s.qboRealm] : [];
    case 'financial_cents_id':
      return s.fcId ? [s.fcId] : [];
    case 'qbo_company':
    case 'title_pattern':
      return [s.titleNorm].filter(Boolean);
    case 'cch_client_id':
      return [s.titleNorm, s.urlNorm].filter(Boolean);
    case 'url_pattern':
      return [s.urlNorm].filter(Boolean);
    case 'app':
      return [s.appNorm].filter(Boolean);
    default:
      return [s.titleNorm].filter(Boolean);
  }
}
