import type { ClientGraph, Interval } from '@tt/shared';
import { normalizeEntityName } from '@tt/shared';
import type { ResolverContext } from '../src/types';

export function emptyGraph(): ClientGraph {
  return {
    clients: new Map(),
    byEmail: new Map(),
    byDomain: new Map(),
    byQboCompany: new Map(),
    bySheetId: new Map(),
    byCchId: new Map(),
    byFinancialCentsId: new Map(),
    byQboRealm: new Map(),
    folders: [],
    names: [],
    emailSubjects: new Map(),
    staffNameTokens: new Set(),
    calendarEvents: [],
    internalDomains: new Set(['ashfordsky.com']),
    freemailDomains: new Set(['gmail.com', 'yahoo.com', 'outlook.com']),
    vendorDomains: new Set(),
    partnerDomains: new Set(),
  };
}

export function addClient(g: ClientGraph, id: string, name: string, group?: string): string {
  g.clients.set(id, { id, name, clientGroupId: group ?? null, status: 'active' });
  const { norm, tokens } = normalizeEntityName(name);
  if (tokens.length) g.names.push({ norm, tokens, clientId: id, kind: 'client_name' });
  return id;
}

export function addName(
  g: ClientGraph,
  id: string,
  name: string,
  kind: 'entity_name' | 'person_name' | 'client_name' = 'entity_name',
): void {
  const { norm, tokens } = normalizeEntityName(name);
  g.names.push({ norm, tokens, clientId: id, kind });
}

export function addEmail(g: ClientGraph, email: string, id: string): void {
  const arr = g.byEmail.get(email) ?? [];
  arr.push(id);
  g.byEmail.set(email, arr);
}

export function addDomain(g: ClientGraph, domain: string, id: string): void {
  const arr = g.byDomain.get(domain) ?? [];
  arr.push(id);
  g.byDomain.set(domain, arr);
}

export function ctx(graph: ClientGraph, overrides: Partial<ResolverContext> = {}): ResolverContext {
  return {
    graph,
    rules: overrides.rules ?? [],
    config: overrides.config ?? { autoFinalizeThreshold: 0.85, reviewThreshold: 0.5 },
    currentAnchor: overrides.currentAnchor ?? null,
  };
}

export function interval(partial: Partial<Interval> = {}): Interval {
  return {
    id: partial.id ?? 'iv1',
    source: 'test',
    hostname: partial.hostname ?? 'PC',
    startTs: partial.startTs ?? '2026-06-22T16:00:00.000Z',
    endTs: partial.endTs ?? '2026-06-22T16:10:00.000Z',
    durationSeconds: partial.durationSeconds ?? 600,
    app: partial.app ?? null,
    windowTitle: partial.windowTitle ?? null,
    url: partial.url ?? null,
    browser: partial.browser ?? null,
    isAfk: partial.isAfk ?? false,
  };
}
