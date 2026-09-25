-- ACO! access foundation. No existing demo data or credentials are imported.
-- All mutations are denied to browser roles until dedicated transactional APIs exist.
begin;
create schema if not exists aco_private;
revoke all on schema aco_private from public, anon, authenticated;
grant usage on schema aco_private to authenticated, service_role;
revoke create on schema public from public, anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema aco_private revoke execute on functions from public;

create table aco_private.identities (
  user_id uuid primary key references auth.users(id) on delete restrict,
  role text not null check (role in ('admin','trainer','client')),
  enabled boolean not null default false,
  created_at timestamptz not null default now()
);
alter table aco_private.identities enable row level security;

create table public.aco_profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  name text not null check (length(name) between 1 and 160),
  email text not null check (length(email) between 3 and 254),
  phone text not null default '' check (length(phone)<=40),
  avatar_path text,
  created_at timestamptz not null default now()
);
create unique index aco_profiles_email on public.aco_profiles(lower(email));
create table public.aco_trainers (
  id uuid primary key references public.aco_profiles(id) on delete restrict,
  products text[] not null check (products <@ array['personal','physio']::text[] and cardinality(products) between 1 and 2),
  deleted_at timestamptz
);
create table public.aco_clients (
  id uuid primary key references public.aco_profiles(id) on delete restrict,
  lead_trainer_id uuid not null references public.aco_trainers(id) on delete restrict,
  birth_date date not null,
  status text not null default 'pending' check (status in ('pending','approved','active','disabled')),
  product text check (product in ('personal','physio')),
  intensity smallint check (intensity between 1 and 3),
  approved_at timestamptz,
  approved_by uuid references public.aco_profiles(id),
  check (status not in ('approved','active') or (product is not null and intensity is not null and approved_at is not null))
);
create index aco_clients_lead_trainer on public.aco_clients(lead_trainer_id);
create table public.aco_substitutions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.aco_clients(id),
  trainer_id uuid not null references public.aco_trainers(id),
  starts_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check(expires_at>starts_at)
);
create index aco_substitutions_access on public.aco_substitutions(trainer_id,client_id,expires_at) where revoked_at is null;
create table public.aco_packages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.aco_clients(id),
  product text not null check(product in ('personal','physio')),
  intensity smallint not null check(intensity between 1 and 3),
  count integer not null check(count>0),
  starts_on date not null,
  cycle_end date not null,
  valid_until date not null,
  price_grosz integer not null check(price_grosz>=0),
  base_price_grosz integer not null check(base_price_grosz>=price_grosz),
  frozen boolean not null default false,
  created_at timestamptz not null default now(),
  check(cycle_end>starts_on and valid_until>starts_on)
);
create index aco_packages_client on public.aco_packages(client_id,valid_until);
create table public.aco_sessions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.aco_clients(id),
  trainer_id uuid not null references public.aco_trainers(id),
  substitution_id uuid references public.aco_substitutions(id),
  package_id uuid references public.aco_packages(id),
  kind text not null check(kind in ('training','consultation')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'scheduled' check(status in ('scheduled','completed','no_show','cancelled_early','cancelled_late','cancelled_trainer')),
  created_at timestamptz not null default now(),
  check(ends_at>starts_at),
  check(kind<>'training' or package_id is not null)
);
create index aco_sessions_client on public.aco_sessions(client_id,starts_at);
create index aco_sessions_trainer on public.aco_sessions(trainer_id,starts_at);
create index aco_sessions_package on public.aco_sessions(package_id);
create unique index aco_training_one_per_day on public.aco_sessions(client_id,((starts_at at time zone 'Europe/Warsaw')::date)) where kind='training' and status in ('scheduled','completed','no_show','cancelled_late');
create table public.aco_public_notes (
  session_id uuid primary key references public.aco_sessions(id),
  body text not null default '' check(length(body)<=20000),
  updated_at timestamptz not null default now(),
  updated_by uuid not null references public.aco_profiles(id)
);
create table public.aco_trainer_notes (
  session_id uuid primary key references public.aco_sessions(id),
  body text not null default '' check(length(body)<=20000),
  updated_at timestamptz not null default now(),
  updated_by uuid not null references public.aco_profiles(id)
);
create table public.aco_comments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.aco_sessions(id),
  author_id uuid not null references public.aco_profiles(id),
  body text not null check(length(body) between 1 and 10000),
  created_at timestamptz not null default now()
);
create index aco_comments_session on public.aco_comments(session_id,created_at);
create table public.aco_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.aco_profiles(id),
  recipient_id uuid not null references public.aco_profiles(id),
  subject text not null check(length(subject) between 1 and 200),
  body text not null check(length(body) between 1 and 20000),
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index aco_messages_sender on public.aco_messages(sender_id,created_at);
create index aco_messages_recipient on public.aco_messages(recipient_id,created_at);
create table public.aco_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.aco_profiles(id),
  title text not null,
  body text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index aco_notifications_recipient on public.aco_notifications(recipient_id,created_at);
