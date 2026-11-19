-- Made Well – tender alert emails (daily digest, max 10 tenders per user per day)
-- Run ONCE in the Supabase SQL editor (safe to re-run).

create table if not exists public.tender_alert_prefs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  email text,                                   -- where the digest goes (kept in sync when the user saves)
  categories text[] not null default '{}',      -- goods | services | works
  provinces text[] not null default '{}',       -- empty = all provinces
  keywords text[] not null default '{}',        -- e.g. cleaning, security, construction
  unsub_token uuid not null default gen_random_uuid(),
  last_sent_on date,                            -- South African date of the last digest
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create unique index if not exists tender_alert_prefs_token_idx on public.tender_alert_prefs(unsub_token);

-- every tender we have emailed to someone, so the same tender is never sent twice and the daily cap can be enforced
create table if not exists public.tender_alert_sent (
  user_id uuid not null references auth.users(id) on delete cascade,
  ocid text not null,
  sent_on date not null,
  primary key (user_id, ocid)
);
create index if not exists tender_alert_sent_day_idx on public.tender_alert_sent(user_id, sent_on);

alter table public.tender_alert_prefs enable row level security;
alter table public.tender_alert_sent enable row level security;
drop policy if exists "own alert prefs" on public.tender_alert_prefs;
create policy "own alert prefs" on public.tender_alert_prefs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- tender_alert_sent is only touched by the backend (service role); no policy on purpose.
