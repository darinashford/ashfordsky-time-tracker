// LLM resolver — final pass over the blocks the deterministic resolvers left
// residual (truly unresolved, or bucketed into an ambiguous "could be a client
// or could be firm tooling" category like ai_assistant / development / email).
// Runs AFTER resolve in the sync, reads each block's title + on-screen OCR +
// nearest-neighbor client, and asks Claude to decide: this client, a non-billable
// category (incl. firm tool-building), or unknown.
//
// Billing-safe: every client attribution is written as 'suggested' with capped
// confidence (< the auto-finalize threshold), so a human always confirms it.
// Opt-in: needs LLM_ENABLED=true and ANTHROPIC_API_KEY.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import {
  assertDatabaseUrl,
  categoryLabel,
  type Interval,
  loadConfig,
  localDate,
  type Resolution,
} from '@tt/shared';
import {
  closePool,
  freezeResolution,
  getIntervalsForDay,
  getOcrTextByInterval,
  getPool,
  getResolutionsForDay,
  loadClientGraph,
  recordLlmUsage,
  resolveReview,
  upsertResolution,
} from '@tt/db';
import { extractSignals } from '@tt/resolvers';
import { classifyBlocks, type LlmBlock, type LlmCandidate } from './llmClassify';

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

// Soft buckets the LLM is allowed to re-judge — the ones that genuinely might be
// a client OR firm tooling. Settled buckets (music, social, firm_internal staff
// meetings, etc.) are left alone.
const SOFT_LLM_CATS = new Set(['ai_assistant', 'development', 'email_admin', 'external_call', 'research']);
// Non-billable category keys the LLM may assign (offered to the model + validated
// on the way back). firm_tooling is the firm's own AI/software building.
const LLM_NONBILLABLE = [
  'firm_tooling', 'firm_admin', 'firm_internal', 'prospecting', 'research', 'personal',
  'ai_assistant', 'development', 'external_call',
];
const NEIGHBOR_MS = 1800 * 1000; // 30 min — same window the deterministic neighbor-fill uses
const OCR_MAX = 1500;
const LLM_CONF_CAP = 0.7; // < AUTO_FINALIZE_THRESHOLD (0.85): LLM never auto-bills