create table public.aco_trainer_payroll (
  trainer_id uuid primary key references public.aco_trainers(id),
  pesel text check(pesel is null or pesel ~ '^[0-9]{11}$'),
  student boolean not null default false,
  address text,
  tax_office text
);
create table public.aco_earnings (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.aco_trainers(id),
  session_id uuid unique references public.aco_sessions(id),
  kind text not null check(kind in ('training','consultation','company')),
  hours numeric(8,2) not null check(hours>0),
  rate_grosz integer not null check(rate_grosz>0),
  amount_grosz integer not null check(amount_grosz>=0),
  month date not null check(extract(day from month)=1),
  description text not null default '',
  check((kind='company' and session_id is null) or (kind<>'company' and session_id is not null))
);
create index aco_earnings_trainer on public.aco_earnings(trainer_id,month);
create table public.aco_products (
  id text primary key check(id in ('personal','physio')),
  name text not null,
  subtitle text not null,
  bullets text[] not null default '{}',
  prices_grosz integer[] not null check(cardinality(prices_grosz)=3 and 0<all(prices_grosz))
);
create table public.aco_promotions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check(kind in ('email','code')),
  value text not null,
  percent numeric(5,2) not null check(percent>0 and percent<=100),
  max_uses integer,
  used integer not null default 0 check(used>=0),
  expires_on date,
  active boolean not null default true,
  check(kind='email' or (max_uses>0 and used<=max_uses and expires_on is not null))
);
create unique index aco_promotions_unique on public.aco_promotions(kind,lower(value)) where active;
create table aco_private.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id),
  action text not null,
  target_id uuid,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
alter table aco_private.audit_log enable row level security;

-- Privileged lookups stay outside the exposed schema, use a fixed search_path,
-- derive identity solely from auth.uid(), and never trust editable JWT metadata.
create function aco_private.current_role() returns text
language sql stable security definer set search_path=''
as $$ select role from aco_private.identities where user_id=(select auth.uid()) and enabled $$;
create function aco_private.can_manage_client(target uuid) returns boolean
language sql stable security definer set search_path=''
as $$ select (select auth.uid()) is not null and (
  aco_private.current_role()='admin' or (
    aco_private.current_role()='trainer' and (
      exists(select 1 from public.aco_clients where id=target and lead_trainer_id=(select auth.uid())) or
      exists(select 1 from public.aco_substitutions where client_id=target and trainer_id=(select auth.uid()) and revoked_at is null and starts_at<=now() and expires_at>now())
    )
  )
) $$;
create function aco_private.can_read_client(target uuid) returns boolean
language sql stable security definer set search_path=''
as $$ select aco_private.can_manage_client(target) or ((select auth.uid())=target and aco_private.current_role()='client' and exists(select 1 from public.aco_clients where id=target and status='active')) $$;
create function aco_private.can_read_session(target uuid) returns boolean
language sql stable security definer set search_path=''
as $$ select (select auth.uid()) is not null and exists(
  select 1 from public.aco_sessions s where s.id=target and (
    aco_private.can_read_client(s.client_id) or (
      aco_private.current_role()='trainer' and s.trainer_id=(select auth.uid()) and s.ends_at<=now() and s.substitution_id is null
    )
  )
) $$;
create function aco_private.can_read_profile(target uuid) returns boolean
language sql stable security definer set search_path=''
as $$ select (select auth.uid()) is not null and aco_private.current_role() is not null and (
  target=(select auth.uid()) or aco_private.current_role()='admin' or
  aco_private.can_manage_client(target) or
  exists(select 1 from public.aco_clients where id=(select auth.uid()) and status='active' and lead_trainer_id=target) or
  exists(select 1 from public.aco_substitutions where client_id=(select auth.uid()) and trainer_id=target and revoked_at is null and starts_at<=now() and expires_at>now()) or
  exists(select 1 from public.aco_messages where (sender_id=(select auth.uid()) and recipient_id=target) or (recipient_id=(select auth.uid()) and sender_id=target))
) $$;
revoke all on all functions in schema aco_private from public,anon,authenticated;
grant execute on all functions in schema aco_private to authenticated,service_role;

