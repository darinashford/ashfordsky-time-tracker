'use server';

import { revalidatePath } from 'next/cache';
import { normalizeDomain, normalizeText, type Resolution } from '@tt/shared';
import {
  createIngestToken,
  getResolution,
  countClientsForTitlePattern,
  insertCorrection,
  insertExclusion,
  requestTokenRotation,
  resolveReview,
  softDeleteScreenshot,
  upsertResolution,
  upsertRule,
} from '@tt/db';
import { correctionToRuleSpec } from '@tt/resolvers';
import { getDb } from './db';
import { getViewerScope } from './viewer';
import { deriveLearn, describeLearn } from './learn';

const str = (fd: FormData, k: string): string => String(fd.get(k) ?? '');
const opt = (fd: FormData, k: string): string | undefined => {
  const v = fd.get(k);
  return v ? String(v) : undefined;
};

async function clientGroup(
  pool: ReturnType<typeof getDb>['pool'],
  clientId: string | null,
): Promise<string | null> {
  if (!clientId) return null;
  const r = await pool.query(`select client_group_id from public.clients where id = $1`, [clientId]);
  return (r.rows[0]?.client_group_id as string) ?? null;
}

export async function confirmAction(fd: FormData): Promise<void> {
  const { pool, schema } = getDb();
  const date = str(fd, 'date');
  const intervalId = str(fd, 'intervalId');
  const existing = await getResolution(pool, schema, intervalId);
  const clientId = opt(fd, 'clientId') ?? existing?.clientId ?? null;
  if (!clientId) return;
  const res: Resolution = {
    intervalId,
    clientId,
    clientGroupId: await clientGroup(pool, clientId),
    status: 'confirmed',
    confidence: 1,
    resolverType: 'manual',
    isBillable: existing?.isBillable ?? true,
    needsReview: false,
    evidence: { reason: 'User-confirmed' },
    resolverVersion: 'manual',
  };
  await upsertResolution(pool, schema, res);
  await resolveReview(pool, schema, intervalId);
  await insertCorrection(pool, schema, {
    intervalId,
    action: opt(fd, 'clientId') ? 'change_client' : 'confirm',
    oldClientId: existing?.clientId ?? null,
    newClientId: clientId,
  });
  revalidatePath(`/day/${date}`);
}

export interface SetClientState {
  done: boolean;
  count: number;
  /** Human phrase for the rule created, or null when nothing generalized. */
  learned: string | null;
  error?: string;
}

/**
 * Reassign a block to a client straight from Raw Data — and learn it. Sets the
 * block to that client (confirmed, so re-resolves never overwrite it), records
 * the correction, and, when the block carries a generalizable signal, creates a
 * durable rule so the engine attributes similar blocks itself going forward.
 * Returns a result the picker shows: how many blocks changed and what (if
 * anything) it remembered.
 */
