// LLM classifier for the residual/ambiguous time blocks the deterministic
// resolvers couldn't settle. One Claude call per chunk of blocks, with a forced
// tool so the output is always a parseable array. Billing-safe by construction:
// the caller caps every client attribution to "suggested" (a human confirms it),
// and the prompt is told to prefer non-billable / unknown over guessing a client.
//
// Why this is an LLM job and not another deterministic resolver: it has to read
// intent. "Claude — help me build the firm's time tracker" is firm tooling
// (non-billable); "Claude — draft a 1120-S basis memo for Granite" is Granite's
// work. The title/OCR carry that signal; only a model can weigh it.
import Anthropic from '@anthropic-ai/sdk';

/** One residual block handed to the model. */
export interface LlmBlock {
  index: number; // stable id used to map the decision back to the interval
  app: string | null;
  title: string | null;
  host: string | null;
  durationMin: number;
  timeLocal: string; // "14:32"
  currentBucket: string; // what deterministic resolve called it (e.g. 'ai_assistant', 'unresolved')
  neighborBefore: string | null; // client active just before (weak hint)
  neighborAfter: string | null; // client active just after (weak hint)
  ocr: string | null; // on-screen text, when a screenshot was OCR'd
}

export interface LlmCandidate {
  ref: number; // compact 1-based handle the model returns instead of a UUID
  name: string;
}

export interface LlmDecision {
  index: number;
  decision: 'client' | 'nonbillable' | 'unknown';
  clientRef: number | null;
  category: string | null;
  confidence: number;
  reason: string;
}

export interface ClassifyOptions {
  apiKey: string;
  model: string;
  candidates: LlmCandidate[];
  nonbillableCategories: Array<{ key: string; label: string }>;
  blocks: LlmBlock[];
  chunkSize?: number;
  log?: (m: string) => void;
}

export interface ClassifyResult {
  decisions: LlmDecision[];
  /**
   * Block indices whose chunk returned a valid result (the model answered the
   * chunk, even if it omitted some blocks within it). Blocks NOT in this set
   * belong to a chunk that errored/refused — the caller must leave those for a
   * later run, never freeze them, so a transient outage can't poison the worklist.
   */
  answered: Set<number>;
  /** Token usage + estimated USD cost across all chunks, for the cost meter. */
  usage: { calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number };
}

const TOOL_NAME = 'record_classifications';

// $ per token (input, output). Used to estimate the in-dashboard cost meter;
// approximate by design. Unknown models fall back to Haiku (the default).
const PRICES: Record<string, { in: number; out: number }> = {
  'claude-haiku-4-5': { in: 1 / 1e6, out: 5 / 1e6 },
  'claude-sonnet-4-6': { in: 3 / 1e6, out: 15 / 1e6 },
  'claude-opus-4-8': { in: 5 / 1e6, out: 25 / 1e6 },
  'claude-opus-4-7': { in: 5 / 1e6, out: 25 / 1e6 },
  'claude-fable-5': { in: 10 / 1e6, out: 50 / 1e6 },
};

function systemPrompt(
  candidates: LlmCandidate[],
  cats: Array<{ key: string; label: string }>,
): Anthropic.TextBlockParam[] {
  const instructions = `You attribute residual computer-activity blocks for a small CPA firm, Ashford Sky CPA. Each block is a stretch of time on one app/window the firm's automatic rules could not confidently assign. For each block decide ONE of:

- "client"      — the block is clearly THIS client's accounting/tax/advisory work.
- "nonbillable" — real work, but not billable to a client (firm operations, internal tool-building, prospecting, personal, etc.). Pick the best category key.
- "unknown"     — not enough signal to say. This is a fine, common answer.

RULES — read carefully:

1. Billing safety. Only choose "client" when the block's OWN content shows that client — their name, their entity, their people, their project, or an email to/from them. The client who was active just before or after is a WEAK hint, never proof: people switch clients constantly. When the evidence is thin, choose "nonbillable" or "unknown", never a guessed client. A human reviews every "client" answer, so false "unknown" is cheap and a false "client" is costly.

2. Firm tool-building is NON-BILLABLE. The firm owner builds the firm's own software and AI tooling — this very time tracker, automations, dashboards, MCP servers, prompts, scripts. AI-assistant (Claude/ChatGPT) and developer (VS Code, Cursor, terminal, GitHub) blocks are very often this. If the block is about building/debugging the firm's own tools or software, choose "nonbillable" with category "firm_tooling". Only map AI/dev time to a client when it is unmistakably doing that client's books or return.

3. Evidence order. On-screen OCR text (when present) is the strongest signal — it's what was actually on screen. The window title is next. The neighbor hints are weakest. Ignore generic chrome ("Inbox", "New message", app names).

4. Confidence is 0..1 and should reflect how sure you are. Be honest; low confidence is expected for thin blocks.

CATEGORY KEYS for "nonbillable":
${cats.map((c) => `- ${c.key}: ${c.label}`).join('\n')}

Call ${TOOL_NAME} exactly once with one entry per block index. Return clientRef (the number from the client list) only when decision is "client"; return category only when decision is "nonbillable".`;

  const roster =
    `CLIENT LIST (use the ref number as clientRef):\n` +
    candidates.map((c) => `${c.ref}\t${c.name}`).join('\n');

  // Both blocks are stable for the whole run; cache the pair so each chunk after
  // the first only pays cache-read for the (large) roster + instructions.
  return [
    { type: 'text', text: instructions },
    { type: 'text', text: roster, cache_control: { type: 'ephemeral' } },
  ];
}

