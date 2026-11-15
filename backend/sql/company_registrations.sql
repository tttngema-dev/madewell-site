-- Run once in the Supabase SQL editor.
create table if not exists company_registrations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  reference text unique not null,
  status text not null default 'received', -- received, awaiting_documents, submitted, registered
  contact_email text not null,
  data jsonb not null
);
-- Holds ID numbers and home addresses: keep RLS on, with no public policies.
-- Only the backend (service key) can read or write.
alter table company_registrations enable row level security;

-- Payment tracking (run this too)
alter table company_registrations add column if not exists paid_at timestamptz;
alter table company_registrations add column if not exists pf_payment_id text;

-- Reminder emails for unfinished payments
alter table company_registrations add column if not exists reminded_at timestamptz;

-- Visit tracking + admin work status
create table if not exists site_events (
  id bigint generated always as identity primary key,
  created_at timestamptz default now(),
  visitor text not null, event text not null, step int,
  path text, source text, device text
);
create index if not exists site_events_created on site_events (created_at desc);
create index if not exists site_events_visitor on site_events (visitor, created_at desc);
alter table site_events enable row level security;
alter table company_registrations add column if not exists work_status text default 'new';

-- Beneficial ownership filings (R500). Files are deleted after they are emailed, or after 14 days.
create table if not exists bo_filings (
  id bigint generated always as identity primary key,
  created_at timestamptz default now(),
  reference text unique not null, status text default 'awaiting_payment',
  contact_email text, data jsonb, paid_at timestamptz, pf_payment_id text
);
create table if not exists bo_files (
  id bigint generated always as identity primary key,
  created_at timestamptz default now(),
  reference text not null, kind text, owner int, name text, mime text, data text
);
create index if not exists bo_files_ref on bo_files (reference);
alter table bo_filings enable row level security;
alter table bo_files enable row level security;
