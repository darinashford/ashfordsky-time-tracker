import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import {
  assertDatabaseUrl,
  bucketFor,
  categorizeActivity,
  categoryLabel,
  type Exclusion,
  type Interval,
  isRealtimeCall,
  loadConfig,
  localDate,
  type Resolution,
} from '@tt/shared';
import {
  appendAnchor,
  bumpRuleHits,
  closePool,
  type DayResolutionRow,
  deleteResolution,
  enqueueReview,
  ensureScreenshotIntent,
  getIntervalsForDay,
  getOcrTextByInterval,
  getPool,
  getResolutionsForDay,
  loadActivePolicies,
  loadClientGraph,
  loadEnabledRules,
  loadExclusions,
  replaceAudit,
  resolveReview,
  setIntervalsAfk,
  upsertResolution,
} from '@tt/db';
import { ContextEngine, extractSignals, runResolvers } from '@tt/resolvers';
import { matchExclusion } from './exclusionMatch';
import { decideScreenshot } from './screenshotPolicy';

for (const p of ['.env', '../.env', '../../.env', '../../../.env']) {
  const f = resolve(process.cwd(), p);
  if (existsSync(f)) {
    dotenv.config({ path: f });
    break;
  }
}

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const NEIGHBOR_TTL_SECONDS = 1800;

// Idle (AFK) handling. AW flags "afk" after ~3 min with no input, but most idle
// is reading at the desk or sitting on a call, not time away. We promote the
// billable part of idle — a scheduled meeting, a call, or reading a client's
// work (carried forward) — into active time, and leave locked / personal / long
// stretches as away. The "long stretch" cutoff is cfg.awayCutoffSeconds, shared
// with the dashboard's idle breakdown so both agree on what counts as away.

/**
 * Seconds in each AFK interval's contiguous idle stretch (back-to-back AFK
 * intervals within 2 min), so a long stretch away can be told from short pauses.
 */
/** Resolution → the day-row shape the runner tracks (for the call-run pass). */
function asDayRow(r: Resolution): DayResolutionRow {
  return {
    intervalId: r.intervalId,
    status: r.status,
    clientId: r.clientId,
    clientGroupId: r.clientGroupId,
    confidence: r.confidence,
    resolverType: r.resolverType,
    resolverVersion: r.resolverVersion ?? null,
    category: r.category ?? null,
  };
}

function computeIdleRuns(intervals: Interval[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < intervals.length; ) {
    if (!intervals[i]!.isAfk) {
      i++;
      continue;
    }
    let j = i;
    let total = 0;
    let lastEnd = Date.parse(intervals[i]!.startTs);
    const ids: string[] = [];
    // Bridge coverage gaps up to 5 min so a long idle stretch isn't fragmented by
    // the periodic blips that punctuate it — most notably the 10-min sync task's
    // own terminal window, which leaves a ~2.5-min hole in window coverage. A tight
    // 2-min bridge split an hour at lunch into sub-grace runs that then flipped
    // back to "active" and re-billed.
    while (j < intervals.length && intervals[j]!.isAfk && Date.parse(intervals[j]!.startTs) - lastEnd <= 300_000) {
      total += intervals[j]!.durationSeconds;
      lastEnd = Date.parse(intervals[j]!.endTs);
      ids.push(intervals[j]!.id);
      j++;
    }
    for (const id of ids) out.set(id, total);
    i = j;
  }
  return out;
}

interface Counters {
  auto: number;
  suggested: number;
  review: number;
  unresolved: number;
  nonbillable: number;
  screenshots: number;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  assertDatabaseUrl(cfg);
  const tz = cfg.timezone;
  const pool = getPool(cfg.databaseUrl);
  const resolverConfig = {
    autoFinalizeThreshold: cfg.autoFinalizeThreshold,
    reviewThreshold: cfg.reviewThreshold,
  };

