-- Made Well – company documents (CIPC, CSD, B-BBEE, CIDB, tax clearance …) + saved signature
-- Run this ONCE in the Supabase SQL editor (safe to re-run).

-- 1. Private storage bucket for the uploaded files (only the backend can read/write it)
insert into storage.buckets (id, name, public)
values ('company-docs', 'company-docs', false)
on conflict (id) do nothing;

-- 2. One row per uploaded document
create table if not exists public.company_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  doc_type text not null,            -- cipc | csd | bbbee | cidb | tax | vat | coida | bank | directors_id | other
  label text,                        -- shown name (custom for "other")
  file_name text,
  mime_type text,
  size_bytes integer,
  storage_path text not null,
  expires_on date,                   -- optional: certificates that lapse
  uploaded_at timestamptz default now()
);
create index if not exists company_documents_user_idx on public.company_documents(user_id, doc_type);

alter table public.company_documents enable row level security;
drop policy if exists "own company docs" on public.company_documents;
create policy "own company docs" on public.company_documents
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 3. The user's saved signature (small transparent PNG)
create table if not exists public.user_signatures (
  user_id uuid primary key references auth.users(id) on delete cascade,
  png text not null,                 -- data:image/png;base64,...
  width integer,
  height integer,
  updated_at timestamptz default now()
);
alter table public.user_signatures enable row level security;
drop policy if exists "own signature" on public.user_signatures;
create policy "own signature" on public.user_signatures
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