export async function setClientAction(_prev: SetClientState, fd: FormData): Promise<SetClientState> {
  const { pool, schema } = getDb();
  // A rolled-up cluster sends every block id it covers (comma-separated).
  const ids = str(fd, 'intervalId').split(',').map((s) => s.trim()).filter(Boolean);
  const clientId = str(fd, 'clientId');
  const date = str(fd, 'date');
  const learn = fd.get('learn') != null;
  if (!ids.length || !clientId) return { done: false, count: 0, learned: null, error: 'Pick a client first.' };

  const ivq = await pool.query(
    `select id, hostname, app, window_title, url from ${schema}.intervals where id = any($1::uuid[])`,
    [ids],
  );
  if (!ivq.rows.length) return { done: false, count: 0, learned: null, error: 'Those blocks no longer exist.' };
  const iv = ivq.rows[0] as { hostname: string | null; window_title: string | null; url: string | null };

  // Non-owners may only correct their own machine's blocks.
  const scope = await getViewerScope();
  if (!scope.isOwner && scope.selfHost && iv.hostname && iv.hostname !== scope.selfHost)
    return { done: false, count: 0, learned: null, error: 'You can only reassign your own time.' };

  const clientGroupId = await clientGroup(pool, clientId);
  for (const row of ivq.rows as Array<{ id: string }>) {
    const existing = await getResolution(pool, schema, row.id);
    await upsertResolution(pool, schema, {
      intervalId: row.id,
      clientId,
      clientGroupId,
      status: 'confirmed',
      confidence: 1,
      resolverType: 'manual',
      isBillable: true,
      needsReview: false,
      evidence: { reason: 'You set the client from Raw Data', manual: true },
      resolverVersion: 'manual',
    });
    await resolveReview(pool, schema, row.id);
    await insertCorrection(pool, schema, {
      intervalId: row.id,
      action: 'change_client',
      oldClientId: existing?.clientId ?? null,
      newClientId: clientId,
    });
  }

  let learnedDesc: string | null = null;
  if (learn) {
    const signal = deriveLearn(iv.url, iv.window_title);
    const mapped = signal
      ? signal.kind === 'host'
        ? { action: 'map_url', payload: { host: signal.value, clientId } }
        : { action: 'map_missive', payload: { kind: 'label', value: signal.value, clientId } }
      : null;
    const spec = mapped ? correctionToRuleSpec({ action: mapped.action, clientId, payload: mapped.payload }) : null;
    // Refuse to learn a title token the firm's own data says isn't a client
    // identifier: if direct evidence already ties it to several DIFFERENT
    // clients, it's a generic word or a shared tool ("bookkeeping", "pdfgear"),
    // and a rule on it would mis-bill every future block that contains it. The
    // reassignment still fixes this block — we just don't generalise from it.
    let tooBroad: string | null = null;
    if (spec && spec.ruleType === 'title_pattern') {
      const spread = await countClientsForTitlePattern(pool, schema, spec.pattern);
      if (spread.distinctClients >= 3) {
        tooBroad = `“${spec.pattern}” already shows up on ${spread.distinctClients} different clients’ work, so it isn’t a ${''}client identifier — this block was fixed, but no rule was made.`;
      }
    }
    if (spec && !tooBroad) {
      const ruleId = await upsertRule(pool, schema, {
        ruleType: spec.ruleType,
        matchKind: spec.matchKind,
        pattern: spec.pattern,
        normalized: spec.normalized,
        clientId: spec.clientId,
        sourceSystem: spec.sourceSystem ?? null,
        confidence: spec.confidence,
        priority: spec.priority,
      });
      await insertCorrection(pool, schema, { intervalId: ids[0]!, action: 'create_rule', newClientId: clientId, createdRuleId: ruleId });
      learnedDesc = describeLearn(iv.url, iv.window_title);
    } else if (tooBroad) {
      learnedDesc = tooBroad;
    }
  }
  revalidatePath(`/raw/${date}`);
  revalidatePath(`/day/${date}`);
  return { done: true, count: ivq.rows.length, learned: learnedDesc };
}

export async function nonbillableAction(fd: FormData): Promise<void> {
  const { pool, schema } = getDb();
  const date = str(fd, 'date');
  const intervalId = str(fd, 'intervalId');
  const existing = await getResolution(pool, schema, intervalId);
  await upsertResolution(pool, schema, {
    intervalId,
    clientId: existing?.clientId ?? null,
    clientGroupId: existing?.clientGroupId ?? null,
    status: 'nonbillable',
    confidence: existing?.confidence ?? 0,
    resolverType: existing?.resolverType ?? 'manual',
    isBillable: false,
    needsReview: false,
    evidence: { reason: 'Marked non-billable' },
    resolverVersion: 'manual',
  });
  await resolveReview(pool, schema, intervalId);
  await insertCorrection(pool, schema, { intervalId, action: 'nonbillable', oldClientId: existing?.clientId ?? null });
  revalidatePath(`/day/${date}`);
}

const PAYLOAD_KEYS = [
  'clientId', 'domain', 'sheetId', 'path', 'folderUrl', 'host', 'pattern',
  'cchId', 'company', 'realm', 'value', 'kind', 'sourceSystem', 'matchKind', 'ruleType',
];

/** Create a durable mapping rule from a correction and apply it to the interval. */
export async function mappingAction(fd: FormData): Promise<void> {
  const { pool, schema } = getDb();
  const date = str(fd, 'date');
  const intervalId = str(fd, 'intervalId');
  const action = str(fd, 'action');
  const payload: Record<string, string> = {};
  for (const k of PAYLOAD_KEYS) {
    const v = opt(fd, k);
    if (v) payload[k] = v;
  }
  const spec = correctionToRuleSpec({ action, clientId: payload.clientId, payload });
  if (!spec) return;
  const ruleId = await upsertRule(pool, schema, {
    ruleType: spec.ruleType,
    matchKind: spec.matchKind,
    pattern: spec.pattern,
    normalized: spec.normalized,
    clientId: spec.clientId,
    sourceSystem: spec.sourceSystem ?? null,
    confidence: spec.confidence,
    priority: spec.priority,
  });
  await insertCorrection(pool, schema, {
    intervalId,
    action,
    newClientId: spec.clientId,
    payload,
    createdRuleId: ruleId,
  });
  await upsertResolution(pool, schema, {
    intervalId,
    clientId: spec.clientId,
    clientGroupId: await clientGroup(pool, spec.clientId),
    status: 'confirmed',
    confidence: spec.confidence,
    resolverType: 'rule',
    isBillable: true,
    needsReview: false,
    evidence: { reason: `Mapped forever via ${spec.ruleType}`, ruleId },
    resolverVersion: 'manual',
  });
  await resolveReview(pool, schema, intervalId);
  revalidatePath(`/day/${date}`);
}

