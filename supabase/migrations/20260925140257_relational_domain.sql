-- Relational source of truth. Additive: the previous store stays intact until cutover.
begin;
-- A domain profile and an Auth identity are separate identifiers.
alter table public.aco_profiles drop constraint aco_profiles_id_fkey;
alter table public.aco_profiles add column auth_user_id uuid unique references auth.users(id);
update public.aco_profiles set auth_user_id=id;
alter table public.aco_profiles alter column auth_user_id set not null;
alter table public.aco_profiles add column must_change_password boolean not null default false;
alter table public.aco_profiles drop constraint aco_profiles_name_check;
alter table public.aco_profiles add check(length(name) between 1 and 200);

create table public.aco_accounts (
 id uuid primary key references auth.users(id),
 profile_id uuid not null unique references public.aco_profiles(id),
 role text not null check(role in ('admin','trainer','client')),
 enabled boolean not null default true
);
create table public.aco_trainer_products (
 id text primary key,
 trainer_id uuid not null references public.aco_trainers(id),
 product_id text not null references public.aco_products(id),
 unique(trainer_id,product_id)
);
create table public.aco_trainer_rates (
 id text primary key,
 trainer_id uuid not null references public.aco_trainers(id),
 product_id text not null references public.aco_products(id),
 effective_from date not null,
 rate_grosz integer not null check(rate_grosz>=0),
 unique(trainer_id,product_id,effective_from)
);
create index aco_rates_effective on public.aco_trainer_rates(trainer_id,product_id,effective_from desc);
create table public.aco_availability (
 id text primary key,
 trainer_id uuid not null references public.aco_trainers(id),
 weekday smallint not null check(weekday between 0 and 6),
 hour smallint not null check(hour between 0 and 23),
 unique(trainer_id,weekday,hour)
);
create table public.aco_client_answers (
 id text primary key,
 client_id uuid not null references public.aco_clients(id),
 position smallint not null check(position between 0 and 19),
 answer text not null check(length(answer)<=2000),
 unique(client_id,position)
);
create table public.aco_product_prices (
 id text primary key,
 product_id text not null references public.aco_products(id),
 intensity smallint not null check(intensity between 1 and 3),
 amount_grosz integer not null check(amount_grosz>0),
 unique(product_id,intensity)
);
create table public.aco_settings (
 id text primary key check(id='company'),
 consultation_grosz integer not null check(consultation_grosz>0),
 personal_grosz integer not null check(personal_grosz>0),
 physio_grosz integer not null check(physio_grosz>0),
 cancellation_hours integer not null check(cancellation_hours between 1 and 8760),
 cycle_weeks integer not null check(cycle_weeks between 1 and 52),
 validity_weeks integer not null check(validity_weeks between cycle_weeks and 52),
 renewal_days integer not null check(renewal_days between 1 and 366),
 coach_hold_hours integer not null check(coach_hold_hours between 1 and 366),
 checkout_minutes integer not null check(checkout_minutes between 1 and 366),
 protection_days integer not null check(protection_days between 1 and 366),
 consultation_days integer not null check(consultation_days between 1 and 366),
 start_days integer not null check(start_days between 1 and 366),
 substitute_hours integer not null check(substitute_hours between 1 and 366),
 freeze_days integer not null check(freeze_days between 1 and 366)
);
alter table public.aco_packages add column protection_until date;
alter table public.aco_packages add column discount_percent numeric(5,2) not null default 0 check(discount_percent between 0 and 100);
alter table public.aco_packages add column promotion_id uuid references public.aco_promotions(id);
create table public.aco_package_slots (
 id text primary key,
 package_id uuid not null references public.aco_packages(id),
 weekday smallint not null check(weekday between 0 and 6),
 hour smallint not null check(hour between 0 and 23),
 unique(package_id,weekday)
);
create table public.aco_credits (
 id text primary key,
 package_id uuid not null references public.aco_packages(id),
 ordinal integer not null check(ordinal>0),
 unique(package_id,ordinal)
);
alter table public.aco_sessions add column credit_id text references public.aco_credits(id);
alter table public.aco_sessions add column original_starts_at timestamptz;
alter table public.aco_sessions add column consultation_grosz integer check(consultation_grosz>=0);
create unique index aco_credit_single_use on public.aco_sessions(credit_id)
 where credit_id is not null and status in ('scheduled','completed','no_show','cancelled_late');
