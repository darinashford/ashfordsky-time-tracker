import type pg from 'pg';
import {
  type ClientGraph,
  type ClientRef,
  emailDomain,
  isGenericSubject,
  normalizeDomain,
  normalizeEntityName,
  normalizeSubject,
  normalizeText,
  tokensSubset,
} from '@tt/shared';

export interface LoadGraphOptions {
  internalDomains: string[];
  freemailDomains: string[];
  /** Client names that are really the firm itself — never match these. */
  internalClientNames?: string[];
}

// Normalized subjects that are just the name of a SaaS/tool the firm uses for
// EVERY client. Their notification emails ("Financial Cents", "RE: Financial
// Cents", "QuickBooks", ...) get filed under whichever client a thread was about,
// which would otherwise teach the subject map to bill that tool's name to one
// client. They carry no client signal — never attribute on them.
const TOOL_SUBJECTS = new Set<string>([
  'financial cents', 'financial cents emails', 'project financial cents',
  'quickbooks', 'quickbooks online', 'intuit', 'qbo',
  'xero', 'gusto', 'ramp', 'bill com', 'melio', 'expensify',
  'karbon', 'canopy', 'taxdome', 'keeper',
]);

function pushList(map: Map<string, string[]>, key: string, value: string): void {
  if (!key) return;
  const arr = map.get(key);
  if (arr) {
    if (!arr.includes(value)) arr.push(value);
  } else {
    map.set(key, [value]);
  }
}

/**
 * Load the canonical client graph from public.* into an in-memory, pre-indexed
 * snapshot. Small dataset (~200 clients / ~1k aliases), so this is fast and lets
 * all matching happen as pure functions in @tt/resolvers.
 *
 * Learned/correction mappings live in time_tracker.attribution_rules and are
 * applied separately by the rule resolver — this stays canonical-only.
 */
