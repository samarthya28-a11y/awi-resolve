-- AWI Resolve — database blueprint (spec §5.3)
-- Target: Supabase (PostgreSQL). Loaded when we move off local development.

create table customers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  contact_email text,
  gespage_site  text,                -- which Gespage installation they belong to
  plan        text default 'pilot',  -- pilot | per_device | per_incident
  created_at  timestamptz default now()
);

create table devices (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid references customers(id),
  device_key_hash text not null,     -- sha256 of the agent's secret; raw secret never stored
  hostname      text,
  os_build      text,
  agent_version text,
  enrolled_at   timestamptz default now(),
  last_seen_at  timestamptz,
  status        text default 'active'  -- active | paused | retired
);

create table tickets (
  id           uuid primary key default gen_random_uuid(),
  device_id    uuid references devices(id),
  customer_id  uuid references customers(id),
  problem_text text not null,          -- what the customer typed
  category     text,                   -- matched playbook, e.g. 'print-queue-stuck'
  state        text default 'open',    -- open | diagnosing | fixing | resolved | escalated | reopened
  opened_at    timestamptz default now(),
  closed_at    timestamptz,
  resolution_summary text,             -- plain-language wrap-up shown to customer
  autonomous   boolean                 -- true = closed with zero human touch (north-star metric)
);

create table sessions (
  id          uuid primary key default gen_random_uuid(),
  ticket_id   uuid references tickets(id),
  device_id   uuid references devices(id),
  started_at  timestamptz default now(),
  ended_at    timestamptz,
  model_used  text,
  ai_cost_inr numeric
);

-- Every single action the AI takes, replayable. The product's black box recorder.
create table actions (
  id          bigint generated always as identity primary key,
  session_id  uuid references sessions(id),
  ts          timestamptz default now(),
  tool_id     text not null,
  tier        int,                     -- 0, 1, 2
  params      jsonb,
  status      text not null,           -- ok | error | refused | declined_by_customer
  result_digest text                   -- truncated/PII-scrubbed result summary
);

create table consents (
  id          bigint generated always as identity primary key,
  session_id  uuid references sessions(id),
  action_id   bigint references actions(id),
  prompt_text text not null,           -- exactly what the customer saw
  decision    text not null,           -- accepted | declined | timeout
  decided_at  timestamptz default now()
);

create table playbooks (
  id          text primary key,        -- e.g. '01-print-queue-stuck'
  version     int not null default 1,
  title       text not null,
  body_md     text not null,
  updated_at  timestamptz default now()
);

create table escalations (
  id          uuid primary key default gen_random_uuid(),
  ticket_id   uuid references tickets(id),
  handoff_md  text not null,           -- structured handoff for the human tech
  reason      text,                    -- attempts_exhausted | low_confidence | customer_declined | out_of_scope
  created_at  timestamptz default now(),
  resolved_by text,
  resolution_notes text                -- feeds playbook improvements after human review
);
