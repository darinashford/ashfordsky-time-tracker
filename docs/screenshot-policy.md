# Screenshot policy

Screenshots are **conditional evidence**, not the core tracker. They exist only to help you
review low-confidence time. They are **off by default** (`SCREENSHOTS_ENABLED=false`).

## When a screenshot is wanted

The resolver runner flags an interval as `needed` (creates a `time_tracker.screenshots`
row) only when **all** hold:

1. The resolution is **not** high-confidence/confirmed (`auto_finalized`/`confirmed` are
   never captured).
2. A `screenshot_policies` row matches — by default the `low_confidence` policy: capture
   only when `confidence < only_below_confidence` (0.5).
3. The window was **stable** for at least `min_stable_seconds` (interval duration ≥ policy
   threshold).
4. The app/domain/title is **not** in a `no_screenshot` exclusion.

The sidecar (`pnpm screenshots`) then captures — if enabled — stores the file, and flips the
row to `available`.

## Statuses (`screenshot_status`)

`not_needed → optional → needed → available → blocked → deleted`

- **needed** — runner wants evidence; sidecar will capture.
- **available** — captured + stored (path/sha/size recorded).
- **blocked** — capture refused (excluded app, or capture failed).
- **deleted** — soft-deleted (file removed, row retained for audit).

## Policy table (`screenshot_policies`)

| Column | Meaning |
|---|---|
| `only_below_confidence` | Capture only when confidence is below this |
| `min_stable_seconds` | Required window stability |
| `capture_interval_seconds` | Min spacing between captures (for a live loop) |
| `retention_days` | Auto-purge `available` shots older than this |
| `applies_scope` | `low_confidence` \| `app` \| `domain` \| `title` \| `all` |
| `applies_pattern` | Pattern for the non-`low_confidence` scopes |

A default `low_confidence` policy is seeded by the migration.

## Exclusions (`time_tracker.exclusions`, kind `no_screenshot`)

Add via the dashboard ("never screenshot this app/domain") or directly. `pnpm seed` adds a
few defaults (1Password, Bitwarden, chase.com). Banking, password managers, and personal
apps should be excluded.

## Storage adapter

`ScreenshotStorageAdapter` abstracts persistence:

- **LocalStorageAdapter** (MVP): writes PNGs under `SCREENSHOT_DIR/YYYY-MM-DD/uuid.png`,
  records sha256 + byte size.
- **SharePointStorageAdapter** (stub): implement `store()` with a Microsoft Graph upload and
  swap it in via `createStorageAdapter` — no resolver changes needed.

## Capture

`WindowsPowerShellCapturer` grabs the full virtual screen via .NET (no native deps);
`NoopCapturer` is used on other platforms. Capture is best-effort and only runs when
enabled.

## OCR

`OcrAdapter` is defined and called but **stubbed** (`NoopOcrAdapter`). The schema has
`ocr_text` / `ocr_status` ready. Drop in Tesseract.js / Windows.Media.Ocr / a cloud OCR and
write results back; a future `screenshot_ocr` resolver can then re-attribute from the text.

## Retention

`pnpm screenshots` purges `available` shots older than `retention_days` (deletes the file,
soft-deletes the row) on every run.
