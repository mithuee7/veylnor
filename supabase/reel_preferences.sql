-- Veylnor saved Reel Style Instructions.
-- This version is compatible with the UUID-based table created by earlier Veylnor builds.
create table if not exists public.reel_preferences (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'default',
  instructions text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.reel_preferences enable row level security;
-- Veylnor reads/writes this with the server-side service_role client.
-- No anon policies are required.

-- Compatibility for older Veylnor databases that already have a required name column.
alter table public.reel_preferences add column if not exists name text not null default 'default';
