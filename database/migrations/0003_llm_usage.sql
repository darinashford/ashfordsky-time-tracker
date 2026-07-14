-- Per-run token usage + estimated cost of the LLM classifier (the opt-in Haiku
-- pass). Drives the in-dashboard "AI classifier cost" meter so the cost is
-- visible per day. One row per pass/day; summed by getLlmCostForDay.
create table if not exists time_tracker.llm_usage (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  day               date not null,                 -- local day classified
  model             text not null,
  calls             int  not null default 0,
  input_tokens      bigint not null default 0,
  output_tokens     bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  cost_usd          numeric(12,6) not null default 0,
  blocks            int  not null default 0
);

create index if not exists llm_usage_day_idx on time_tracker.llm_usage (day);

comment on table time_tracker.llm_usage is
  'Per-run token usage + cost of the LLM classifier, for the in-dashboard cost meter.';
