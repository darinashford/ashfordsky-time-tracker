# Accuracy testing

## The question this answers

> After 1 day and after 7 days, will this actually attribute my time correctly?

## Metrics (the `coverage_report` view + dashboard)

For each local day, by **active duration** (AFK excluded):

- **auto-finalized %** — resolved at ≥0.85, no review needed.
- **suggested %** — resolved at 0.5–0.85 (one-click confirm).
- **needs-review %** — low confidence, ambiguous, or conflicting.
- **unresolved %** — no resolver matched.
- **screenshot-supported %** — backed by an available screenshot.

The dashboard's **Coverage / accuracy** bar shows these; **Top unresolved** lists the
apps/domains/titles eating the most unattributed time — your work-list for mapping.

A healthy trajectory: auto-finalized + suggested climbs while unresolved/needs-review falls
as you create rules.

## What to expect, given your real graph

Coverage of the data the deterministic resolvers rely on, today:

| Signal | Backing data | Day-1 strength |
|---|---|---|
| Email address | `client_aliases.email` — 171 clients | 🟢 strong |
| Email domain | `client_aliases.email_domain` — 133 clients | 🟢 strong |
| Financial Cents id/URL | `source_system_links` — 201/201 clients | 🟢 strong |
| SharePoint folder | `source_system_links` — 184 clients | 🟢 strong |
| Entity / person name in titles | 327 + 269 aliases | 🟡 good |
| CCH Axcess, Google Sheets, Drive, QBO | 0 client mappings yet | 🔴 grows via corrections |

**Day 1:** expect solid auto/suggested coverage from email, Financial Cents, SharePoint, and
name-in-title (CCH windows resolve by name even with no CCH id map). Google Sheets / Drive /
QBO start mostly unresolved.

**Day 7:** as you map the recurring sheets, folders, QBO companies, and domains the
top-unresolved report surfaces, those convert to high-confidence `rule` matches. The 90–95%
target is reached by clearing the *recurring* unresolved items — a handful of mappings
covers most days.

## How to measure

```bash
pnpm ingest --days 7 && pnpm resolve --days 7
pnpm dashboard      # read the Coverage bar per day; page back with ◀
```

Optionally snapshot metrics into `time_tracker.accuracy_snapshots` (a row of `{day, metrics}`)
to chart day-1 vs day-7 over time.

## Tuning

- `AUTO_FINALIZE_THRESHOLD` (0.85) — raise to be more conservative (more suggestions, fewer
  silent finalizations); lower to auto-finalize more.
- `REVIEW_THRESHOLD` (0.5) — boundary between *suggested* and *needs_review*.
- `MIN_INTERVAL_SECONDS` (20) — ignore tiny window flickers so they don't dilute coverage.
- Context window TTL (30 min, `ContextEngine`) — how long carry-forward stays valid.

## The feedback loop

1. Review the day; for any recurring wrong/blank attribution, use **map forever…**.
2. That writes a rule (highest priority).
3. Re-run `pnpm resolve` (or wait for the next scheduled run) — the signal now resolves
   automatically, and rule `hit_count` climbs.

Because corrections target *durable identifiers* (sheet ids, folders, domains, realms), a
correction made once fixes that client forever — which is what drives the system toward
autonomy.
