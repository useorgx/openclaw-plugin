-- Post-run introspection storage for structured retro artifacts (`retro.v1`).
create table if not exists public.agent_run_retros (
  id uuid primary key default gen_random_uuid(),
  initiative_id text not null,
  entity_type text null,
  entity_id text null,
  title text null,
  idempotency_key text null,
  run_id text null,
  correlation_id text null,
  source_client text null,
  retro jsonb not null,
  markdown text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_run_retros_entity_type_check
    check (entity_type is null or entity_type in ('initiative', 'workstream', 'milestone', 'task')),
  constraint agent_run_retros_retro_shape_check
    check (
      jsonb_typeof(retro) = 'object'
      and retro ? 'schema_version'
      and retro->>'schema_version' = 'retro.v1'
      and retro ? 'summary'
      and coalesce(length(trim(retro->>'summary')), 0) > 0
    )
);

create unique index if not exists agent_run_retros_initiative_idempotency_uidx
  on public.agent_run_retros (initiative_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists agent_run_retros_initiative_created_idx
  on public.agent_run_retros (initiative_id, created_at desc);

create index if not exists agent_run_retros_run_idx
  on public.agent_run_retros (run_id)
  where run_id is not null;

create index if not exists agent_run_retros_entity_idx
  on public.agent_run_retros (entity_type, entity_id, created_at desc)
  where entity_type is not null and entity_id is not null;

comment on table public.agent_run_retros is
  'Structured post-run retrospectives captured from OpenClaw execution paths.';
