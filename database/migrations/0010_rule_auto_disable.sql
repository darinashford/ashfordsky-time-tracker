-- Over-broad learned rules ("pdfgear" -> a client) mis-attribute hundreds of
-- blocks. The audit can now disable them on its own, so it needs somewhere to
-- record why, and a way to never fight a human decision.
--
--   auto_disabled_reason : set when the sweep disables a rule; shown in the UI.
--   human_reviewed       : set when a person enables a rule from Manual Rules.
--                          The sweep skips these forever after — if you say a
--                          rule is right, it stays on.
alter table time_tracker.attribution_rules
  add column if not exists auto_disabled_reason text,
  add column if not exists human_reviewed boolean not null default false;
