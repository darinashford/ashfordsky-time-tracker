-- The resolver re-resolves whole days every 10 minutes. Three write paths did
-- full rewrites even when nothing changed, generating constant WAL/dead tuples
-- — the steady IO drain behind the Disk-IO-budget outage of 2026-07-22:
--   1. resolutions: unconditional ON CONFLICT UPDATE (updated_at=now()) — fixed
--      in code with a WHERE ... IS DISTINCT FROM guard.
--   2. resolution_audit: delete-all + insert-all per interval — fixed in code
--      (only rewritten when the resolution actually changed).
--   3. current_client_state: blind INSERT re-appended the SAME anchors on every
--      cycle — the table grew to 45 MB, larger than the interval data itself.
--
-- This migration cleans up (3): collapse duplicates, add the unique index the
-- code's new ON CONFLICT DO NOTHING needs, and trim ancient anchors (the
-- context engine only ever looks minutes back; 30 days is generous for audit).
delete from time_tracker.current_client_state a
 using time_tracker.current_client_state b
 where a.source_interval_id is not null
   and a.source_interval_id = b.source_interval_id
   and a.ctid > b.ctid;

delete from time_tracker.current_client_state
 where as_of < now() - interval '30 days';

create unique index if not exists current_client_state_source_interval_uidx
  on time_tracker.current_client_state (source_interval_id)
  where source_interval_id is not null;
