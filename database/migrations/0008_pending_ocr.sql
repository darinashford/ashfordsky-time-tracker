-- 0008_pending_ocr.sql
-- Token-mode screenshots for teammate machines. A teammate's machine has NO
-- database access, so it can't write to the screenshots table directly (like the
-- owner's sidecar does). Instead it captures + OCRs locally and POSTs only the
-- extracted TEXT to /api/ingest/ocr with its token. That text lands here, keyed by
-- (hostname, captured_at), and is matched to the person's interval — and turned
-- into a real screenshots row — during their next /api/ingest cycle (once the
-- interval covering that instant exists). The image never leaves their machine.
create table if not exists time_tracker.pending_ocr (
  id           uuid primary key default gen_random_uuid(),
  hostname     text not null,
  app          text,
  window_title text,
  captured_at  timestamptz not null,
  ocr_text     text not null,
  created_at   timestamptz not null default now()
);
create index if not exists idx_pending_ocr_host on time_tracker.pending_ocr (hostname, captured_at);

-- Match the RLS posture of every other time_tracker table (owner bypasses; the
-- anon/authenticated API roles are denied). See 0006_enable_rls_time_tracker.sql.
alter table time_tracker.pending_ocr enable row level security;
