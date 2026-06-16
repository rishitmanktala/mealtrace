create extension if not exists pgcrypto;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  goals jsonb not null default '{"calories":2000,"protein":150,"carbs":250,"fat":65,"fiber":30}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.meal_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  logged_on date not null default current_date,
  logged_at timestamptz not null default now(),
  data jsonb not null
);

create index if not exists meal_logs_user_logged_at_idx
  on public.meal_logs (user_id, logged_at desc);

create index if not exists meal_logs_user_logged_on_idx
  on public.meal_logs (user_id, logged_on);

alter table public.profiles enable row level security;
alter table public.meal_logs enable row level security;

drop policy if exists "Users can read their own profile" on public.profiles;
create policy "Users can read their own profile"
  on public.profiles for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "Users can insert their own profile" on public.profiles;
create policy "Users can insert their own profile"
  on public.profiles for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "Users can read their own meals" on public.meal_logs;
create policy "Users can read their own meals"
  on public.meal_logs for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "Users can insert their own meals" on public.meal_logs;
create policy "Users can insert their own meals"
  on public.meal_logs for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "Users can update their own meals" on public.meal_logs;
create policy "Users can update their own meals"
  on public.meal_logs for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "Users can delete their own meals" on public.meal_logs;
create policy "Users can delete their own meals"
  on public.meal_logs for delete
  to authenticated
  using (user_id = auth.uid());

revoke all on table public.profiles from anon;
revoke all on table public.meal_logs from anon;
grant select, insert, update, delete on table public.profiles to authenticated;
grant select, insert, update, delete on table public.meal_logs to authenticated;
grant select, insert, update, delete on table public.profiles to service_role;
grant select, insert, update, delete on table public.meal_logs to service_role;