-- Existing note authors may be unknown in imported data; never invent an author.
alter table public.aco_public_notes alter column updated_by drop not null;
alter table public.aco_trainer_notes alter column updated_by drop not null;
alter table public.aco_comments alter column author_id drop not null;
alter table public.aco_comments add column author_label text not null default '';

create table public.aco_holds (
 id uuid primary key,
 client_id uuid not null references public.aco_clients(id),
 trainer_id uuid not null references public.aco_trainers(id),
 product_id text not null references public.aco_products(id),
 intensity smallint not null check(intensity between 1 and 3),
 starts_on date not null,
 expires_at timestamptz not null,
 price_grosz integer not null check(price_grosz>=0),
 status text not null check(status in ('active','paid','expired')),
 kind text not null check(kind in ('coach','checkout')),
 payment_requested_at timestamptz,
 promotion_code text check(length(promotion_code)<=100),
 created_at timestamptz not null default now()
);
create index aco_holds_client_active on public.aco_holds(client_id,expires_at) where status='active';
create index aco_holds_expiry on public.aco_holds(expires_at) where status='active';
create table public.aco_hold_dates (
 id text primary key,
 hold_id uuid not null references public.aco_holds(id),
 starts_at timestamptz not null,
 original_starts_at timestamptz,
 unique(hold_id,starts_at)
);
create table public.aco_hold_slots (
 id text primary key,
 hold_id uuid not null references public.aco_holds(id),
 weekday smallint not null check(weekday between 0 and 6),
 hour smallint not null check(hour between 0 and 23),
 unique(hold_id,weekday)
);
-- Immutable policy snapshot for a reservation, with typed columns.
create table public.aco_hold_terms (like public.aco_settings including defaults including constraints);
alter table public.aco_hold_terms drop constraint aco_settings_id_check;
alter table public.aco_hold_terms add primary key(id);
alter table public.aco_hold_terms drop column consultation_grosz,drop column personal_grosz,drop column physio_grosz,drop column cancellation_hours;
alter table public.aco_hold_terms add column hold_id uuid not null unique references public.aco_holds(id);

create table public.aco_blackouts (
 id uuid primary key,
 trainer_id uuid not null references public.aco_trainers(id),
 starts_at timestamptz not null,
 visibility text not null check(visibility in ('busy','hidden')),
 unique(trainer_id,starts_at)
);
create table public.aco_sales (
 id text primary key,
 client_id uuid not null references public.aco_clients(id),
 package_id uuid references public.aco_packages(id),
 session_id uuid references public.aco_sessions(id),
 label text not null check(length(label)<=300),
 amount_grosz integer not null check(amount_grosz>=0),
 status text not null check(status in ('paid','refunded')),
 settled_at timestamptz not null,
 settled_by uuid references public.aco_profiles(id)
);
create index aco_sales_client on public.aco_sales(client_id,settled_at desc);
create unique index aco_sale_package_once on public.aco_sales(package_id) where package_id is not null and status='paid';
create unique index aco_sale_consultation_once on public.aco_sales(session_id) where session_id is not null and status='paid';
create table public.aco_activity (
 id uuid primary key,
 actor_id uuid references public.aco_profiles(id),
 description text not null check(length(description)<=5000),
 created_at timestamptz not null
);
create index aco_activity_created on public.aco_activity(created_at desc,id);
-- System event and recipient/read records are separate from private correspondence.
create table public.aco_events (
 id uuid primary key,
 client_id uuid references public.aco_clients(id),
 title text not null check(length(title)<=300),
 body text not null check(length(body)<=20000),
 audience text not null check(audience in ('all','client','staff','admin')),
 created_at timestamptz not null
);
create index aco_events_client on public.aco_events(client_id,created_at desc);
create table public.aco_notice_reads (
 id text primary key,
 profile_id uuid not null references public.aco_profiles(id),
 notice_id text not null check(length(notice_id)<=200),
 read_at timestamptz not null default now(),
 unique(profile_id,notice_id)
);
-- Composite uniqueness is the final authority for overlapping reservations.
create table public.aco_calendar_claims (
 trainer_id uuid not null references public.aco_trainers(id),
 starts_at timestamptz not null,
 client_id uuid references public.aco_clients(id),
 session_id uuid references public.aco_sessions(id),
 hold_id uuid references public.aco_holds(id),
 blackout_id uuid references public.aco_blackouts(id),
 primary key(trainer_id,starts_at),
 check(num_nonnulls(session_id,hold_id,blackout_id)=1)
);
create index aco_claims_session on public.aco_calendar_claims(session_id) where session_id is not null;
create index aco_claims_hold on public.aco_calendar_claims(hold_id) where hold_id is not null;
create index aco_claims_blackout on public.aco_calendar_claims(blackout_id) where blackout_id is not null;
create unique index aco_claims_client_slot on public.aco_calendar_claims(client_id,starts_at) where client_id is not null;
-- Exact once credit allocation is attached to the session, not a mutable client balance.
create function aco_private.create_package_credits() returns trigger
 language plpgsql security invoker set search_path='' as $$
