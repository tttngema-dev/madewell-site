-- Made Well – company profile: CSD (MAAA) supplier number + your own quick-fill items. Safe to re-run.
alter table public.company_profiles add column if not exists csd_number text;
alter table public.company_profiles add column if not exists quick_fills jsonb default '[]'::jsonb;