export async function deleteScreenshotAction(fd: FormData): Promise<void> {
  const { pool, schema } = getDb();
  const date = str(fd, 'date');
  await softDeleteScreenshot(pool, schema, str(fd, 'screenshotId'));
  await insertCorrection(pool, schema, { action: 'delete_screenshot', payload: { screenshotId: str(fd, 'screenshotId') } });
  revalidatePath(`/day/${date}`);
}

export async function neverScreenshotAction(fd: FormData): Promise<void> {
  const { pool, schema } = getDb();
  const date = str(fd, 'date');
  const field = (opt(fd, 'field') ?? 'app') as 'app' | 'domain' | 'title';
  const pattern = str(fd, 'pattern');
  if (!pattern) return;
  await insertExclusion(pool, schema, {
    kind: 'no_screenshot',
    field,
    matchKind: field === 'domain' ? 'domain' : 'contains',
    pattern,
    normalized: field === 'domain' ? normalizeDomain(pattern) : normalizeText(pattern),
  });
  await insertCorrection(pool, schema, { intervalId: str(fd, 'intervalId'), action: 'never_screenshot', payload: { field, pattern } });
  revalidatePath(`/day/${date}`);
}

export async function splitAction(fd: FormData): Promise<void> {
  const { pool, schema } = getDb();
  const date = str(fd, 'date');
  const intervalId = str(fd, 'intervalId');
  const r = await pool.query(
    `select start_ts, end_ts, source, hostname, app, window_title, url, browser, is_afk
       from ${schema}.intervals where id = $1`,
    [intervalId],
  );
  if (!r.rows.length) return;
  const iv = r.rows[0];
  const mid = new Date((Date.parse(iv.start_ts) + Date.parse(iv.end_ts)) / 2).toISOString();
  await pool.query(
    `update ${schema}.intervals
        set end_ts = $2::timestamptz, duration_seconds = extract(epoch from ($2::timestamptz - start_ts)), updated_at = now()
      where id = $1`,
    [intervalId, mid],
  );
  const ins = await pool.query(
    `insert into ${schema}.intervals
       (source,hostname,start_ts,end_ts,duration_seconds,app,window_title,url,browser,is_afk,dedupe_key)
     values ($1,$2,$3::timestamptz,$4::timestamptz, extract(epoch from ($4::timestamptz-$3::timestamptz)),$5,$6,$7,$8,$9,$10)
     returning id`,
    [iv.source, iv.hostname, mid, iv.end_ts, iv.app, iv.window_title, iv.url, iv.browser, iv.is_afk, `${intervalId}:split:${mid}`],
  );
  const orig = await getResolution(pool, schema, intervalId);
  if (orig) await upsertResolution(pool, schema, { ...orig, intervalId: ins.rows[0].id });
  revalidatePath(`/day/${date}`);
}

export async function mergeUpAction(fd: FormData): Promise<void> {
  const { pool, schema } = getDb();
  const date = str(fd, 'date');
  const intervalId = str(fd, 'intervalId');
  const cur = await pool.query(`select start_ts, end_ts from ${schema}.intervals where id = $1`, [intervalId]);
  if (!cur.rows.length) return;
  const prev = await pool.query(
    `select id from ${schema}.intervals where start_ts < $1::timestamptz order by start_ts desc limit 1`,
    [cur.rows[0].start_ts],
  );
  if (!prev.rows.length) return;
  await pool.query(
    `update ${schema}.intervals
        set end_ts = greatest(end_ts, $2::timestamptz),
            duration_seconds = extract(epoch from (greatest(end_ts, $2::timestamptz) - start_ts)),
            updated_at = now()
      where id = $1`,
    [prev.rows[0].id, cur.rows[0].end_ts],
  );
  await pool.query(`delete from ${schema}.intervals where id = $1`, [intervalId]);
  revalidatePath(`/day/${date}`);
}