begin
 insert into public.aco_credits(id,package_id,ordinal)
 select new.id::text||':'||n,new.id,n from generate_series(1,new.count) n;
 return new;
end $$;
create trigger create_package_credits after insert on public.aco_packages for each row execute function aco_private.create_package_credits();
create function aco_private.check_session_credit() returns trigger
 language plpgsql security invoker set search_path='' as $$
declare p public.aco_packages; chosen text;
begin
 if new.kind='training' and new.status in ('scheduled','completed','no_show','cancelled_late') then
  select * into strict p from public.aco_packages where id=new.package_id for update;
  if p.client_id<>new.client_id then raise exception 'Package belongs to another client' using errcode='23514'; end if;
  if new.status='scheduled' and (p.frozen or (new.starts_at at time zone 'Europe/Warsaw')::date<p.starts_on or (new.starts_at at time zone 'Europe/Warsaw')::date>=p.valid_until) then raise exception 'Package not valid for session' using errcode='23514'; end if;
  if new.credit_id is null then
   select c.id into chosen from public.aco_credits c where c.package_id=p.id and not exists(
    select 1 from public.aco_sessions s where s.credit_id=c.id and s.id<>new.id and s.status in ('scheduled','completed','no_show','cancelled_late'))
   order by c.ordinal limit 1 for update of c skip locked;
   if chosen is null then raise exception 'No unused credit' using errcode='23514'; end if;
   new.credit_id:=chosen;
  elsif not exists(select 1 from public.aco_credits where id=new.credit_id and package_id=p.id) then raise exception 'Invalid credit' using errcode='23514'; end if;
 end if;
 return new;
end $$;
create trigger check_session_credit before insert or update on public.aco_sessions for each row execute function aco_private.check_session_credit();

-- Replace duplicated list/price columns with referenced relational rows.
insert into public.aco_product_prices(id,product_id,intensity,amount_grosz)
 select p.id||':'||n,p.id,n,p.prices_grosz[n] from public.aco_products p cross join generate_series(1,3) n;
insert into public.aco_trainer_products(id,trainer_id,product_id)
 select t.id::text||':'||p,t.id,p from public.aco_trainers t cross join unnest(t.products) p;
alter table public.aco_products drop column prices_grosz;
alter table public.aco_trainers drop column products;
alter table public.aco_packages add check(count<=156);
-- Versions are per row. No singleton is locked for a business operation.
create function aco_private.bump_row_version() returns trigger language plpgsql security invoker set search_path='' as $$
begin new.row_version:=old.row_version+1;new.updated_at:=clock_timestamp();return new;end $$;
do $$declare t text;begin
 foreach t in array array['aco_accounts','aco_profiles','aco_trainers','aco_clients','aco_substitutions','aco_packages','aco_sessions','aco_public_notes','aco_trainer_notes','aco_comments','aco_messages','aco_notifications','aco_trainer_payroll','aco_earnings','aco_products','aco_promotions','aco_trainer_products','aco_trainer_rates','aco_availability','aco_client_answers','aco_product_prices','aco_settings','aco_package_slots','aco_holds','aco_hold_dates','aco_hold_slots','aco_hold_terms','aco_blackouts','aco_sales','aco_activity','aco_events','aco_notice_reads'] loop
  execute format('alter table public.%I add column row_version bigint not null default 1',t);
  if not exists(select 1 from information_schema.columns where table_schema='public' and table_name=t and column_name='updated_at') then execute format('alter table public.%I add column updated_at timestamptz not null default clock_timestamp()',t);end if;
  execute format('create trigger bump_row_version before update on public.%I for each row execute function aco_private.bump_row_version()',t);
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;
alter table public.aco_credits enable row level security;
alter table public.aco_calendar_claims enable row level security;
revoke all on public.aco_credits,public.aco_calendar_claims from public,anon,authenticated;
grant all on public.aco_credits,public.aco_calendar_claims to service_role;
revoke execute on function aco_private.create_package_credits(),aco_private.check_session_credit(),aco_private.bump_row_version() from public,anon,authenticated;
commit;
