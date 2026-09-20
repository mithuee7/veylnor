-- Run this once in the Supabase SQL editor for the live Veylnor project.

-- 1. Core media tables --------------------------------------------------
create table if not exists public.clips (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  category text not null,
  storage_path text not null,
  duration numeric,
  created_at timestamptz not null default now()
);

create table if not exists public.songs (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  storage_path text not null,
  duration numeric,
  created_at timestamptz not null default now()
);

-- 2. Clip folders are the AI semantic categories -----------------------
create table if not exists public.clip_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists clip_categories_name_lower_idx
  on public.clip_categories (lower(name));

-- Remove the old fixed enum/check so categories can be renamed/created.
alter table public.clips drop constraint if exists clips_category_check;

-- Seed the original Veylnor folders once. Existing clips already using these
-- names are immediately represented by the same semantic labels the AI sees.
insert into public.clip_categories (name)
values ('women'),('cars'),('yachts'),('jets'),('jetski'),('money'),('mansions'),('lifestyle'),('travel'),('other')
on conflict do nothing;

-- Also preserve any custom categories that already exist on clips.
insert into public.clip_categories (name)
select distinct category from public.clips
where category is not null and trim(category) <> ''
on conflict do nothing;

-- Migrate away from the previous separate-folder experiment. Existing media
-- stays untouched; the old folder metadata is no longer used by the app.
alter table public.clips drop column if exists folder_id;
alter table public.songs drop column if exists folder_id;
drop table if exists public.media_folders;

create index if not exists clips_category_idx on public.clips(category);

-- 3. Storage buckets ----------------------------------------------------
insert into storage.buckets (id, name, public) values ('clips','clips',false) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('songs','songs',false) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('references','references',false) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('renders','renders',false) on conflict (id) do nothing;

-- 4. RLS ---------------------------------------------------------------
alter table public.clips enable row level security;
alter table public.songs enable row level security;
alter table public.clip_categories enable row level security;

-- Server-side service_role access is used. No anon policies are required.

-- 5. Persistent reel personalization -----------------------------------
-- Singleton preference used by the Generate page. The app is currently
-- single-workspace/server-role based, so one saved profile is intentional.
create table if not exists public.reel_preferences (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'default',
  instructions text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.reel_preferences enable row level security;
-- Server-side service_role access is used. No anon policies are required.