const TOOL: Anthropic.Tool = {
  name: TOOL_NAME,
  description: 'Record one classification per block.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      classifications: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            index: { type: 'integer', description: 'The block index being classified.' },
            decision: { type: 'string', enum: ['client', 'nonbillable', 'unknown'] },
            clientRef: {
              type: ['integer', 'null'],
              description: 'Client ref number when decision is "client", else null.',
            },
            category: {
              type: ['string', 'null'],
              description: 'Non-billable category key when decision is "nonbillable", else null.',
            },
            confidence: { type: 'number', description: '0..1' },
            reason: { type: 'string', description: 'Short justification (<=140 chars).' },
          },
          required: ['index', 'decision', 'confidence', 'reason'],
        },
      },
    },
    required: ['classifications'],
  },
};

function blockLines(blocks: LlmBlock[]): string {
  return blocks
    .map((b) => {
      const parts = [
        `#${b.index}`,
        `time=${b.timeLocal}`,
        `dur=${b.durationMin}m`,
        `bucket=${b.currentBucket}`,
        b.app ? `app=${b.app}` : '',
        b.host ? `host=${b.host}` : '',
        b.title ? `title=${JSON.stringify(b.title)}` : '',
        b.neighborBefore ? `prev_client=${JSON.stringify(b.neighborBefore)}` : '',
        b.neighborAfter ? `next_client=${JSON.stringify(b.neighborAfter)}` : '',
        b.ocr ? `screen_text=${JSON.stringify(b.ocr)}` : '',
      ].filter(Boolean);
      return parts.join('  ');
    })
    .join('\n');
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Classify all blocks. Returns one decision per block the model answered for;
 * a chunk that errors (network/refusal/parse) is skipped and logged, never
 * fatal — a bad LLM run must not take down the sync.
 */
export async function classifyBlocks(opts: ClassifyOptions): Promise<ClassifyResult> {
  const log = opts.log ?? (() => {});
  const answered = new Set<number>();
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
  if (!opts.blocks.length) return { decisions: [], answered, usage };
  const client = new Anthropic({ apiKey: opts.apiKey });
  const price = PRICES[opts.model] ?? PRICES['claude-haiku-4-5']!;
  const system = systemPrompt(opts.candidates, opts.nonbillableCategories);
  const chunks = chunk(opts.blocks, opts.chunkSize ?? 20);
  const decisions: LlmDecision[] = [];

  for (const group of chunks) {
    try {
      // Forced tool use — guarantees a structured array. (Adaptive thinking is
      // omitted: it's incompatible with forcing a specific tool, and per-block
      // classification with explicit rules doesn't need it.)
      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model: opts.model,
        max_tokens: Math.min(8192, 512 + group.length * 220),
        system,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: TOOL_NAME },
        messages: [
          {
            role: 'user',
            content:
              `Classify these ${group.length} block(s). One entry per index.\n\n` + blockLines(group),
          },
        ],
      };
      // `effort` is only valid on Opus 4.5+/Sonnet 4.6/Fable — Haiku 4.5 (our
      // default) 400s on it. Add it only where supported, to trim cost on Opus.
      if (/opus|fable|sonnet-4-6/i.test(opts.model)) {
        params.output_config = { effort: 'low' };
      }
      const res = await client.messages.create(params);

      // Count usage for every response we got back (we pay for it even on a
      // refusal/no-tool result). cache reads bill at ~0.1x input.
      const u = res.usage;
      const inTok = u.input_tokens ?? 0;
      const cacheRead = u.cache_read_input_tokens ?? 0;
      const outTok = u.output_tokens ?? 0;
      usage.calls += 1;
      usage.inputTokens += inTok;
      usage.outputTokens += outTok;
      usage.cacheReadTokens += cacheRead;
      usage.costUsd += inTok * price.in + cacheRead * price.in * 0.1 + outTok * price.out;

      if (res.stop_reason === 'refusal') {
        log(`[llm] chunk refused (${group.length} blocks); skipping`);
        continue;
      }
      const toolUse = res.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === TOOL_NAME,
      );
      const raw = (toolUse?.input as { classifications?: unknown })?.classifications;
      if (!Array.isArray(raw)) {
        log(`[llm] chunk returned no classifications; skipping`);
        continue;
      }
      // The chunk produced a valid result — its blocks count as answered even if
      // the model omitted some (those become "unknown"/frozen by the caller).
      for (const b of group) answered.add(b.index);
      const valid = new Set(group.map((b) => b.index));
      for (const d of raw as Array<Record<string, unknown>>) {
        const index = Number(d.index);
        const decision = d.decision;
        if (!valid.has(index)) continue;
        if (decision !== 'client' && decision !== 'nonbillable' && decision !== 'unknown') continue;
        decisions.push({
          index,
          decision,
          clientRef: d.clientRef == null ? null : Number(d.clientRef),
          category: typeof d.category === 'string' ? d.category : null,
          confidence: Number.isFinite(Number(d.confidence)) ? Number(d.confidence) : 0,
          reason: typeof d.reason === 'string' ? d.reason : '',
        });
      }
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        log(`[llm] chunk failed (${err.status} ${err.name}): ${err.message}; will retry next run`);
      } else {
        log(`[llm] chunk failed: ${err instanceof Error ? err.message : String(err)}; will retry next run`);
      }
    }
  }
  return { decisions, answered, usage };
}
