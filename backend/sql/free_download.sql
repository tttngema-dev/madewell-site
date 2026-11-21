-- Made Well – free plan: ONE tender document download per person.
-- Run ONCE in the Supabase SQL editor (safe to re-run).
create table if not exists public.free_downloads (
  user_id uuid primary key references auth.users(id) on delete cascade,
  ocid text not null,
  doc_url text not null,
  doc_title text,
  created_at timestamptz default now()
);
alter table public.free_downloads enable row level security;   -- backend only
