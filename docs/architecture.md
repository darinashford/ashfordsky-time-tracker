# Architecture

## Goals

1. Automatically attribute active working time to the correct **client**, by active
   duration — not perfect classification of every window switch.
2. Reuse the existing **client graph** (Supabase `Agent-os` project) as the source of truth.
3. Be **deterministic-first** (no LLM in the hot path), auditable, and self-improving via
   corrections.
4. Keep raw sensor data separate from resolved attribution so classification can be re-run.

## Layers

### 1. Sensor layer (`services/activitywatch-ingestor`)
- Pulls app/window/AFK/web events from the local **ActivityWatch REST API**
  (`http://localhost:5600`) — never the AW database directly.
- Behind a `SensorAdapter` interface (`ActivityWatchAdapter` | `MockAdapter`) so it can be
  swapped for ManicTime or a custom watcher later.
- Normalizes events into `time_tracker.raw_events` (immutable) and merged, AFK-aware
  `time_tracker.intervals` (the unit of attribution).

### 2. Attribution storage (`time_tracker` schema)
Additive schema in the `Agent-os` project. Nothing in `public.*` is modified; the only
coupling is FK references **to** `public.clients` / `public.client_groups`.

| Table | Purpose |
|---|---|
| `raw_events` | Immutable normalized sensor events (re-classifiable) |
| `intervals` | Merged, AFK-aware activity blocks |
| `resolutions` | Current attribution per interval (1:1) |
| `resolution_audit` | Every resolver vote per interval (append-only) |
| `review_queue` | Intervals needing review |
| `corrections` | Every user action, with provenance |
| `attribution_rules` | Durable rules learned from corrections (the learning store) |
| `screenshots` | Conditional screenshot evidence + status lifecycle |
| `screenshot_policies` | When/whether to capture |
| `exclusions` | no-screenshot / non-billable / ignore patterns |
| `current_client_state` | Rolling current-client anchors (auditable context) |
| `accuracy_snapshots` | Day-1 / day-7 metric snapshots |
| `settings` | Editable config |
| `daily_client_summary` *(view)* | Per-day per-client billing rollup |
| `coverage_report` *(view)* | Per-day accuracy/coverage rollup |

### 3. Resolver engine (`packages/resolvers` + `services/resolver-service`)
- The client graph is small (~200 clients / ~1k aliases / ~600 client-level links), so it's
  loaded **into memory** once per run as a pre-indexed `ClientGraph`. All matching is then
  pure TypeScript — fast, DB-agnostic, and unit-testable. (This is also why we **don't** add
  `pg_trgm` or any index to your production DB.)
- Resolvers are **pure functions** `(interval, ctx) => ResolverResult | null`, run in a
  fixed **priority chain**. See [resolver-design.md](resolver-design.md).
- The **context engine** keeps a rolling `current_client` from recent high-confidence
  activity so ambiguous follow-on activity (ChatGPT, a blank tab) can inherit it at reduced
  confidence.

### 4. Review dashboard (`apps/dashboard`)
- Next.js App Router. Server components read `time_tracker` via the `@tt/db` pg layer;
  mutations are **server actions**.
- Daily timeline, per-client billing summary, coverage/accuracy report, top-unresolved,
  CSV export, and all review actions.

### 5. Screenshot sidecar (`services/screenshot-sidecar`)
- Conditional evidence only. Capture (`ScreenCapturer`), storage
  (`ScreenshotStorageAdapter`: local now, SharePoint/Graph later), and OCR (`OcrAdapter`,
  stubbed) are all behind interfaces. See [screenshot-policy.md](screenshot-policy.md).

## Key design decisions

- **Direct Postgres (`pg`) connection, not supabase-js.** Resolvers and reports need
  cross-schema joins and aggregation against the live graph; raw SQL is the right tool and
  avoids exposing `time_tracker` via PostgREST.
- **Corrections write to an overlay, not the canonical graph.** Learned mappings go to
  `time_tracker.attribution_rules`, never to `public.client_aliases` /
  `public.source_system_links`. This experimental tool can't pollute the firm's source of
  truth. A future "promote" step can push proven mappings upstream.
- **Never overconfident.** Ambiguous or conflicting signals become `suggested` /
  `needs_review`, never `auto_finalized`. Multi-client signals (a shared domain) are flagged.
- **Run-from-source monorepo.** No build step for packages/services (tsx + Next transpile);
  fast iteration for a POC.

## Data flow (one interval)

```
interval ─► resolver chain (rule, cch, sheet, folder, email, qbo, fc, excel,
            browser, ai-chat, ocr, context) ─► winner + all votes
         ─► status decision (auto_finalized / suggested / needs_review / unresolved)
         ─► exclusions (non-billable / ignore) ─► resolution + audit (+ review, + screenshot intent)
         ─► context engine updates the rolling anchor
```
