-- Made Well – free plan limits. Run ONCE in the Supabase SQL editor (safe to re-run).
-- (free_download.sql from v12 must already have been run: the "one free download" table.)
-- One FINISHED filled-in document (downloaded or emailed) per free person.
create table if not exists public.free_exports (
  user_id uuid primary key references auth.users(id) on delete cascade,
  ocid text not null,
  doc_url text not null,
  kind text,                              -- download | email
  created_at timestamptz default now()
);
alter table public.free_exports enable row level security;   -- backend only
