-- Made Well: EVERYTHING in one file. Paste it all into the Supabase SQL editor and press Run. Safe to run more than once.
-- (It simply runs the other setup files in order, so you never have to wonder which one you missed.)

-- ===== subscriptions.sql =====
-- Made Well – Pro plan (R199 / month), free trial document, promo codes

-- 1. One row per user who has (or had) Pro
create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  source text not null default 'payfast',          -- payfast | promo
  status text not null default 'active',           -- active | cancelled
  plan text not null default 'pro',
  current_period_end timestamptz,                  -- null + source 'promo' = free with no end date
  payfast_token text,                              -- PayFast subscription token (needed to cancel)
  last_pf_payment_id text,                         -- last payment we processed (stops double-processing)
  last_paid_at timestamptz,
  promo_code text,
  email text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists subscriptions_token_idx on public.subscriptions(payfast_token);
alter table public.subscriptions enable row level security;
drop policy if exists "read own subscription" on public.subscriptions;
create policy "read own subscription" on public.subscriptions for select using (auth.uid() = user_id);
-- only the backend (service role) writes to this table

-- 2. Promo codes you hand out
create table if not exists public.promo_codes (
  code text primary key,                           -- stored UPPERCASE
  days integer,                                    -- how many free days; empty = free with no end date
  max_uses integer,                                -- empty = unlimited people
  uses integer not null default 0,
  expires_at timestamptz,                          -- the code stops working after this; empty = never
  active boolean not null default true,
  note text,                                       -- e.g. "for Thabo's company"
  created_at timestamptz default now()
);
alter table public.promo_codes enable row level security;   -- backend only, no policy on purpose

create table if not exists public.promo_redemptions (
  user_id uuid not null references auth.users(id) on delete cascade,
  code text not null references public.promo_codes(code) on delete cascade,
  redeemed_at timestamptz default now(),
  primary key (user_id, code)
);
alter table public.promo_redemptions enable row level security;

-- 3. Redeeming a code in one safe step (two people can never use the last spot at the same time)
create or replace function public.redeem_promo(p_user uuid, p_email text, p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.promo_codes%rowtype; cur public.subscriptions%rowtype; ends timestamptz;
begin
  select * into c from public.promo_codes where code = upper(trim(p_code)) for update;
  if not found or not c.active then return jsonb_build_object('ok', false, 'error', 'That code isn’t valid. Check it and try again.'); end if;
  if c.expires_at is not null and c.expires_at < now() then return jsonb_build_object('ok', false, 'error', 'That code has expired.'); end if;
  if c.max_uses is not null and c.uses >= c.max_uses then return jsonb_build_object('ok', false, 'error', 'That code has already been fully used.'); end if;
  if exists (select 1 from public.promo_redemptions where user_id = p_user and code = c.code) then
    return jsonb_build_object('ok', false, 'error', 'You have already used that code.');
  end if;

  select * into cur from public.subscriptions where user_id = p_user;
  if found and cur.source = 'payfast' and cur.status = 'active' then
    return jsonb_build_object('ok', false, 'error', 'You already have an active Pro subscription, so you do not need a code.');
  end if;
  if found and cur.source = 'promo' and cur.status = 'active' and cur.current_period_end is null then
    return jsonb_build_object('ok', false, 'error', 'You already have free Pro access with no end date.');
  end if;

  if c.days is null then ends := null; else ends := now() + make_interval(days => c.days); end if;
  -- free days stack on top of any time that is still left
  if ends is not null and found and cur.current_period_end is not null and cur.current_period_end > now() then
    ends := cur.current_period_end + make_interval(days => c.days);
  end if;

  insert into public.promo_redemptions(user_id, code) values (p_user, c.code);
  update public.promo_codes set uses = uses + 1 where code = c.code;
  insert into public.subscriptions(user_id, source, status, plan, current_period_end, promo_code, email, updated_at)
  values (p_user, 'promo', 'active', 'pro', ends, c.code, p_email, now())
  on conflict (user_id) do update
    set source = 'promo', status = 'active', current_period_end = excluded.current_period_end,
        promo_code = excluded.promo_code, email = excluded.email, updated_at = now();

  return jsonb_build_object('ok', true, 'ends', ends, 'lifetime', ends is null, 'days', c.days);
end $$;
revoke all on function public.redeem_promo(uuid, text, text) from public, anon, authenticated;

-- 4. EXAMPLE promo codes (delete or change these, or make your own on the admin page)
-- insert into public.promo_codes(code, days, max_uses, note) values ('MADEWELL-FRIENDS', null, 20, 'free with no end date, 20 people');
-- insert into public.promo_codes(code, days, max_uses, note) values ('TRY30', 30, 200, '30 free days');

-- ===== free_download.sql =====
-- Made Well – free plan: ONE tender document download per person.
create table if not exists public.free_downloads (
  user_id uuid primary key references auth.users(id) on delete cascade,
  ocid text not null,
  doc_url text not null,
  doc_title text,
  created_at timestamptz default now()
);
alter table public.free_downloads enable row level security;   -- backend only

-- ===== free_limits.sql =====
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

-- ===== profile_extras.sql =====
-- Made Well – company profile: CSD (MAAA) supplier number + your own quick-fill items. Safe to re-run.
alter table public.company_profiles add column if not exists csd_number text;
alter table public.company_profiles add column if not exists quick_fills jsonb default '[]'::jsonb;

