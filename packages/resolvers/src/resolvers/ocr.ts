import { emailDomain, extractEmails } from '@tt/shared';
import type { Resolver } from '../types';
import { buildResult, matchClientsByText, nameMatchResult } from '../match';

/**
 * Screenshot-OCR fallback. The sidecar OCRs the active window and stores the
 * text on the interval's screenshot; here we read it (ctx.ocrText) and match a
 * client three ways, strongest first: an exact client email on screen, then a
 * client domain, then the client's NAME appearing in the screen text (a return
 * open in CCH, their books in QBO, a doc naming them). Reduced confidence (a
 * suggestion), since OCR can misread; your confirmation promotes it. Runs every
 * resolve, so the attribution persists across re-resolves.
 */
export const ocrResolver: Resolver = {
  type: 'screenshot_ocr',
  resolve(_interval, ctx) {
    const text = ctx.ocrText;
    if (!text) return null;
    const g = ctx.graph;
    const emails = extractEmails(text);

    for (const email of emails) {
      const ids = g.byEmail.get(email.toLowerCase());
      if (ids && ids.length) {
        return buildResult(ids, g, 0.82, 'screenshot_ocr', {
          reason: `Sender ${email}, read from the on-screen email, belongs to this client`,
          matchedOn: 'email',
          matchedValue: email,
          sourceField: 'ocr',
          sourceSystem: 'missive',
        });
      }
    }
    for (const email of emails) {
      const d = emailDomain(email);
      if (!d || g.internalDomains.has(d) || g.freemailDomains.has(d) || g.vendorDomains.has(d) || g.partnerDomains.has(d)) {
        continue;
      }
      const ids = g.byDomain.get(d);
      if (ids && ids.length) {
        return buildResult(ids, g, 0.72, 'screenshot_ocr', {
          reason: `Sender domain ${d}, read from the on-screen email, belongs to this client`,
          matchedOn: 'email_domain',
          matchedValue: d,
          sourceField: 'ocr',
        });
      }
    }

    // No email on screen — try the client's NAME in the screen text (the active
    // window is what was captured, so the name on screen is what's being worked
    // on). Only for compact single-window text: the huge multi-monitor dumps of
    // older captures are full of incidental names (inbox lists, client pickers)
    // and must not attribute. Capped low: OCR misreads, and ties between clients
    // fall to review via nameMatchResult.
    if (text.length > 6_000) return null;
    const matches = matchClientsByText(text, g);
    if (matches.length > 0) {
      return nameMatchResult(matches, g, Math.min(0.66, matches[0]!.score), 'screenshot_ocr', {
        reason: 'The client’s name appeared in the on-screen text',
        matchedOn: 'name_in_ocr',
        sourceField: 'ocr',
      });
    }
    return null;
  },
};