/**
 * Bulk-confirm every "suggested" block for a client on a day — or for all clients
 * when no clientId is given. Clears a day's suggestions in one click. Freezes them
 * as manual (so a re-resolve won't revert them) and resolves their review queue.
 */
export async function confirmAllSuggestedAction(fd: FormData): Promise<void> {
  const { pool, schema, cfg } = getDb();
  const date = str(fd, 'date');
  const clientId = opt(fd, 'clientId') ?? null; // null => every client
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  const res = await pool.query(
    `update ${schema}.resolutions r
        set status = 'confirmed', confidence = 1, resolver_type = 'manual',
            resolver_version = 'manual', needs_review = false,
            evidence = coalesce(r.evidence, '{}'::jsonb) || jsonb_build_object('reason', 'Bulk-confirmed'),
            updated_at = now()
       from ${schema}.intervals i
      where r.interval_id = i.id
        and r.status = 'suggested'
        and r.client_id is not null
        and ($1::uuid is null or r.client_id = $1::uuid)
        and (i.start_ts at time zone $2)::date = $3::date
      returning r.interval_id`,
    [clientId, cfg.timezone, date],
  );
  const ids = res.rows.map((x) => x.interval_id as string);
  if (ids.length) {
    await pool.query(
      `update ${schema}.review_queue set status = 'resolved', resolved_at = now()
         where interval_id = any($1::uuid[]) and status = 'open'`,
      [ids],
    );
    await pool.query(
      `insert into ${schema}.corrections (interval_id, action, new_client_id, note)
       select r.interval_id, 'confirm', r.client_id, 'Bulk confirm suggested'
         from ${schema}.resolutions r where r.interval_id = any($1::uuid[])`,
      [ids],
    );
  }
  revalidatePath(`/day/${date}`);
}

/**
 * Convert a local wall-clock date+time in `tz` to a UTC Date. Node has no zone
 * database API for this direction, so try the plausible US offsets and keep the
 * one that round-trips to the same wall-clock in `tz` (DST-safe).
 */
function zonedToUtc(date: string, time: string, tz: string): Date {
  for (const off of ['-06:00', '-07:00', '-05:00', '-04:00', '-08:00']) {
    const d = new Date(`${date}T${time}:00${off}`);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const hh = get('hour') === '24' ? '00' : get('hour');
    if (`${get('year')}-${get('month')}-${get('day')}` === date && `${hh}:${get('minute')}` === time) return d;
  }
  return new Date(`${date}T${time}:00-06:00`);
}

/**
 * Log a manual time block from the Today view: a real interval (source='manual')
 * plus a confirmed manual resolution, so it flows through every view like any
 * other block. The sync never touches it (clearIngestRange / pruneIntervalsExcept
 * both preserve intervals with a resolver_version='manual' resolution, and the
 * resolver freezes manual rows), and it can be deleted again from the same list.
 */
export async function manualEntryAction(fd: FormData): Promise<void> {
  const { pool, schema, cfg } = getDb();
  const date = str(fd, 'date');
  const start = str(fd, 'start');
  const minutes = Math.round(Number(str(fd, 'minutes')));
  const clientId = str(fd, 'clientId');
  const note = str(fd, 'note').trim();
  const billable = fd.get('billable') != null;
  // Manual entries always land on the signed-in person's own machine.
  const scope = await getViewerScope();
  const host = scope.selfHost ?? opt(fd, 'host') ?? null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  if (!/^\d{2}:\d{2}$/.test(start)) return;
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) return;
  if (!clientId) return;

  const startTs = zonedToUtc(date, start, cfg.timezone);
  const endTs = new Date(startTs.getTime() + minutes * 60_000);
  const ins = await pool.query(
    `insert into ${schema}.intervals
       (source,hostname,start_ts,end_ts,duration_seconds,app,window_title,url,browser,is_afk,dedupe_key)
     values ('manual',$1,$2::timestamptz,$3::timestamptz,$4,'Manual entry',$5,null,null,false,$6)
     returning id`,
    [host, startTs.toISOString(), endTs.toISOString(), minutes * 60, note || 'Manual entry', `manual|${crypto.randomUUID()}`],
  );
  const intervalId = ins.rows[0].id as string;
  const res: Resolution = {
    intervalId,
    clientId,
    clientGroupId: await clientGroup(pool, clientId),
    status: 'confirmed',
    confidence: 1,
    resolverType: 'manual',
    isBillable: billable,
    needsReview: false,
    evidence: { reason: 'Manually logged by you', note: note || null, manual: true },
    resolverVersion: 'manual',
  };
  await upsertResolution(pool, schema, res);
  revalidatePath(`/day/${date}`);
  revalidatePath(`/raw/${date}`);
}

