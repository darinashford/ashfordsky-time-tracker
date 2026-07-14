import { emailDomain } from '@tt/shared';
import type { Resolver } from '../types';
import { buildResult, extractSignals } from '../match';

/**
 * Email/domain attribution (Missive, Outlook, Gmail, or visiting a client site).
 * Exact address beats domain. Internal/free-mail/vendor/partner domains never
 * match at the domain level (exact address still can).
 */
export const emailResolver: Resolver = {
  type: 'email_address',
  resolve(interval, ctx) {
    const s = extractSignals(interval);
    const g = ctx.graph;

    for (const email of s.emails) {
      const ids = g.byEmail.get(email);
      if (ids && ids.length) {
        return buildResult(ids, g, 0.92, 'email_address', {
          reason: `Email address ${email} belongs to this client`,
          matchedOn: 'email',
          matchedValue: email,
          sourceField: 'window_title',
          sourceSystem: 'missive',
        });
      }
    }

    const domains: string[] = [];
    for (const email of s.emails) {
      const d = emailDomain(email);
      if (d) domains.push(d);
    }
    if (s.host) domains.push(s.host);

    for (const dom of domains) {
      if (
        g.internalDomains.has(dom) ||
        g.freemailDomains.has(dom) ||
        g.vendorDomains.has(dom) ||
        g.partnerDomains.has(dom)
      ) {
        continue;
      }
      const ids = g.byDomain.get(dom);
      if (ids && ids.length) {
        return buildResult(ids, g, 0.85, 'email_domain', {
          reason: `Domain ${dom} belongs to this client`,
          matchedOn: 'email_domain',
          matchedValue: dom,
          sourceField: s.emails.length ? 'window_title' : 'url',
        });
      }
    }
    return null;
  },
};
