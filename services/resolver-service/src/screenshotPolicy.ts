import { type Resolution, type ScreenshotPolicy, isEmailContext } from '@tt/shared';
import type { Signals } from '@tt/resolvers';

export interface ScreenshotDecision {
  status: 'needed';
  reason: string;
}

/**
 * Decide whether a low-confidence, stable interval warrants a screenshot.
 * High-confidence / confirmed activity is never captured.
 */
export function decideScreenshot(
  s: Signals,
  resolution: Resolution,
  policies: ScreenshotPolicy[],
  durationSeconds: number,
): ScreenshotDecision | null {
  if (resolution.status === 'auto_finalized' || resolution.status === 'confirmed') return null;

  for (const p of policies) {
    if (!p.enabled) continue;
    if (durationSeconds < p.minStableSeconds) continue;

    const pat = (p.appliesPattern ?? '').toLowerCase();
    switch (p.appliesScope) {
      case 'low_confidence':
        if (resolution.confidence >= p.onlyBelowConfidence) continue;
        break;
      case 'email_low_conf':
        // An email window (Missive/Outlook/Gmail) that did NOT confidently land
        // on a client — capture it so OCR can read the sender/body and attribute
        // the client even when the window title was truncated to a bare surname.
        if (resolution.confidence >= p.onlyBelowConfidence) continue;
        if (!isEmailContext(s.app, s.url)) continue;
        break;
      case 'app':
        if (!pat || !s.appNorm.includes(pat)) continue;
        break;
      case 'domain':
        if (!pat || !s.host.includes(pat)) continue;
        break;
      case 'title':
        if (!pat || !s.titleNorm.includes(pat)) continue;
        break;
      case 'all':
        break;
      default:
        continue;
    }
    return {
      status: 'needed',
      reason: `Low-confidence (${resolution.confidence.toFixed(2)}) stable activity — policy "${p.name}"`,
    };
  }
  return null;
}
