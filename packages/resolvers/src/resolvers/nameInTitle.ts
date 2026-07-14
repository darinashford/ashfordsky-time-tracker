import { stripMailChrome } from '@tt/shared';
import type { Resolver } from '../types';
import { extractSignals, matchClientsByText, nameMatchResult } from '../match';

/**
 * General fallback: match a client name in ANY window title — desktop apps like
 * Missive and Teams included, not just browsers. Strips mail/chat app shell
 * first (folder/account/workspace chrome) so we match on real content, not UI.
 * Capped at a suggestion so a title-only name match never auto-finalizes.
 */
export const nameInTitleResolver: Resolver = {
  type: 'window_title_name',
  resolve(interval, ctx) {
    const s = extractSignals(interval);
    if (!s.titleNorm) return null;
    // Prefer the de-chromed subject. But Missive formats titles as
    // "<view> - Ashford Sky - <Client>", and stripMailChrome removes the firm
    // account chrome along with the trailing client name ("Inbox - Ashford Sky -
    // Meridian" -> "Inbox"). So when the clean pass finds nothing, fall back to
    // the raw title, which still carries the client name.
    const cleaned = stripMailChrome(s.title);
    let matches = cleaned.length >= 3 ? matchClientsByText(cleaned, ctx.graph) : [];
    if (matches.length === 0) matches = matchClientsByText(s.title, ctx.graph);
    if (matches.length === 0) return null;
    return nameMatchResult(matches, ctx.graph, Math.min(0.72, matches[0]!.score), 'window_title_name', {
      reason: `Client name matched in ${interval.app ?? 'window'} title`,
      sourceField: 'window_title',
    });
  },
};
