import { isEmailContext, normalizeSubject, stripMailChrome } from '@tt/shared';
import type { Resolver } from '../types';
import { clientName } from '../match';

/**
 * Land a mail window on a client by matching its subject against the firm's
 * already-attributed inbox (inbox_messages.matched_subject_id). This is how
 * Missive/Outlook/Gmail resolve even when the title carries no client name —
 * e.g. "Re: Nimbus Tax" -> Nimbus Technologies LLC.
 *
 * Only runs on actual email windows. Without this gate it would treat any browser
 * tab title as an email subject — e.g. a Chrome tab on the Financial Cents web app
 * titled "Financial Cents" matched a "Financial Cents" notification thread filed
 * under a client and auto-billed it (then carry-forward smeared it everywhere).
 */
export const emailSubjectResolver: Resolver = {
  type: 'email_subject',
  resolve(interval, ctx) {
    if (!isEmailContext(interval.app, interval.url)) return null;
    const title = interval.windowTitle ?? '';
    if (!title) return null;
    const subjectPart = stripMailChrome(title);
    const key = normalizeSubject(subjectPart);
    if (key.length < 6) return null;

    const hit = ctx.graph.emailSubjects.get(key);
    if (!hit) return null;

    const confidence = hit.ambiguous ? 0.5 : 0.88;
    return {
      clientId: hit.clientId,
      clientGroupId: ctx.graph.clients.get(hit.clientId)?.clientGroupId ?? null,
      confidence,
      resolverType: 'email_subject',
      evidence: {
        reason: hit.ambiguous
          ? 'Email subject matches several clients in your inbox — confirm'
          : 'Email subject matches an attributed email in your inbox',
        matchedOn: 'email_subject',
        matchedValue: subjectPart.trim(),
        sourceField: 'window_title',
        sourceSystem: 'missive',
        candidates: [{ clientId: hit.clientId, clientName: clientName(ctx.graph, hit.clientId), confidence }],
      },
      needsReview: hit.ambiguous,
    };
  },
};