export interface MintTokenState {
  ok: boolean;
  host?: string;
  token?: string; // plaintext, shown ONCE — only its hash is stored
  error?: string;
}

/**
 * Mint a sync token for a new person from the Settings page (replaces the
 * mint-token CLI). Returns the plaintext token to render once; it cannot be
 * recovered afterwards. The dashboard's M365 login is the auth gate.
 */
export async function mintTokenAction(_prev: MintTokenState, fd: FormData): Promise<MintTokenState> {
  if (!(await getViewerScope()).isOwner) return { ok: false, error: 'Only the owner can manage tokens.' };
  const { pool, schema } = getDb();
  const host = str(fd, 'host').trim().toLowerCase();
  const label = str(fd, 'label').trim();
  if (!/^[a-z][a-z0-9-]{1,29}$/.test(host)) {
    return { ok: false, error: 'Short id must be 2–30 chars: letters/numbers/dashes, starting with a letter (e.g. "jane").' };
  }
  const dup = await pool.query(
    `select 1 from ${schema}.ingest_tokens where hostname = $1 and not revoked limit 1`,
    [host],
  );
  if (dup.rows.length) {
    return { ok: false, error: `"${host}" already has an active token. Revoke it first to issue a new one.` };
  }
  const { token } = await createIngestToken(pool, schema, { hostname: host, label: label || null });
  revalidatePath('/settings');
  return { ok: true, host, token };
}

/** Enable/disable an attribution rule from the Rules audit. Any signed-in staff
 *  member can toggle rules (they apply firm-wide); the app is behind SSO, so a
 *  caller is always an authenticated @ashfordsky user. A disabled rule stops
 *  matching on the next resolve; nothing is deleted. */
export async function toggleRuleAction(fd: FormData): Promise<void> {
  const { pool, schema } = getDb();
  const ruleId = str(fd, 'ruleId');
  const enable = fd.get('enable') != null;
  if (!ruleId) return;
  // Enabling by hand is a human judgement the auto-sweep must respect: mark it
  // reviewed so the nightly audit never turns it back off, and clear any note
  // from a previous auto-disable.
  await pool.query(
    `update ${schema}.attribution_rules
        set enabled = $2,
            human_reviewed = case when $2 then true else human_reviewed end,
            auto_disabled_reason = case when $2 then null else auto_disabled_reason end,
            updated_at = now()
      where id = $1`,
    [ruleId, enable],
  );
  revalidatePath('/rules');
}

/** Revoke a person's sync token — their agent stops being able to send time. */
export async function revokeTokenAction(fd: FormData): Promise<void> {
  if (!(await getViewerScope()).isOwner) return;
  const { pool, schema } = getDb();
  const tokenId = str(fd, 'tokenId');
  if (!tokenId) return;
  await pool.query(`update ${schema}.ingest_tokens set revoked = true where id = $1`, [tokenId]);
  revalidatePath('/settings');
}

/**
 * Remote token rotation — zero action on the teammate machine. Their next sync
 * response carries a fresh token; the agent rewrites its own .env; the new
 * token's first use promotes it. Old token keeps working until then (no outage).
 */
export async function rotateTokenAction(fd: FormData): Promise<void> {
  if (!(await getViewerScope()).isOwner) return;
  const { pool, schema } = getDb();
  const tokenId = str(fd, 'tokenId');
  if (!tokenId) return;
  await requestTokenRotation(pool, schema, tokenId);
  revalidatePath('/settings');
}

/** Delete a manually-logged block (only source='manual' rows can be deleted). */
export async function deleteManualEntryAction(fd: FormData): Promise<void> {
  const { pool, schema } = getDb();
  const date = str(fd, 'date');
  const intervalId = str(fd, 'intervalId');
  if (!intervalId) return;
  // Only the owner can delete someone else's manual rows.
  const scope = await getViewerScope();
  await pool.query(
    `delete from ${schema}.intervals where id = $1 and source = 'manual' and ($2::text is null or hostname = $2)`,
    [intervalId, scope.isOwner ? null : scope.selfHost],
  );
  revalidatePath(`/day/${date}`);
  revalidatePath(`/raw/${date}`);
}