export async function loadClientGraph(
  pool: pg.Pool,
  opts: LoadGraphOptions,
): Promise<ClientGraph> {
  const internalDomains = new Set(opts.internalDomains.map(normalizeDomain).filter(Boolean));
  const freemailDomains = new Set(opts.freemailDomains.map(normalizeDomain).filter(Boolean));
  const internalNameSets = (opts.internalClientNames && opts.internalClientNames.length
    ? opts.internalClientNames
    : ['ashford sky']
  )
    .map((n) => normalizeEntityName(n).tokens)
    .filter((t) => t.length > 0);
  const internalClientIds = new Set<string>();

  const graph: ClientGraph = {
    clients: new Map(),
    byEmail: new Map(),
    byDomain: new Map(),
    byQboCompany: new Map(),
    bySheetId: new Map(),
    byCchId: new Map(),
    byFinancialCentsId: new Map(),
    byQboRealm: new Map(),
    byReviewProject: new Map(),
    folders: [],
    names: [],
    emailSubjects: new Map(),
    staffNameTokens: new Set(),
    calendarEvents: [],
    internalDomains,
    freemailDomains,
    vendorDomains: new Set(),
    partnerDomains: new Set(),
  };

  // ---- clients --------------------------------------------------------------
  // Archived clients are excluded from matching: once archived, a client
  // shouldn't pick up new time. Skipping them here also drops their aliases from
  // matching (the alias loader below requires the client to be in graph.clients).
  // Historical rows still display via direct public.clients joins.
  const clients = await pool.query(
    `select id, name, client_group_id, status, primary_domain::text as primary_domain
       from public.clients
      where coalesce(status, 'active') <> 'archived'`,
  );
  for (const r of clients.rows as Array<Record<string, unknown>>) {
    const ref: ClientRef = {
      id: r.id as string,
      name: (r.name as string) ?? '',
      clientGroupId: (r.client_group_id as string) ?? null,
      status: (r.status as string) ?? null,
    };
    graph.clients.set(ref.id, ref);
    const { norm, tokens } = normalizeEntityName(ref.name);
    const dom = normalizeDomain((r.primary_domain as string) ?? '');
    const isInternal =
      (!!dom && internalDomains.has(dom)) ||
      internalNameSets.some((set) => tokensSubset(set, new Set(tokens)));
    if (isInternal) {
      internalClientIds.add(ref.id); // the firm itself — never match it
      continue;
    }
    if (tokens.length) graph.names.push({ norm, tokens, clientId: ref.id, kind: 'client_name' });
  }

  // ---- client group display names -> the group's business entity -------------
  // Group names ("Acme") are the short names people use in titles/meetings,
  // while client rows carry full legal names ("Acme Holdings LLC"). Map a
  // group name to the member whose OWN name carries it — the actual business entity —
  // so "Acme - May Financials" lands on an Acme client. These are
  // family/ownership groups (a group also holds unrelated individuals and sibling
  // entities), so we do NOT roll the whole group up: a group
  // whose name no member carries stays unindexed rather than bill a sibling.
  const cgroups = await pool.query(`select id, name from public.client_groups where name is not null`);
  for (const gr of cgroups.rows as Array<{ id: string; name: string }>) {
    const gname = normalizeEntityName(gr.name);
    if (!gname.tokens.length) continue;
    let rep: string | null = null;
    for (const [id, ref] of graph.clients) {
      if (internalClientIds.has(id) || ref.clientGroupId !== gr.id) continue;
      if (!tokensSubset(gname.tokens, new Set(normalizeEntityName(ref.name).tokens))) continue;
      if (rep === null || id < rep) rep = id; // smallest id among the entities that carry the name
    }
    if (rep) graph.names.push({ norm: gname.norm, tokens: gname.tokens, clientId: rep, kind: 'entity_name' });
  }

  // ---- aliases (email / email_domain / entity_name / person_name) -----------
  const aliases = await pool.query(
    `select subject_id as client_id, alias_type, alias_value, normalized
       from public.client_aliases
      where subject_type = 'client'`,
  );
  for (const r of aliases.rows as Array<Record<string, unknown>>) {
    const clientId = r.client_id as string;
    if (!graph.clients.has(clientId) || internalClientIds.has(clientId)) continue;
    const value = ((r.alias_value as string) ?? '').trim();
    const normalized = ((r.normalized as string) ?? '').trim();
    switch (r.alias_type) {
      case 'email': {
        const email = (normalized || value).toLowerCase();
        if (email && !internalDomains.has(emailDomain(email))) {
          pushList(graph.byEmail, email, clientId);
        }
        break;
      }
      case 'email_domain': {
        const dom = normalizeDomain(normalized || value);
        if (dom && !internalDomains.has(dom) && !freemailDomains.has(dom)) {
          pushList(graph.byDomain, dom, clientId);
        }
        break;
      }
      case 'entity_name': {
        const { norm, tokens } = normalizeEntityName(value);
        if (tokens.length) graph.names.push({ norm, tokens, clientId, kind: 'entity_name' });
        break;
      }
      case 'person_name': {
        const { norm, tokens } = normalizeEntityName(value);
        // Require >=2 tokens for people to avoid matching a lone first name.
        if (tokens.length >= 2) graph.names.push({ norm, tokens, clientId, kind: 'person_name' });
        break;
      }
      default:
        break;
    }
  }

  // ---- Review Tracker projects (notes.ashfordsky.com/projects/{id}) ---------
  // The tracker lives in this same database and names its client on every
  // project, so join it straight through: a project Keith adds there attributes
  // his review time to that client with no sync step.
  const projects = await pool.query(
    `select tp.id::text as project_id, c.id as client_id
       from public.tax_projects tp
       join public.clients c on lower(c.name) = lower(tp.client_name)`,
  );
  for (const r of projects.rows as Array<Record<string, unknown>>) {
    const clientId = r.client_id as string;
    if (!graph.clients.has(clientId) || internalClientIds.has(clientId)) continue;
    graph.byReviewProject.set(r.project_id as string, clientId);
  }

  // ---- source_system_links (client-level external identifiers) --------------
  const links = await pool.query(
    `select internal_record_id as client_id, source_system, external_id, external_url, external_metadata
       from public.source_system_links
      where internal_record_type = 'client'`,
  );
  for (const r of links.rows as Array<Record<string, unknown>>) {
    const clientId = r.client_id as string;
    if (!graph.clients.has(clientId) || internalClientIds.has(clientId)) continue;
    const meta = (r.external_metadata as Record<string, unknown>) ?? {};
    const externalId = r.external_id == null ? '' : String(r.external_id);
    const externalUrl = (r.external_url as string) ?? '';
    switch (r.source_system) {
      case 'financial_cents':
        if (externalId) graph.byFinancialCentsId.set(externalId, clientId);
        break;
      case 'google_sheets':
        if (externalId) graph.bySheetId.set(externalId, clientId);
        break;
      case 'cch_axcess':
        if (externalId) graph.byCchId.set(externalId.toLowerCase(), clientId);
        break;
      case 'qbo': {
        if (externalId) graph.byQboRealm.set(externalId, clientId);
        const company = normalizeText((meta.company_name as string) || (meta.name as string));
        if (company) pushList(graph.byQboCompany, company, clientId);
        break;
      }
      case 'sharepoint':
      case 'google_drive': {
        const raw = externalUrl || externalId || ((meta.folder_url as string) ?? '');
        if (raw) {
          let path = raw;
          try {
            path = decodeURIComponent(raw);
          } catch {
            /* keep raw if malformed encoding */
          }
          graph.folders.push({
            externalId: externalId || null,
            path: path.toLowerCase(),
            clientId,
            sourceSystem: r.source_system as string,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  // ---- vendors + partners (negative signals: not clients) -------------------
  const vendors = await pool.query(
    `select primary_domain::text as d from public.vendors where primary_domain is not null`,
  );
  for (const r of vendors.rows as Array<Record<string, unknown>>) {
    graph.vendorDomains.add(normalizeDomain(r.d as string));
  }
  const vendorAliases = await pool.query(
    `select normalized, alias_value from public.vendor_aliases
      where alias_type in ('email_domain','domain')`,
  );
  for (const r of vendorAliases.rows as Array<Record<string, unknown>>) {
    graph.vendorDomains.add(normalizeDomain((r.normalized as string) || (r.alias_value as string)));
  }
  const partners = await pool.query(
    `select primary_domain::text as d from public.partners where primary_domain is not null`,
  );
  for (const r of partners.rows as Array<Record<string, unknown>>) {
    graph.partnerDomains.add(normalizeDomain(r.d as string));
  }
  graph.vendorDomains.delete('');
  graph.partnerDomains.delete('');

  // ---- email subject -> client (from the firm's already-attributed inbox) ----
  const subjects = await pool.query(
    `select subject, matched_subject_id as client_id
       from public.inbox_messages
      where matched_subject_type = 'client'
        and matched_subject_id is not null
        and coalesce(match_confidence, 1) >= 0.7
        and subject is not null`,
  );
  const tally = new Map<string, Map<string, number>>();
  for (const r of subjects.rows as Array<Record<string, unknown>>) {
    const clientId = r.client_id as string;
    if (!graph.clients.has(clientId) || internalClientIds.has(clientId)) continue;
    const key = normalizeSubject(r.subject as string);
    if (key.length < 6) continue; // skip too-short subjects
    if (isGenericSubject(key)) continue; // "tax question", "documents" — no distinctive token
    if (TOOL_SUBJECTS.has(key)) continue; // SaaS/tool notification, not client work
    let m = tally.get(key);
    if (!m) {
      m = new Map();
      tally.set(key, m);
    }
    m.set(clientId, (m.get(clientId) ?? 0) + 1);
  }
  for (const [key, m] of tally) {
    let best = '';
    let bestN = 0;
    let total = 0;
    for (const [cid, n] of m) {
      total += n;
      if (n > bestN) {
        bestN = n;
        best = cid;
      }
    }
    // Ambiguous when no single client clearly dominates the subject.
    const ambiguous = m.size > 1 && bestN < total * 0.8;
    graph.emailSubjects.set(key, { clientId: best, ambiguous });
  }

  // ---- firm staff first-name tokens (exclude the owner/admin) ----------------
  // staff_users.full_name is null in practice, so derive first names from emails.
  // The admin is the device owner and appears in every meeting, so never a trigger.
  const staff = await pool.query(`select email, role from public.staff_users where is_active = true`);
  for (const r of staff.rows as Array<{ email: string | null; role: string | null }>) {
    if (r.role === 'admin') continue;
    const local = String(r.email ?? '').toLowerCase().split('@')[0] ?? '';
    const token = normalizeText(local.split(/[._-]/)[0] ?? '');
    if (token) graph.staffNameTokens.add(token);
  }

  // ---- meetings -> client (live firm-brain log) ------------------------------
  // public.calendar_events was a one-time backfill (dead since 6/24). public.meetings
  // is the live source (Krisp/firm-brain): started_at/ended_at windows, a title that
  // usually names the client, and the firm-brain's own client links. A human-CONFIRMED
  // link wins; otherwise recognize the client from the title — so "Acme - May
  // Financials" lands on Acme even while the firm-brain still has it quarantined.
  // Shaky auto-links (e.g. a vaguely-named vendor thread mapped to the wrong client)
  // are ignored: better a title match, or nothing, than a wrong bill.

  // Recognize the client named in a meeting title. Matches a client/entity/person
  // name whose tokens are all present in the title, rolled up to the group's
  // canonical; if two *different* clients match, it's ambiguous -> no attribution.
  const clientFromTitle = (title: string): string | null => {
    const titleTokens = new Set(normalizeText(title).split(' ').filter(Boolean));
    if (titleTokens.size === 0) return null;
    const matches: string[] = [];
    for (const n of graph.names) {
      if (internalClientIds.has(n.clientId)) continue;
      if (n.tokens.join('').length < 4) continue; // too short to be distinctive
      if (tokensSubset(n.tokens, titleTokens)) matches.push(n.clientId);
    }
    if (matches.length === 0) return null;
    // Names from two different clients in the title -> ambiguous, don't guess.
    // (Sibling names within one ownership group collapse to one deterministic pick.)
    const groupsOf = new Set(matches.map((id) => graph.clients.get(id)?.clientGroupId ?? id));
    if (groupsOf.size > 1) return null;
    return matches.slice().sort()[0]!;
  };

  // Identify the client from who was actually IN a meeting/call. An external
  // contact's exact email is strong; an unambiguous external domain is weak;
  // internal / freemail / vendor / partner emails never vote. Votes are rolled
  // up to the client GROUP, so a client split into sibling entities (e.g. PAAK
  // HQ / Install / Direct Sales, all on pcraingutters.com) counts as ONE client
  // instead of splitting into a 3-way tie that attributes nothing. A tie between
  // two *different* groups still attributes nothing. Used by both the Krisp
  // meetings log and the Outlook calendar feed below.
  const groupKeyOf = (id: string): string => graph.clients.get(id)?.clientGroupId ?? id;
  const clientFromParticipants = (
    participants: string[],
  ): { clientId: string; confidence: number } | null => {
    const votes = new Map<string, { weight: number; ids: Set<string>; exact: boolean }>();
    const add = (id: string, w: number, exact: boolean): void => {
      const g = groupKeyOf(id);
      const v = votes.get(g) ?? { weight: 0, ids: new Set<string>(), exact: false };
      v.weight += w;
      v.ids.add(id);
      if (exact) v.exact = true;
      votes.set(g, v);
    };
    for (const email of participants) {
      const dom = emailDomain(email);
      if (
        !dom ||
        internalDomains.has(dom) ||
        freemailDomains.has(dom) ||
        graph.vendorDomains.has(dom) ||
        graph.partnerDomains.has(dom)
      ) {
        continue;
      }
      const exact = graph.byEmail.get(email);
      if (exact && exact.length) {
        // One email = one strong vote for its group (dedup sibling entities).
        const seenGroups = new Set<string>();
        for (const id of exact) {
          const g = groupKeyOf(id);
          if (!seenGroups.has(g)) {
            seenGroups.add(g);
            add(id, 3, true);
          }
        }
        continue;
      }
      const byDom = graph.byDomain.get(dom);
      if (byDom && byDom.length && new Set(byDom.map(groupKeyOf)).size === 1) {
        add(byDom[0]!, 1, false);
      }
    }
    let best: { weight: number; ids: Set<string>; exact: boolean } | null = null;
    let bestWeight = 0;
    let tie = false;
    for (const v of votes.values()) {
      if (v.weight > bestWeight) {
        bestWeight = v.weight;
        best = v;
        tie = false;
      } else if (v.weight === bestWeight) {
        tie = true;
      }
    }
    if (!best || tie || bestWeight === 0) return null;
    const clientId = [...best.ids].sort()[0]!;
    if (internalClientIds.has(clientId)) return null;
    return { clientId, confidence: best.exact ? 0.9 : 0.86 };
  };

  const meetings = await pool.query(
    `select m.title, m.started_at, m.ended_at, mcl.client_id,
            (select array_agg(distinct lower(x.email))
               from (select ki.staff_owner_email as email
                       from public.krisp_ingestion_items ki
                      where ki.meeting_id = m.id and ki.staff_owner_email is not null
                     union all
                     select mp.email::text
                       from public.meeting_participants mp
                      where mp.meeting_id = m.id and mp.email is not null) x) as participants
       from public.meetings m
       left join public.meeting_client_links mcl
         on mcl.meeting_id = m.id and mcl.link_status = 'confirmed'
      where m.started_at > now() - interval '45 days'
        and m.ended_at is not null
        and coalesce(m.calendar_match_rejected, false) = false`,
  );
  for (const r of meetings.rows as Array<{
    title: string | null;
    started_at: string;
    ended_at: string;
    client_id: string | null;
    participants: string[] | null;
  }>) {
    const startMs = Date.parse(r.started_at);
    const endMs = Date.parse(r.ended_at);
    if (!(endMs > startMs)) continue;
    const title = r.title ?? 'meeting';

    let clientId: string | null = null;
    let confidence = 0;
    // 1) A human-confirmed firm-brain link is authoritative — keep the exact entity.
    if (r.client_id && graph.clients.has(r.client_id) && !internalClientIds.has(r.client_id)) {
      clientId = r.client_id;
      confidence = 0.92;
    }
    // 2) Otherwise, who was ON the call — an external client contact among the
    // participants identifies it, even when the title is generic ("COGS
    // Discussion"). This spans the meeting's FULL window, so a call that ran past
    // its scheduled slot bills the whole time to that client.
    if (!clientId) {
      const byPeople = clientFromParticipants(r.participants ?? []);
      if (byPeople) {
        clientId = byPeople.clientId;
        confidence = byPeople.confidence;
      }
    }
    // 3) Otherwise recognize the client from the meeting title (rolled up to group).
    if (!clientId) {
      const t = clientFromTitle(title);
      if (t) {
        clientId = t;
        confidence = 0.88;
      }
    }
    if (clientId) {
      graph.calendarEvents.push({
        startMs,
        endMs,
        clientId,
        subject: title,
        confidence,
        participants: (r.participants ?? []).filter(Boolean),
      });
    }
  }

  // ---- Outlook calendars -> client (per-person) ------------------------------
  // public.calendar_events is the staff Outlook feed (every person's calendar,
  // with attendees). Consumed alongside the Krisp meetings log above: each event
  // carries its participants, so the calendar resolver applies it ONLY to the
  // time of people who were in it — Alex's calendar drives Alex's attribution,
  // Darin's drives Darin's. Client = attendee votes (an exact known email is
  // strong; an unambiguous external domain is weak; internal/freemail/vendor/
  // partner domains never vote; ties don't attribute), else the client named in
  // the subject. Harmlessly empty while the Agent-OS feed is down.
  const calRows = await pool.query(
    `select ce.subject, ce.start_at, ce.end_at, lower(ce.organizer_email::text) as organizer,
            coalesce(array_agg(distinct lower(cea.email::text)) filter (where cea.email is not null), '{}') as attendees
       from public.calendar_events ce
       left join public.calendar_event_attendees cea on cea.calendar_event_id = ce.id
      where ce.start_at > now() - interval '45 days'
        and ce.end_at is not null
      group by ce.id, ce.subject, ce.start_at, ce.end_at, ce.organizer_email`,
  );
  for (const r of calRows.rows as Array<{
    subject: string | null;
    start_at: string;
    end_at: string;
    organizer: string | null;
    attendees: string[];
  }>) {
    const startMs = Date.parse(r.start_at);
    const endMs = Date.parse(r.end_at);
    if (!(endMs > startMs)) continue;
    const participants = [...new Set([...(r.attendees ?? []), r.organizer ?? ''].filter(Boolean))];

    const byPeople = clientFromParticipants(participants);
    let clientId: string | null = byPeople?.clientId ?? null;
    let confidence = byPeople?.confidence ?? 0;
    if (!clientId) {
      const t = clientFromTitle(r.subject ?? '');
      if (t) {
        clientId = t;
        confidence = 0.88;
      }
    }
    if (clientId) {
      graph.calendarEvents.push({
        startMs,
        endMs,
        clientId,
        subject: r.subject ?? 'meeting',
        confidence,
        participants,
      });
    }
  }

  return graph;
}
