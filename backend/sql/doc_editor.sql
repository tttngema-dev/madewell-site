-- Made Well – document preview / fill-in / email
-- Run this ONCE in the Supabase SQL editor (safe to re-run).

-- 1. Remember each saved tender's documents so the dashboard can open them
alter table public.saved_tenders add column if not exists documents jsonb default '[]'::jsonb;

-- 2. The user's filled-in copy of each document (text boxes, ticks, form-field values)
create table if not exists public.tender_doc_edits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ocid text not null,
  doc_url text not null,
  doc_title text,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now(),
  created_at timestamptz default now(),
  unique (user_id, ocid, doc_url)
);

create index if not exists tender_doc_edits_user_idx on public.tender_doc_edits(user_id, ocid);

alter table public.tender_doc_edits enable row level security;

drop policy if exists "own doc edits" on public.tender_doc_edits;
create policy "own doc edits" on public.tender_doc_edits
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
