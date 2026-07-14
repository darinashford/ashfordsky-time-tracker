import { emailDomain, extractEmails } from '@tt/shared';
import type { Resolver } from '../types';
import { buildResult } from '../match';

/**
 * Screenshot-OCR fallback. The sidecar OCRs an email window and stores the text
 * on the interval's screenshot; here we read it (ctx.ocrText), pull the sender
 * address, and match it to a client by exact email or domain — catching emails
 * whose window title carried no client name. Reduced confidence (a suggestion),
 * since OCR can misread; your confirmation promotes it. Runs every resolve, so
 * the attribution persists across re-resolves.
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
    return null;
  },
};