function timeLocal(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.llmEnabled) {
    console.log('[llm] disabled (set LLM_ENABLED=true to run the LLM resolver). Skipping.');
    return;
  }
  if (!cfg.anthropicApiKey) {
    console.log('[llm] ANTHROPIC_API_KEY not set; skipping.');
    return;
  }
  assertDatabaseUrl(cfg);
  const tz = cfg.timezone;
  const pool = getPool(cfg.databaseUrl);

  try {
    const graph = await loadClientGraph(pool, {
      internalDomains: cfg.internalDomains,
      freemailDomains: cfg.freemailDomains,
      internalClientNames: cfg.internalClientNames,
    });

    // Compact 1-based refs the model returns instead of UUIDs (fewer tokens, no
    // UUID transcription errors). Map back to id + group on the way out.
    const candidates: LlmCandidate[] = [];
    const refToClient = new Map<number, { id: string; clientGroupId: string | null }>();
    const sorted = [...graph.clients.values()]
      .filter((c) => c.name && c.name.trim())
      .sort((a, b) => a.name.localeCompare(b.name));
    let ref = 1;
    for (const c of sorted) {
      candidates.push({ ref, name: c.name });
      refToClient.set(ref, { id: c.id, clientGroupId: c.clientGroupId ?? null });
      ref++;
    }
    const cats = LLM_NONBILLABLE.map((k) => ({ key: k, label: categoryLabel(k) }));
    const allowedCat = new Set(LLM_NONBILLABLE);

    const dateArg = arg('--date');
    const days = Number(arg('--days') ?? '1');
    const dates: string[] = [];
    if (dateArg) dates.push(dateArg);
    else {
      const now = Date.now();
      for (let d = 0; d < days; d++) dates.push(localDate(new Date(now - d * 86_400_000).toISOString(), tz));
    }

    console.log(`[llm] model=${cfg.llmModel} clients=${candidates.length} days=${dates.join(',')}`);
    for (const day of dates) await processDay(day);

    async function processDay(day: string): Promise<void> {
      const intervals = await getIntervalsForDay(pool, cfg.schema, day, tz);
      const resolutions = await getResolutionsForDay(pool, cfg.schema, day, tz);
      const ocr = await getOcrTextByInterval(pool, cfg.schema, day, tz);

      // Neighbor hints: every block with a real client attribution, by time.
      const anchors: Array<{ start: number; end: number; name: string }> = [];
      for (const iv of intervals) {
        const r = resolutions.get(iv.id);
        if (r?.clientId && r.confidence >= cfg.reviewThreshold) {
          const name = graph.clients.get(r.clientId)?.name;
          if (name) anchors.push({ start: Date.parse(iv.startTs), end: Date.parse(iv.endTs), name });
        }
      }
      const nearest = (s: number, e: number, dir: 'before' | 'after'): string | null => {
        let best: string | null = null;
        let bestGap = Infinity;
        for (const a of anchors) {
          const gap = dir === 'before' ? (a.end <= s ? s - a.end : -1) : a.start >= e ? a.start - e : -1;
          if (gap >= 0 && gap <= NEIGHBOR_MS && gap < bestGap) {
            best = a.name;
            bestGap = gap;
          }
        }
        return best;
      };

      // Residual = the LLM's worklist: not user/LLM-frozen, and either unresolved
      // or a soft non-billable bucket that might really be a client / firm tooling.
      const residual: Interval[] = [];
      for (const iv of intervals) {
        if (iv.isAfk) continue;
        if (iv.durationSeconds < cfg.minIntervalSeconds) continue;
        if (!iv.app && !iv.windowTitle) continue; // nothing to read
        const r = resolutions.get(iv.id);
        if (!r) continue;
        if (r.resolverVersion === 'manual' || r.resolverVersion === 'llm') continue; // frozen
        const isResidual =
          r.status === 'unresolved' ||
          (r.status === 'nonbillable' && !!r.category && SOFT_LLM_CATS.has(r.category));
        if (isResidual) residual.push(iv);
      }

      if (!residual.length) {
        console.log(`[llm] ${day}: no residual blocks.`);
        return;
      }

      // Cap per run, longest-first (most billing impact). Log any drop — a silent
      // cap would read as "covered everything".
      residual.sort((a, b) => b.durationSeconds - a.durationSeconds);
      const dropped = Math.max(0, residual.length - cfg.llmMaxBlocks);
      const sent = dropped ? residual.slice(0, cfg.llmMaxBlocks) : residual;

      const blocks: LlmBlock[] = sent.map((iv, i) => {
        const sg = extractSignals(iv);
        const r = resolutions.get(iv.id)!;
        const o = ocr.get(iv.id) ?? null;
        return {
          index: i,
          app: iv.app ?? null,
          title: iv.windowTitle ?? null,
          host: sg.host || null,
          durationMin: Math.max(1, Math.round(iv.durationSeconds / 60)),
          timeLocal: timeLocal(iv.startTs, tz),
          currentBucket: r.status === 'nonbillable' ? r.category ?? 'nonbillable' : 'unresolved',
          neighborBefore: nearest(Date.parse(iv.startTs), Date.parse(iv.endTs), 'before'),
          neighborAfter: nearest(Date.parse(iv.startTs), Date.parse(iv.endTs), 'after'),
          ocr: o ? o.replace(/\s+/g, ' ').trim().slice(0, OCR_MAX) : null,
        };
      });

      const { decisions, answered, usage } = await classifyBlocks({
        apiKey: cfg.anthropicApiKey,
        model: cfg.llmModel,
        candidates,
        nonbillableCategories: cats,
        blocks,
        log: (m) => console.log(m),
      });

      const ivByIndex = new Map(blocks.map((b, i) => [b.index, sent[i]!]));
      const decided = new Set<number>();
      let nClient = 0;
      let nNon = 0;
      let nUnknown = 0;

      for (const d of decisions) {
        const iv = ivByIndex.get(d.index);
        if (!iv) continue;
        decided.add(d.index);

        if (d.decision === 'client' && d.clientRef != null && refToClient.has(d.clientRef)) {
          const { id, clientGroupId } = refToClient.get(d.clientRef)!;
          const conf = Math.min(LLM_CONF_CAP, Math.max(cfg.reviewThreshold, d.confidence || cfg.reviewThreshold));
          const res: Resolution = {
            intervalId: iv.id,
            clientId: id,
            clientGroupId,
            status: 'suggested', // never auto-finalized — a human confirms
            confidence: conf,
            resolverType: 'llm',
            isBillable: true,
            needsReview: false,
            evidence: {
              reason: `LLM: ${d.reason}`.slice(0, 200),
              matchedOn: 'llm',
              sourceField: 'context',
              llmConfidence: d.confidence,
            },
            resolverVersion: 'llm',
            category: null,
          };
          await upsertResolution(pool, cfg.schema, res);
          await resolveReview(pool, cfg.schema, iv.id);
          nClient++;
        } else if (d.decision === 'nonbillable' && d.category && allowedCat.has(d.category)) {
          const res: Resolution = {
            intervalId: iv.id,
            clientId: null,
            clientGroupId: null,
            status: 'nonbillable',
            confidence: Math.max(0, Math.min(1, d.confidence || 0)),
            resolverType: 'llm',
            isBillable: false,
            needsReview: false,
            evidence: { reason: `LLM: ${d.reason}`.slice(0, 200), category: d.category, llm: true },
            resolverVersion: 'llm',
            category: d.category,
          };
          await upsertResolution(pool, cfg.schema, res);
          await resolveReview(pool, cfg.schema, iv.id);
          nNon++;
        } else {
          // 'unknown', or an invalid client ref / category. Freeze as 'llm' so the
          // model isn't re-billed for the same dead-end block every sync cycle.
          await freezeResolution(pool, cfg.schema, iv.id, 'llm', {
            llm: 'unknown',
            llmReason: (d.reason || '').slice(0, 200),
          });
          nUnknown++;
        }
      }

      // A block whose chunk WAS answered but the model omitted → freeze as unknown
      // (it saw it, no opinion). A block whose chunk ERRORED (not in `answered`) is
      // left untouched so it retries next run — a transient outage must not poison
      // the worklist by freezing everything.
      let retry = 0;
      for (const b of blocks) {
        if (decided.has(b.index)) continue;
        if (!answered.has(b.index)) {
          retry++;
          continue;
        }
        await freezeResolution(pool, cfg.schema, ivByIndex.get(b.index)!.id, 'llm', { llm: 'no_answer' });
        nUnknown++;
      }

      // Record token usage + cost for the in-dashboard meter (one row per run/day).
      await recordLlmUsage(pool, cfg.schema, {
        day,
        model: cfg.llmModel,
        calls: usage.calls,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        costUsd: usage.costUsd,
        blocks: sent.length,
      });

      console.log(
        `[llm] ${day}: residual=${residual.length} sent=${sent.length} ` +
          `client=${nClient} nonbillable=${nNon} unknown=${nUnknown}` +
          (retry ? ` retry_next_run=${retry}` : '') +
          (dropped ? ` dropped=${dropped} (over LLM_MAX_BLOCKS=${cfg.llmMaxBlocks})` : '') +
          ` cost=${(usage.costUsd * 100).toFixed(2)}¢ (${usage.calls} calls)`,
      );
    }
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error('[llm] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