  try {
    const graph = await loadClientGraph(pool, {
      internalDomains: cfg.internalDomains,
      freemailDomains: cfg.freemailDomains,
      internalClientNames: cfg.internalClientNames,
    });
    const rules = await loadEnabledRules(pool, cfg.schema);
    const exclusions = await loadExclusions(pool, cfg.schema);
    const policies = await loadActivePolicies(pool, cfg.schema);
    const billingExclusions = exclusions.filter((e) => e.kind === 'nonbillable' || e.kind === 'ignore');
    const noScreenshotExclusions = exclusions.filter((e) => e.kind === 'no_screenshot');

    console.log(
      `[resolver] graph: ${graph.clients.size} clients, ${graph.byDomain.size} domains, ` +
        `${graph.folders.length} folders, ${graph.names.length} names, ` +
        `${graph.emailSubjects.size} subjects; ${rules.length} rules.`,
    );

    const dateArg = arg('--date');
    const days = Number(arg('--days') ?? '1');
    const dates: string[] = [];
    if (dateArg) dates.push(dateArg);
    else {
      const now = Date.now();
      for (let d = 0; d < days; d++) dates.push(localDate(new Date(now - d * 86_400_000).toISOString(), tz));
    }

    const ruleIdsHit = new Set<string>();
    const totals: Counters = { auto: 0, suggested: 0, review: 0, unresolved: 0, nonbillable: 0, screenshots: 0 };

    for (const day of dates) {
      const counts = await processDay(day);
      console.log(
        `[resolver] ${day}: auto=${counts.auto} suggested=${counts.suggested} ` +
          `review=${counts.review} unresolved=${counts.unresolved} nonbillable=${counts.nonbillable} ` +
          `screenshots=${counts.screenshots}`,
      );
      (Object.keys(totals) as Array<keyof Counters>).forEach((k) => (totals[k] += counts[k]));
    }

    if (ruleIdsHit.size) await bumpRuleHits(pool, cfg.schema, [...ruleIdsHit]);

    console.log(
      `[resolver] done. auto=${totals.auto} suggested=${totals.suggested} review=${totals.review} ` +
        `unresolved=${totals.unresolved} nonbillable=${totals.nonbillable} screenshots=${totals.screenshots}`,
    );

    async function processDay(day: string): Promise<Counters> {
      const allIntervals = await getIntervalsForDay(pool, cfg.schema, day, tz);
      const existing = await getResolutionsForDay(pool, cfg.schema, day, tz);
      const ocrByInterval = await getOcrTextByInterval(pool, cfg.schema, day, tz);
      const counts: Counters = { auto: 0, suggested: 0, review: 0, unresolved: 0, nonbillable: 0, screenshots: 0 };
      const promotedIds: string[] = [];
      // Live view of every interval's resolution as this pass writes them (seeded
      // with what's already in the DB) — the call-run pass reads the whole day.
      const currentRes = new Map<string, DayResolutionRow>(existing);

      // A block that lands as "away" idle must not keep a stale billable/
      // non-billable resolution from a time it was active — is_afk can flip
      // active->idle as the normalizer / afk feed is refined. Clear it (and its
      // review + audit) so away actually means away. Manual rows are never touched.
      async function clearIfResolved(id: string): Promise<void> {
        const prior = existing.get(id);
        if (prior && prior.resolverVersion !== 'manual') {
          await deleteResolution(pool, cfg.schema, id);
          currentRes.delete(id);
        }
      }

      // One person's timeline at a time. Context carry-forward, neighbor fill,
      // idle runs, and call runs are all "what were YOU doing around then" logic —
      // mixing hosts lets one person's meeting/work bleed onto a coworker's blocks
      // that merely overlap in time.
      const byHost = new Map<string, typeof allIntervals>();
      for (const iv of allIntervals) {
        const k = iv.hostname ?? '';
        const arr = byHost.get(k);
        if (arr) arr.push(iv);
        else byHost.set(k, [iv]);
      }

      for (const intervals of byHost.values()) {
      const engine = new ContextEngine({ ttlSeconds: NEIGHBOR_TTL_SECONDS });
      const resolvedAnchors: Array<{ start: number; end: number; clientId: string; clientGroupId: string | null; confidence: number }> = [];
      const unresolvedIntervals: typeof intervals = [];
      const idleRuns = computeIdleRuns(intervals);

      for (const iv of intervals) {
        // A short no-input stretch (< idle grace, default 10 min) is a pause at
        // the desk — reading, thinking, listening on a call — not real idle.
        // ActivityWatch flags AFK after ~3 min, which is too eager; here we hand
        // such a block back to the normal active path so it counts and inherits
        // the surrounding client (carry-forward). Only genuinely long idle
        // (>= grace) takes the away/call idle branch below.
        if (iv.isAfk && (idleRuns.get(iv.id) ?? iv.durationSeconds) < cfg.idleGraceSeconds) {
          iv.isAfk = false;
          promotedIds.push(iv.id);
        }
        if (iv.isAfk) {
          // Idle = a no-input stretch >= the idle grace. Recover the billable part
          // — a meeting, a call, or reading a client's work — and promote it into
          // active time; leave no-window filler, locked/personal, and long
          // stretches (> away cutoff, and not a live call) as away.
          if (!iv.app || iv.durationSeconds < cfg.minIntervalSeconds) continue;
          // Respect a manual attribution on idle time too: promote it so it counts,
          // and don't re-resolve over your decision — a call you confirmed keeps its
          // client through the listening (idle) stretches instead of reverting.
          const priorIdle = existing.get(iv.id);
          if (priorIdle && priorIdle.resolverVersion === 'manual') {
            promotedIds.push(iv.id);
            if (priorIdle.status === 'confirmed' && priorIdle.clientId) {
              engine.observe(iv, {
                clientId: priorIdle.clientId,
                clientGroupId: priorIdle.clientGroupId,
                confidence: 0.99,
                resolverType: 'manual',
                evidence: { reason: 'User-confirmed' },
                needsReview: false,
              });
            }
            continue;
          }
          const sg = extractSignals(iv);
          const cat = categorizeActivity(
            { appNorm: sg.appNorm, host: sg.host, title: iv.windowTitle, url: iv.url },
            { staffNameTokens: graph.staffNameTokens },
          );
          // A live external CALL is engaged time even across a long silent stretch
          // (you're listening), so it's exempt from the "away" cutoff. An internal
          // meeting (firm_internal) is NOT: a Teams chat/meeting left focused while
          // you're gone shouldn't bill an hour of "internal" time, so it falls under
          // the away cutoff like any other long idle. A real client call still
          // survives — it identifies to the client and the call-run pass carries it.
          const onCall = cat?.key === 'external_call';
          if (!onCall && (idleRuns.get(iv.id) ?? iv.durationSeconds) > cfg.awayCutoffSeconds) {
            await clearIfResolved(iv.id);
            continue;
          }
          if (cat?.tier === 'hard') { await clearIfResolved(iv.id); continue; } // locked/social/music — stay away
          const idleCtx = { graph, rules, config: resolverConfig, currentAnchor: engine.anchorFor(iv), ocrText: null };
          const { resolution: idleRes, winner: idleWinner } = runResolvers(iv, idleCtx);
          const idleBucket = bucketFor(
            { clientId: idleRes.clientId, resolverType: idleRes.resolverType, confidence: idleRes.confidence },
            cat,
            resolverConfig.reviewThreshold,
          );
          // Past the idle grace, no-input time only counts as work when you were
          // ON A CALL — a scheduled meeting (calendar/Krisp) or a live call app —
          // because listening is working. It deliberately does NOT count merely
          // because the last thing on screen belonged to a client: that let a
          // 25-minute absence bill to whoever you last touched, which is what made
          // a day of stepping away read as one unbroken block of work.
          const inMeeting = idleRes.resolverType === 'calendar_event';
          if (!idleBucket && idleRes.clientId && idleRes.confidence >= resolverConfig.reviewThreshold
              && (onCall || inMeeting)) {
            // Counts: you were in a call/meeting with this client, just not typing.
            await upsertResolution(pool, cfg.schema, idleRes);
            currentRes.set(iv.id, asDayRow(idleRes));
            promotedIds.push(iv.id);
            if (idleRes.status === 'auto_finalized') counts.auto++;
            else if (idleRes.status === 'suggested') counts.suggested++;
            else {
              await enqueueReview(
                pool,
                cfg.schema,
                iv.id,
                String((idleRes.evidence as Record<string, unknown>)?.reason ?? 'Review'),
                Math.min(100, Math.round(iv.durationSeconds / 60)),
              );
              counts.review++;
            }
            if (idleWinner) engine.observe(iv, idleWinner);
            resolvedAnchors.push({
              start: Date.parse(iv.startTs),
              end: Date.parse(iv.endTs),
              clientId: idleRes.clientId,
              clientGroupId: idleRes.clientGroupId,
              confidence: idleRes.confidence,
            });
          } else if (idleBucket === 'external_call' || idleBucket === 'firm_internal') {
            // Engaged but non-billable: a prospect/vendor call or an internal staff
            // meeting. Promote so it counts + itemizes in its bucket; never billed.
            const promotedRes: Resolution = {
              ...idleRes,
              clientId: null,
              clientGroupId: null,
              status: 'nonbillable',
              isBillable: false,
              needsReview: false,
              category: idleBucket,
              evidence: {
                ...(idleRes.evidence as Record<string, unknown>),
                reason: categoryLabel(idleBucket),
                category: idleBucket,
              },
            };
            await upsertResolution(pool, cfg.schema, promotedRes);
            currentRes.set(iv.id, asDayRow(promotedRes));
            promotedIds.push(iv.id);
            counts.nonbillable++;
          } else {
            // anything else idle -> stays away (and must not keep a stale resolution)
            await clearIfResolved(iv.id);
          }
          continue;
        }

        const prior = existing.get(iv.id);
        // Two kinds of rows are frozen so the deterministic pass leaves them be:
        //  - 'manual' = YOUR corrections (always win, and confirmed ones anchor
        //    carry-forward for neighbors).
        //  - 'llm'    = the LLM pass already judged this residual block; re-running
        //    deterministic rules can't beat it, and re-touching would let the next
        //    LLM pass re-bill the same block. Advisory only — never anchors.
        // Everything else (machine non-billable buckets) stays re-evaluable.
        if (prior && (prior.resolverVersion === 'manual' || prior.resolverVersion === 'llm')) {
          if (prior.resolverVersion === 'manual' && prior.status === 'confirmed' && prior.clientId) {
            engine.observe(iv, {
              clientId: prior.clientId,
              clientGroupId: prior.clientGroupId,
              confidence: 0.99,
              resolverType: 'manual',
              evidence: { reason: 'User-confirmed' },
              needsReview: false,
            });
          }
          continue;
        }

        // Sub-threshold slivers (title flicker — Teams and friends churn the window
        // title for a second or two) still get resolved, so they inherit the right
        // client from their own title ("Meridian Update | Teams" -> Meridian) or the
        // context anchor instead of sitting unresolved. A 2-second block, though,
        // shouldn't drive audit, the review queue, a screenshot, the context anchor,
        // or neighbor fill — so it bails out right after writing its resolution.
        const tiny = iv.durationSeconds < cfg.minIntervalSeconds;

        const signals = extractSignals(iv);
        const ctx = {
          graph,
          rules,
          config: resolverConfig,
          currentAnchor: engine.anchorFor(iv),
          ocrText: ocrByInterval.get(iv.id) ?? null,
        };
        const { resolution, votes, winner } = runResolvers(iv, ctx);

        const billEx: Exclusion | null = matchExclusion(signals, billingExclusions);
        const cat = categorizeActivity(
          { appNorm: signals.appNorm, host: signals.host, title: iv.windowTitle, url: iv.url },
          { staffNameTokens: graph.staffNameTokens },
        );
        const bucket = billEx
          ? (cat?.key ?? 'excluded')
          : bucketFor(resolution, cat, resolverConfig.reviewThreshold);
        let final: Resolution = resolution;
        if (bucket) {
          const reason = billEx
            ? `Non-billable: matched exclusion "${billEx.pattern}"`
            : (cat?.label ?? 'Non-billable');
          final = {
            ...resolution,
            clientId: null,
            clientGroupId: null,
            status: 'nonbillable',
            isBillable: false,
            needsReview: false,
            category: bucket,
            evidence: { ...(resolution.evidence as Record<string, unknown>), reason, category: bucket },
          };
        }

        await upsertResolution(pool, cfg.schema, final);
        currentRes.set(iv.id, asDayRow(final));

        if (final.status === 'auto_finalized') counts.auto++;
        else if (final.status === 'suggested') counts.suggested++;
        else if (final.status === 'nonbillable') counts.nonbillable++;
        else if (final.status === 'unresolved') counts.unresolved++;

        if (tiny) continue; // resolved quietly above; no audit/review/screenshot/anchor/neighbor

        await replaceAudit(
          pool,
          cfg.schema,
          iv.id,
          votes.map((v) => ({
            resolverType: v.resolverType,
            clientId: v.clientId,
            confidence: v.confidence,
            matched: true,
            evidence: v.evidence as Record<string, unknown>,
          })),
        );

        if (final.status === 'needs_review') {
          const reason = String((final.evidence as Record<string, unknown>)?.reason ?? 'Needs review');
          await enqueueReview(pool, cfg.schema, iv.id, reason, Math.min(100, Math.round(iv.durationSeconds / 60)));
          counts.review++;
        } else {
          await resolveReview(pool, cfg.schema, iv.id);
        }

        // Screenshot intent (skip excluded apps/domains; never high-confidence).
        const shotBlocked = !!matchExclusion(signals, noScreenshotExclusions);
        if (!shotBlocked) {
          const decision = decideScreenshot(signals, final, policies, iv.durationSeconds);
          if (decision) {
            const created = await ensureScreenshotIntent(pool, cfg.schema, {
              intervalId: iv.id,
              status: 'needed',
              reason: decision.reason,
              app: iv.app ?? null,
              windowTitle: iv.windowTitle ?? null,
            });
            if (created) counts.screenshots++;
          }
        }

        engine.observe(iv, winner);
        if (engine.current && engine.current.sourceIntervalId === iv.id) {
          await appendAnchor(pool, cfg.schema, engine.current);
        }
        if (winner?.resolverType === 'rule') {
          const ruleId = (winner.evidence as Record<string, unknown>)?.ruleId;
          if (typeof ruleId === 'string') ruleIdsHit.add(ruleId);
        }

        if (final.clientId && final.confidence >= resolverConfig.reviewThreshold) {
          resolvedAnchors.push({
            start: Date.parse(iv.startTs),
            end: Date.parse(iv.endTs),
            clientId: final.clientId,
            clientGroupId: final.clientGroupId,
            confidence: final.confidence,
          });
        } else if (final.status === 'unresolved') {
          // Only truly-unresolved intervals are eligible for neighbor fill —
          // never non-billable ones (e.g. YouTube) that also have no client.
          unresolvedIntervals.push(iv);
        }
      }

      // Call-run continuity: one contiguous stretch of call activity is ONE call.
      // Krisp/calendar records can end before the call actually does (a meeting
      // logged 8:30–8:49 that really ran to 9:40), which would strand the tail in
      // the prospects/vendors bucket. So when any block in a run was identified
      // to a client by a DIRECT signal (calendar, meetings log, rule, manual,
      // title…), the unidentified call blocks in the same run inherit that client
      // as "suggested". Indirect guesses (carry-forward / neighbor / a previous
      // call_run pass) never seed a run, so a genuinely unidentified prospect
      // call still lands in its bucket instead of billing the previous client.
      const INDIRECT_TYPES = new Set(['context_carry_forward', 'neighbor', 'call_run']);
      const callIvs = intervals
        .filter((iv) => {
          const sg = extractSignals(iv);
          return isRealtimeCall(sg.appNorm, sg.host, iv.windowTitle);
        })
        .sort((a, b) => Date.parse(a.startTs) - Date.parse(b.startTs));
      const callRuns: Interval[][] = [];
      for (const iv of callIvs) {
        const run = callRuns[callRuns.length - 1];
        const prevEnd = run ? Date.parse(run[run.length - 1]!.endTs) : null;
        if (run && prevEnd !== null && Date.parse(iv.startTs) - prevEnd <= 120_000) run.push(iv);
        else callRuns.push([iv]);
      }
      for (const run of callRuns) {
        const anchors = run
          .map((iv) => ({ iv, r: currentRes.get(iv.id) }))
          .filter(
            (a): a is { iv: Interval; r: DayResolutionRow } =>
              !!a.r?.clientId &&
              Number(a.r.confidence) >= resolverConfig.reviewThreshold &&
              !INDIRECT_TYPES.has(a.r.resolverType ?? '') &&
              a.r.resolverVersion !== 'llm',
          );
        if (anchors.length === 0) continue;
        for (const iv of run) {
          const r = currentRes.get(iv.id);
          if (!r || r.category !== 'external_call') continue;
          if (r.resolverVersion === 'manual' || r.resolverVersion === 'llm') continue;
          // Nearest identified block in time wins (handles back-to-back calls
          // with different clients inside one run).
          const mid = (Date.parse(iv.startTs) + Date.parse(iv.endTs)) / 2;
          let best = anchors[0]!;
          let bestGap = Number.POSITIVE_INFINITY;
          for (const a of anchors) {
            const as = Date.parse(a.iv.startTs);
            const ae = Date.parse(a.iv.endTs);
            const gap = ae <= mid ? mid - ae : as >= mid ? as - mid : 0;
            if (gap < bestGap) {
              bestGap = gap;
              best = a;
            }
          }
          const clientName = graph.clients.get(best.r.clientId!)?.name ?? 'this client';
          const runRes: Resolution = {
            intervalId: iv.id,
            clientId: best.r.clientId,
            clientGroupId: best.r.clientGroupId,
            status: 'suggested',
            confidence: 0.7,
            resolverType: 'call_run',
            isBillable: true,
            needsReview: false,
            evidence: {
              reason: `Same continuous call as the identified ${clientName} meeting — the call kept going past its logged end.`,
              sourceField: 'context',
              candidates: [{ clientId: best.r.clientId, clientName, confidence: 0.7 }],
            },
            resolverVersion: '0.1.0',
            category: null,
          };
          await upsertResolution(pool, cfg.schema, runRes);
          currentRes.set(iv.id, asDayRow(runRes));
          if (counts.nonbillable > 0) counts.nonbillable--;
          counts.suggested++;
        }
      }

      // Neighbor fill: borrow from the nearest confident neighbor in time.
      for (const iv of unresolvedIntervals) {
        const s = Date.parse(iv.startTs);
        const e = Date.parse(iv.endTs);
        let best: { clientId: string; clientGroupId: string | null; gap: number } | null = null;
        for (const a of resolvedAnchors) {
          const gap = a.end <= s ? s - a.end : a.start >= e ? a.start - e : 0;
          if (gap <= NEIGHBOR_TTL_SECONDS * 1000 && (!best || gap < best.gap)) {
            best = { clientId: a.clientId, clientGroupId: a.clientGroupId, gap };
          }
        }
        if (!best) continue;
        const neighborRes: Resolution = {
          intervalId: iv.id,
          clientId: best.clientId,
          clientGroupId: best.clientGroupId,
          status: 'needs_review',
          confidence: 0.45,
          resolverType: 'neighbor',
          isBillable: true,
          needsReview: true,
          evidence: { reason: 'Borrowed from adjacent attributed activity', sourceField: 'context' },
          resolverVersion: 'neighbor',
        };
        await upsertResolution(pool, cfg.schema, neighborRes);
        await enqueueReview(pool, cfg.schema, iv.id, 'Neighbor-borrowed attribution', 1);
        counts.unresolved--;
        counts.review++;
      }
      } // end per-host pass

      // Promote billable idle (meeting / call / reading) into active so it counts
      // toward active + billable everywhere; locked/personal/long idle stays away.
      await setIntervalsAfk(pool, cfg.schema, promotedIds, false);

      return counts;
    }
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error('[resolver] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
