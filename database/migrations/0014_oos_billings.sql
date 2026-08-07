-- Out-of-scope billings: a shared firm checklist of "we did work outside the
-- engagement — bill it". Anyone on staff can log one (client + amount + what
-- for); the row records who logged it. When it's actually invoiced, anyone
-- checks it off and it moves to the completed list (who billed it, when).
-- amount_cents NULL = "we need to bill for this but don't know how much yet"
-- (the amount can be filled in at billing time).
create table if not exists time_tracker.oos_billings (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients(id),
  amount_cents bigint,                -- null = unknown / TBD
  note         text,
  created_by   text not null,
  created_at   timestamptz not null default now(),
  billed       boolean not null default false,
  billed_by    text,
  billed_at    timestamptz,
  updated_at   timestamptz not null default now()
);

create index if not exists oos_billings_billed_idx
  on time_tracker.oos_billings (billed, created_at desc);

alter table time_tracker.oos_billings enable row level security;