-- Explicit per-table grants and deny-by-default RLS. No direct mutation grants.
alter table public.aco_profiles enable row level security;
alter table public.aco_trainers enable row level security;
alter table public.aco_clients enable row level security;
alter table public.aco_substitutions enable row level security;
alter table public.aco_packages enable row level security;
alter table public.aco_sessions enable row level security;
alter table public.aco_public_notes enable row level security;
alter table public.aco_trainer_notes enable row level security;
alter table public.aco_comments enable row level security;
alter table public.aco_messages enable row level security;
alter table public.aco_notifications enable row level security;
alter table public.aco_trainer_payroll enable row level security;
alter table public.aco_earnings enable row level security;
alter table public.aco_products enable row level security;
alter table public.aco_promotions enable row level security;
create policy profiles_read on public.aco_profiles for select to authenticated using(aco_private.can_read_profile(id));
create policy trainers_read on public.aco_trainers for select to authenticated using(aco_private.can_read_profile(id));
create policy clients_read on public.aco_clients for select to authenticated using(aco_private.can_read_client(id));
create policy substitutions_read on public.aco_substitutions for select to authenticated using(aco_private.can_read_client(client_id));
create policy packages_read on public.aco_packages for select to authenticated using(aco_private.can_read_client(client_id));
create policy sessions_read on public.aco_sessions for select to authenticated using(aco_private.can_read_session(id));
create policy public_notes_read on public.aco_public_notes for select to authenticated using(aco_private.can_read_session(session_id));
create policy trainer_notes_read on public.aco_trainer_notes for select to authenticated using(aco_private.current_role() in ('admin','trainer') and aco_private.can_read_session(session_id));
create policy comments_read on public.aco_comments for select to authenticated using(aco_private.can_read_session(session_id));
create policy messages_read on public.aco_messages for select to authenticated using(aco_private.current_role() is not null and (sender_id=(select auth.uid()) or recipient_id=(select auth.uid())));
create policy notifications_read on public.aco_notifications for select to authenticated using(aco_private.current_role() is not null and recipient_id=(select auth.uid()));
create policy payroll_read on public.aco_trainer_payroll for select to authenticated using(aco_private.current_role()='admin' or (aco_private.current_role()='trainer' and trainer_id=(select auth.uid())));
create policy earnings_read on public.aco_earnings for select to authenticated using(aco_private.current_role()='admin' or (aco_private.current_role()='trainer' and trainer_id=(select auth.uid())));
create policy products_read on public.aco_products for select to authenticated using(aco_private.current_role() is not null);
create policy promotions_read on public.aco_promotions for select to authenticated using(aco_private.current_role()='admin');
revoke all on public.aco_profiles,public.aco_trainers,public.aco_clients,public.aco_substitutions,public.aco_packages,public.aco_sessions,public.aco_public_notes,public.aco_trainer_notes,public.aco_comments,public.aco_messages,public.aco_notifications,public.aco_trainer_payroll,public.aco_earnings,public.aco_products,public.aco_promotions from anon,authenticated;
grant select on public.aco_profiles,public.aco_trainers,public.aco_clients,public.aco_substitutions,public.aco_packages,public.aco_sessions,public.aco_public_notes,public.aco_trainer_notes,public.aco_comments,public.aco_messages,public.aco_notifications,public.aco_trainer_payroll,public.aco_earnings,public.aco_products,public.aco_promotions to authenticated;
grant all on all tables in schema aco_private to service_role;
grant all on public.aco_profiles,public.aco_trainers,public.aco_clients,public.aco_substitutions,public.aco_packages,public.aco_sessions,public.aco_public_notes,public.aco_trainer_notes,public.aco_comments,public.aco_messages,public.aco_messages,public.aco_notifications,public.aco_trainer_payroll,public.aco_earnings,public.aco_products,public.aco_promotions to service_role;
grant usage, select on all sequences in schema aco_private to service_role;
commit;
