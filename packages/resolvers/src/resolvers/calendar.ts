import type { Resolver } from '../types';
import { clientName } from '../match';

/**
 * Calendar attribution. A scheduled meeting is authoritative for who you're with,
 * so any interval whose time falls inside a meeting window (matched to a client
 * by the meeting's external attendee domain) is attributed to that client — and
 * it anchors context, so the surrounding Teams/Zoom/notes time inherits it too.
 * Events are pre-matched to a client when the graph is built.
 */
export const calendarResolver: Resolver = {
  type: 'calendar_event',
  resolve(interval, ctx) {
    const events = ctx.graph.calendarEvents;
    if (events.length === 0) return null;
    const mid = (Date.parse(interval.startTs) + Date.parse(interval.endTs)) / 2;
    // A meeting is only evidence for the people who were IN it. Hosts map to firm
    // emails by short id (alex -> alex@<internal domain>), so Darin's 12:00 with
    // a client never attributes Alex's 12:00 phone call. Unknown participants
    // (empty list) or an unhosted interval fall back to the old time-only match.
    const host = (interval.hostname ?? '').toLowerCase();
    const hostEmails = host ? [...ctx.graph.internalDomains].map((d) => `${host}@${d}`) : [];
    for (const ev of events) {
      if (ev.participants?.length && hostEmails.length && !hostEmails.some((e) => ev.participants!.includes(e))) {
        continue;
      }
      if (mid >= ev.startMs && mid < ev.endMs) {
        const confidence = ev.confidence;
        const needsReview = confidence < ctx.config.autoFinalizeThreshold;
        return {
          clientId: ev.clientId,
          clientGroupId: ctx.graph.clients.get(ev.clientId)?.clientGroupId ?? null,
          confidence,
          resolverType: 'calendar_event',
          evidence: {
            reason: `During the meeting "${ev.subject}"`,
            matchedOn: 'calendar',
            matchedValue: ev.subject,
            sourceField: 'context',
            candidates: [{ clientId: ev.clientId, clientName: clientName(ctx.graph, ev.clientId), confidence }],
          },
          needsReview,
        };
      }
    }
    return null;
  },
};
