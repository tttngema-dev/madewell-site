-- Made Well – Tender platform tables
-- Run this in the Supabase SQL editor once.

create table if not exists public.company_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  registered_name text,
  cipc_number text,
  trading_name text,
  address_line1 text,
  address_line2 text,
  city text,
  province text,
  postal_code text,
  contact_email text,
  contact_phone text,
  directors jsonb default '[]'::jsonb,
  tax_number text,
  vat_number text,
  banking jsonb default '{}'::jsonb,
  industries text[] default '{}',
  bbbee_level text,
  bbbee_certificate_url text,
  cidb_grade text,
  cidb_number text,
  stamp_url text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.saved_tenders (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  ocid text not null,
  title text,
  buyer text,
  closing_date timestamptz,
  status text default 'watching',
  notes text,
  created_at timestamptz default now(),
  unique (user_id, ocid)
);

create index if not exists saved_tenders_user_idx on public.saved_tenders(user_id);
create index if not exists saved_tenders_closing_idx on public.saved_tenders(closing_date);

create table if not exists public.user_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  category text,
  storage_path text not null,
  mime_type text,
  size_bytes int,
  created_at timestamptz default now()
);

create index if not exists user_documents_user_idx on public.user_documents(user_id);

create table if not exists public.tender_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ocid text not null,
  title text,
  status text default 'draft',
  filled_pdf_path text,
  notes text,
  updated_at timestamptz default now(),
  created_at timestamptz default now()
);

alter table public.company_profiles enable row level security;
alter table public.saved_tenders enable row level security;
alter table public.user_documents enable row level security;
alter table public.tender_applications enable row level security;

drop policy if exists "own profile" on public.company_profiles;
create policy "own profile" on public.company_profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "own saved" on public.saved_tenders;
create policy "own saved" on public.saved_tenders
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own docs" on public.user_documents;
create policy "own docs" on public.user_documents
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own apps" on public.tender_applications;
create policy "own apps" on public.tender_applications
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
