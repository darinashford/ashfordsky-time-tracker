# Resolver design

A resolver is a **pure function** `(interval, ctx) => ResolverResult | null`. The runner
executes them in a fixed **priority order** and the first match wins; all matches are stored
in `resolution_audit` so you can always see why.

## Priority chain

| # | Resolver | Signal | Typical confidence |
|---|---|---|---|
| 0 | `rule` | Learned correction rules (overlay) | rule-defined (0.8–0.98) |
| 1 | `cch_axcess` | CCH app + client id / name in title | 0.9 |
| 2 | `google_sheet_id` | Sheet id in URL → mapped client | 0.95 |
| 3 | `sharepoint_folder` / `google_drive_folder` | URL under a mapped client folder | 0.92 |
| 4 | `email_address` / `email_domain` | Address/domain in title or site host | 0.92 / 0.85 |
| 5 | `qbo` | QBO realm id, or company name in title | 0.95 / 0.8 |
| 6 | `financial_cents` | FC client id in URL, or name in title | 0.96 / 0.8 |
| 7 | `excel_path` | Client name in Excel file/window title | ≤0.78 |
| 8 | `browser_title` | Client name in any browser tab title | ≤0.7 |
| 9 | `ai_chat` | Client name in ChatGPT/Claude title | ≤0.66 |
| 10 | `screenshot_ocr` | OCR text (stub for now) | — |
| 11 | `context_carry_forward` | Rolling current client | ≤0.6 |
| 12 | `neighbor` | Nearest attributed neighbor in time | 0.45 |

## Confidence → status

`packages/resolvers/src/registry.ts`:

- `needsReview` (ambiguous/conflict) → **needs_review**
- else `confidence ≥ AUTO_FINALIZE_THRESHOLD` (0.85) → **auto_finalized**
- else `confidence ≥ REVIEW_THRESHOLD` (0.5) → **suggested**
- else → **needs_review**
- no match → **unresolved**

## Ambiguity & conflict (never overconfident)

- A signal that maps to **multiple clients** (e.g. a domain shared by related clients) is
  returned with lowered confidence (<0.5), `needsReview = true`, and all candidates listed
  in the evidence.
- If two **independent direct-evidence** resolvers name **different** clients, the winner is
  forced to `needs_review` (we don't silently pick one).

## Context engine

`ContextEngine` keeps a rolling anchor: when an interval resolves via strong **direct**
evidence (≥0.8, not contextual), it becomes the `current_client` for up to 30 minutes.
The `context_carry_forward` resolver returns that client at ~0.7× confidence. Every anchor
change is persisted to `current_client_state` for audit. Example: CCH for Client A → you
switch to Claude with no client in the title → the Claude block inherits Client A as a
*suggestion*.

## Negative signals

- Internal domains (`ashfordsky.com`) are never attributed.
- Free-mail domains match only on an **exact address**, never the whole domain.
- `vendors` / `partners` domains are excluded (they're not clients).

## Corrections → durable rules

`correctionToRuleSpec` (pure, tested) maps a dashboard action to a rule:

| Action | Rule created |
|---|---|
| Map this Google Sheet → client | `google_sheet_id` exact |
| Map domain → client | `email_domain` exact |
| Map this SharePoint/Drive folder → client | `sharepoint_folder`/`google_drive_folder` contains |
| Map site host → client | `url_host` exact |
| Map Missive address/label | `email` exact / `title_pattern` contains |
| Map CCH id | `cch_client_id` contains |
| Map QBO realm/company | `qbo_realm` exact / `qbo_company` contains |
| Confirm / change client / non-billable | (no rule; sets the resolution) |

Rules live in `time_tracker.attribution_rules`, are the highest-priority resolver, and are
upserted idempotently on `(rule_type, match_kind, normalized)`.

## Extending

Add a resolver in `packages/resolvers/src/resolvers/`, export it from `resolvers/index.ts`,
and insert it at the right spot in `DEFAULT_RESOLVERS` (`registry.ts`). Add its id to
`RESOLVER_TYPES` in `@tt/shared`. Write a unit test with a fabricated `ClientGraph`
(see `packages/resolvers/test/`).
