begin;
-- Relational source of truth. Additive: the previous store stays intact until cutover.

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


create function aco_private.relational_tables() returns text[] language sql immutable set search_path='' as $$
 select array['aco_profiles','aco_accounts','aco_products','aco_settings','aco_product_prices','aco_trainers','aco_trainer_products','aco_trainer_rates','aco_trainer_payroll','aco_availability','aco_clients','aco_client_answers','aco_promotions','aco_substitutions','aco_packages','aco_package_slots','aco_holds','aco_hold_terms','aco_hold_slots','aco_hold_dates','aco_sessions','aco_public_notes','aco_trainer_notes','aco_comments','aco_earnings','aco_blackouts','aco_sales','aco_messages','aco_events','aco_notice_reads','aco_activity']::text[]
$$;
create function aco_private.relational_key(p_table text) returns text language sql immutable set search_path='' as $$
 select case when p_table in ('aco_public_notes','aco_trainer_notes') then 'session_id' when p_table='aco_trainer_payroll' then 'trainer_id' else 'id' end
$$;
create function aco_private.relational_session(p_actor uuid,p_session uuid) returns text language plpgsql security invoker set search_path='' as $$
declare result text;
begin
 if not exists(select 1 from auth.sessions where id=p_session and user_id=p_actor and (not_after is null or not_after>now())) then raise exception 'Session revoked' using errcode='42501';end if;
 select role into result from public.aco_accounts where id=p_actor and enabled;
 if result is null then raise exception 'Account disabled' using errcode='42501';end if;
 return result;
end $$;
-- Row-level touch propagation prevents phantom changes in a client's schedule or a trainer's availability.
create function aco_private.touch_parent() returns trigger language plpgsql security invoker set search_path='' as $$
declare r jsonb:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end; parent uuid;
begin
 if tg_table_name in ('aco_availability','aco_trainer_rates','aco_trainer_products') then
  update public.aco_trainers set row_version=row_version where id=(r->>'trainer_id')::uuid;
 elsif tg_table_name in ('aco_sessions','aco_holds','aco_packages','aco_substitutions') then
  update public.aco_clients set row_version=row_version where id=(r->>'client_id')::uuid;
 elsif tg_table_name in ('aco_hold_dates','aco_hold_slots','aco_hold_terms') then
  update public.aco_holds set row_version=row_version where id=(r->>'hold_id')::uuid;
 elsif tg_table_name='aco_package_slots' then
  update public.aco_packages set row_version=row_version where id=(r->>'package_id')::uuid;
 end if;
 return null;
end $$;
do $$declare t text;begin
 foreach t in array array['aco_availability','aco_trainer_rates','aco_trainer_products','aco_sessions','aco_holds','aco_packages','aco_substitutions','aco_hold_dates','aco_hold_slots','aco_hold_terms','aco_package_slots'] loop
 execute format('create trigger touch_parent after insert or update or delete on public.%I for each row execute function aco_private.touch_parent()',t);
 end loop;
end $$;

create function aco_private.rebuild_calendar(p_clients uuid[],p_trainers uuid[]) returns void language plpgsql security invoker set search_path='' as $$
declare today date:=(clock_timestamp() at time zone 'Europe/Warsaw')::date;
begin
 -- Only expired claims in the affected trainer scope are reclaimed.
 delete from public.aco_calendar_claims c using public.aco_holds h where c.hold_id=h.id and h.expires_at<=clock_timestamp() and c.trainer_id=any(p_trainers);
 delete from public.aco_calendar_claims where client_id=any(p_clients);
 insert into public.aco_calendar_claims(trainer_id,starts_at,client_id,session_id)
 select s.trainer_id,s.starts_at+n*interval '1 hour',s.client_id,s.id from public.aco_sessions s
 cross join lateral generate_series(0,case when s.kind='consultation' then 1 else 0 end) n
 where s.client_id=any(p_clients) and (s.status='scheduled' or s.kind='consultation' and s.status='completed' and s.ends_at>clock_timestamp());
 insert into public.aco_calendar_claims(trainer_id,starts_at,client_id,hold_id)
 select h.trainer_id,d.starts_at,h.client_id,h.id from public.aco_holds h join public.aco_hold_dates d on d.hold_id=h.id
 where h.client_id=any(p_clients) and h.status='active' and h.expires_at>clock_timestamp();
 -- A blackout is a real claim, not just an interface hint.
 delete from public.aco_calendar_claims c where c.blackout_id is not null and c.trainer_id=any(p_trainers)
 and not exists(select 1 from public.aco_blackouts b where b.id=c.blackout_id and b.starts_at=c.starts_at and b.trainer_id=c.trainer_id);
 insert into public.aco_calendar_claims(trainer_id,starts_at,blackout_id)
 select b.trainer_id,b.starts_at,b.id from public.aco_blackouts b where b.trainer_id=any(p_trainers)
 and not exists(select 1 from public.aco_calendar_claims c where c.blackout_id=b.id);
 -- Availability edits cannot strand booked sessions. Half-hour consultations still require both hourly blocks.
 if exists(select 1 from public.aco_calendar_claims c where c.trainer_id=any(p_trainers) and c.starts_at>clock_timestamp() and c.blackout_id is null and not exists(
  select 1 from public.aco_availability a where a.trainer_id=c.trainer_id and a.weekday=extract(isodow from c.starts_at at time zone 'Europe/Warsaw')::integer-1 and a.hour=extract(hour from c.starts_at at time zone 'Europe/Warsaw')::integer
 )) then raise exception 'Reservation outside trainer availability' using errcode='23514';end if;
 -- These checks include holds, so a concurrent checkout cannot exceed day/week intensity.
 if exists(with dates as (
  select s.client_id,s.starts_at from public.aco_sessions s where s.client_id=any(p_clients) and s.kind='training' and s.status in ('scheduled','completed','no_show','cancelled_late')
  union all select h.client_id,d.starts_at from public.aco_holds h join public.aco_hold_dates d on d.hold_id=h.id where h.client_id=any(p_clients) and h.status='active' and h.expires_at>clock_timestamp()
 ) select 1 from dates group by client_id,(starts_at at time zone 'Europe/Warsaw')::date having count(*)>1)
 then raise exception 'Only one training per client per day' using errcode='23514';end if;
 if exists(with dates as (
  select s.client_id,s.starts_at from public.aco_sessions s where s.client_id=any(p_clients) and s.kind='training' and s.status in ('scheduled','completed','no_show','cancelled_late')
  union all select h.client_id,d.starts_at from public.aco_holds h join public.aco_hold_dates d on d.hold_id=h.id where h.client_id=any(p_clients) and h.status='active' and h.expires_at>clock_timestamp()
 ) select 1 from dates d join public.aco_clients c on c.id=d.client_id group by d.client_id,c.intensity,date_trunc('week',d.starts_at at time zone 'Europe/Warsaw') having count(*)>c.intensity)
 then raise exception 'Weekly intensity exceeded' using errcode='23514';end if;
 if exists(select 1 from public.aco_holds where client_id=any(p_clients) and status='active' and expires_at>clock_timestamp() group by client_id having count(*)>1)
 then raise exception 'Client already has an active checkout' using errcode='23514';end if;
 -- Protect recurring slots against phantom package/hold inserts in another transaction.
 if exists(select 1 from public.aco_calendar_claims c
 join public.aco_clients owner on owner.lead_trainer_id=c.trainer_id
 join public.aco_packages p on p.client_id=owner.id
 join public.aco_package_slots slot on slot.package_id=p.id
 where c.trainer_id=any(p_trainers) and c.starts_at>clock_timestamp() and p.protection_until>today and (c.starts_at at time zone 'Europe/Warsaw')::date>=p.starts_on
 and c.client_id is distinct from p.client_id
 and slot.weekday=extract(isodow from c.starts_at at time zone 'Europe/Warsaw')::integer-1 and slot.hour=extract(hour from c.starts_at at time zone 'Europe/Warsaw')::integer
 and not exists(select 1 from public.aco_sessions s where s.package_id=p.id and ((s.starts_at=c.starts_at and s.status like 'cancelled%') or s.original_starts_at=c.starts_at)))
 then raise exception 'Recurring time is protected for another client' using errcode='23514';end if;
end $$;

-- A fixed whitelist governs typed row writes. Parameters never become SQL identifiers.
create function aco_private.write_relational_row(p_table text,p_key text,p_data jsonb) returns void language plpgsql security invoker set search_path='' as $$
declare columns_sql text;updates_sql text; key_column text:=aco_private.relational_key(p_table);
begin
 if not p_table=any(aco_private.relational_tables()) or jsonb_typeof(p_data)<>'object' or p_data->>key_column is distinct from p_key then raise exception 'Invalid row target' using errcode='22023';end if;
 if p_data ?| array['row_version','updated_at'] or exists(select 1 from jsonb_object_keys(p_data) k where not exists(select 1 from information_schema.columns c where c.table_schema='public' and c.table_name=p_table and c.column_name=k)) then raise exception 'Unknown or protected column' using errcode='22023';end if;
 select string_agg(format('%I',k),',' order by k),string_agg(format('%I=excluded.%I',k,k),',' order by k) filter(where k<>key_column)
 into columns_sql,updates_sql from jsonb_object_keys(p_data) k;
 execute format('insert into public.%I(%s) select %s from jsonb_populate_record(null::public.%I,$1) r on conflict(%I) do update set %s',p_table,columns_sql,columns_sql,p_table,key_column,updates_sql) using p_data;
end $$;

create function public.aco_relational_commit(p_actor uuid,p_session uuid,p_request uuid,p_hash text,p_action text,p_role text,p_changes jsonb,p_removed jsonb,p_dependencies jsonb,p_clients uuid[],p_trainers uuid[])
returns jsonb language plpgsql security invoker set search_path='' as $$
declare actual_role text; item jsonb; t text; key text; actual_version bigint; expected_version bigint; receipt aco_private.command_receipts; revision bigint; trainer uuid; client uuid; pattern text; writing boolean;
begin
 if length(p_hash)<>64 or p_hash!~'^[0-9a-f]+$' or length(p_action)>100 or jsonb_array_length(p_changes)>10000 or jsonb_array_length(p_removed)>10000 then raise exception 'Invalid command' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('aco-request:'||p_actor||':'||p_request,0));
 select * into receipt from aco_private.command_receipts where actor_id=p_actor and request_id=p_request;
 if found then
  if receipt.request_hash<>p_hash then raise exception 'Request id reused' using errcode='22023';end if;
  if p_action<>'register' then perform aco_private.relational_session(p_actor,p_session);end if;
  return jsonb_build_object('revision',receipt.revision,'replayed',true);
 end if;
 if p_action='register' then
  if p_session is not null or exists(select 1 from public.aco_accounts where id=p_actor) or not exists(select 1 from auth.users where id=p_actor) then raise exception 'Invalid registration' using errcode='42501';end if;
  actual_role:='registration';
 else actual_role:=aco_private.relational_session(p_actor,p_session);end if;
 if actual_role<>p_role then raise exception 'Role changed' using errcode='42501';end if;
 if actual_role='client' and p_action not in ('outcome','reschedule','hold','editHold','makeup','comment','sendLetter','readLetter','readNotice','updateProfile','changePassword','finishActivation','requestPayment','emailVerified') then raise exception 'Client operation denied' using errcode='42501';end if;
 if actual_role='trainer' and p_action not in ('activate','outcome','notes','comment','reschedule','hold','editHold','sendLetter','readLetter','readNotice','updateProfile','changePassword','emailVerified') then raise exception 'Trainer operation denied' using errcode='42501';end if;

 -- Defense in depth: service callers cannot accidentally submit another client's scope.
 if actual_role='client' and exists(select 1 from unnest(p_clients) c where c<>(select profile_id from public.aco_accounts where id=p_actor)) then raise exception 'Client scope denied' using errcode='42501';end if;
 if actual_role='trainer' and exists(select 1 from unnest(p_clients) x(client_id) where not exists(
 select 1 from public.aco_clients c join public.aco_accounts a on a.id=p_actor where c.id=x.client_id and (c.lead_trainer_id=a.profile_id or exists(select 1 from public.aco_substitutions s where s.client_id=c.id and s.trainer_id=a.profile_id and s.revoked_at is null and s.expires_at>now()))
 )) then raise exception 'Trainer scope denied' using errcode='42501';end if;
 -- Deterministic lock order, only affected customers. No company-wide revision lock.
 for client in select distinct unnest(p_clients) order by 1 loop perform pg_advisory_xact_lock(hashtextextended('aco-client:'||client,0));end loop;
 for trainer in select distinct unnest(p_trainers) order by 1 loop
  if p_action in ('availability','trainer','rate','deleteTrainer') then perform pg_advisory_xact_lock(hashtextextended('aco-trainer:'||trainer,0));
  else perform pg_advisory_xact_lock_shared(hashtextextended('aco-trainer:'||trainer,0));end if;
 end loop;
 -- Pattern locks protect recurring rights, while unrelated hours/trainers remain concurrent.
 if p_action in ('register','hold','editHold','payHold','makeup','reschedule','outcome','substitute','transferClient','block','unblock','freeze','validity','extend','availability') then
  for pattern in select distinct x from (
   select c.trainer_id::text||':'||(extract(isodow from c.starts_at at time zone 'Europe/Warsaw')::int-1)||':'||extract(hour from c.starts_at at time zone 'Europe/Warsaw')::int x from public.aco_calendar_claims c where c.client_id=any(p_clients)
   union select (v->'data'->>'trainer_id')||':'||(extract(isodow from (v->'data'->>'starts_at')::timestamptz at time zone 'Europe/Warsaw')::int-1)||':'||extract(hour from (v->'data'->>'starts_at')::timestamptz at time zone 'Europe/Warsaw')::int from jsonb_array_elements(p_changes) v where v->>'table' in ('aco_sessions','aco_blackouts')
   union select (v->'data'->>'trainer_id')||':'||(extract(isodow from ((v->'data'->>'starts_at')::timestamptz+interval '1 hour') at time zone 'Europe/Warsaw')::int-1)||':'||extract(hour from ((v->'data'->>'starts_at')::timestamptz+interval '1 hour') at time zone 'Europe/Warsaw')::int from jsonb_array_elements(p_changes) v where v->>'table'='aco_sessions' and v->'data'->>'kind'='consultation'
   union select coalesce((select v->'data'->>'trainer_id' from jsonb_array_elements(p_changes) v where v->>'table'='aco_holds' and v->'data'->>'id'=d->'data'->>'hold_id'),(select trainer_id::text from public.aco_holds where id=(d->'data'->>'hold_id')::uuid))||':'||(extract(isodow from (d->'data'->>'starts_at')::timestamptz at time zone 'Europe/Warsaw')::int-1)||':'||extract(hour from (d->'data'->>'starts_at')::timestamptz at time zone 'Europe/Warsaw')::int
    from jsonb_array_elements(p_changes) d where d->>'table'='aco_hold_dates'
   union select c.lead_trainer_id::text||':'||s.weekday||':'||s.hour from public.aco_package_slots s join public.aco_packages p on p.id=s.package_id join public.aco_clients c on c.id=p.client_id where p.client_id=any(p_clients)
   union select tr.trainer_id::text||':'||(d->'data'->>'weekday')||':'||(d->'data'->>'hour') from unnest(p_trainers) tr(trainer_id) cross join jsonb_array_elements(p_changes) d where d->>'table'='aco_package_slots'
   union select c.trainer_id::text||':'||(extract(isodow from c.starts_at at time zone 'Europe/Warsaw')::int-1)||':'||extract(hour from c.starts_at at time zone 'Europe/Warsaw')::int from public.aco_calendar_claims c where c.blackout_id::text in(select v->>'key' from jsonb_array_elements(p_removed) v where v->>'table'='aco_blackouts')
  ) q where x is not null order by x loop perform pg_advisory_xact_lock(hashtextextended('aco-pattern:'||pattern,0));end loop;
 end if;
 -- Validate row versions under row locks before writing any mutation.
 for item in select distinct on(v->>'table',v->>'key') v from jsonb_array_elements(p_changes||p_removed||p_dependencies) v order by v->>'table',v->>'key' loop
  t:=item->>'table';key:=item->>'key';expected_version:=(item->>'version')::bigint;
  if not t=any(aco_private.relational_tables()) then raise exception 'Invalid dependency' using errcode='22023';end if;
  writing:=exists(select 1 from jsonb_array_elements(p_changes||p_removed) v where v->>'table'=t and v->>'key'=key);
  execute format('select row_version from public.%I where %I::text=$1 for %s',t,aco_private.relational_key(t),case when writing then 'update' else 'share' end) into actual_version using key;
  if actual_version is distinct from expected_version then raise exception 'Row changed; reload and retry' using errcode='40001';end if;
 end loop;
 -- Remove only replaceable relation rows. History and financial records cannot be hard-deleted.
 for item in select value from jsonb_array_elements(p_removed) loop
  t:=item->>'table';key:=item->>'key';
  if t not in ('aco_availability','aco_trainer_products','aco_trainer_rates','aco_client_answers','aco_hold_dates','aco_hold_slots','aco_package_slots','aco_blackouts') then raise exception 'Deletion forbidden' using errcode='42501';end if;
  if t='aco_blackouts' then delete from public.aco_calendar_claims where blackout_id=key::uuid;end if;
  execute format('delete from public.%I where %I::text=$1',t,aco_private.relational_key(t)) using key;
 end loop;
 foreach t in array aco_private.relational_tables() loop
  for item in select value from jsonb_array_elements(p_changes) where value->>'table'=t order by value->>'key' loop
   if actual_role='registration' and t='aco_accounts' and (item->'data'->>'id'<>p_actor::text or item->'data'->>'role'<>'client') then raise exception 'Invalid registration role' using errcode='42501';end if;
   perform aco_private.write_relational_row(t,item->>'key',item->'data');
  end loop;
 end loop;
 if p_action in ('register','hold','editHold','payHold','makeup','reschedule','outcome','substitute','transferClient','block','unblock','freeze','validity','extend','availability') then perform aco_private.rebuild_calendar(p_clients,p_trainers);end if;
 revision:=floor(extract(epoch from clock_timestamp())*1000000)::bigint;
 insert into aco_private.command_receipts(actor_id,request_id,request_hash,revision) values(p_actor,p_request,p_hash,revision);
 insert into aco_private.audit_log(actor_id,action,detail) values(p_actor,p_action,jsonb_build_object('request_id',p_request));
 return jsonb_build_object('revision',revision);
end $$;
revoke all on function public.aco_relational_commit(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb,uuid[],uuid[]) from public,anon,authenticated;
grant execute on function public.aco_relational_commit(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb,uuid[],uuid[]) to service_role;
revoke all on function aco_private.relational_tables(),aco_private.relational_key(text),aco_private.relational_session(uuid,uuid),aco_private.touch_parent(),aco_private.rebuild_calendar(uuid[],uuid[]),aco_private.write_relational_row(text,text,jsonb) from public,anon,authenticated;
grant execute on function aco_private.relational_tables(),aco_private.relational_key(text),aco_private.relational_session(uuid,uuid),aco_private.touch_parent(),aco_private.rebuild_calendar(uuid[],uuid[]),aco_private.write_relational_row(text,text,jsonb) to service_role;


-- Browser roles never execute privileged loaders or write domain rows directly.
-- The API validates Auth first; these functions also validate the live session.
create function aco_private.relational_rows(p_actor uuid,p_role text,p_email text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare profile uuid; clients uuid[]; historical uuid[]; sessions uuid[]; contacts uuid[];
 result jsonb:='[]'; part jsonb; t text; predicate text; days integer;
begin
 select profile_id into profile from public.aco_accounts where id=p_actor;
 select coalesce(array_agg(c.id),'{}') into clients from public.aco_clients c where
 p_role='admin' or c.id=profile or p_role='trainer' and (c.lead_trainer_id=profile or exists(
 select 1 from public.aco_substitutions s where s.client_id=c.id and s.trainer_id=profile and s.revoked_at is null and s.expires_at>now()))
 or p_role='registration' and exists(select 1 from public.aco_profiles p where p.id=c.id and lower(p.email)=lower(p_email));
 select coalesce(array_agg(s.id),'{}') into sessions from public.aco_sessions s where s.client_id=any(clients)
 or p_role='trainer' and s.trainer_id=profile and s.substitution_id is null and s.ends_at<=now();
 select coalesce(array_agg(distinct client_id),'{}') into historical from public.aco_sessions where id=any(sessions) and not client_id=any(clients);
 select coalesce(array_agg(distinct id),'{}') into contacts from public.aco_profiles p where p_role='admin' or p.id=profile or p.id=any(clients)
 or p_role<>'registration' and exists(select 1 from public.aco_accounts a where a.profile_id=p.id and a.role='admin')
 or exists(select 1 from public.aco_clients c where c.id=any(clients) and c.lead_trainer_id=p.id)
 or exists(select 1 from public.aco_substitutions s where s.client_id=any(clients) and s.trainer_id=p.id and s.revoked_at is null and s.expires_at>now())
 or exists(select 1 from public.aco_messages m where (m.sender_id=profile and m.recipient_id=p.id) or (m.recipient_id=profile and m.sender_id=p.id));
 foreach t in array aco_private.relational_tables() loop
 predicate:=case
 when t in ('aco_products','aco_product_prices','aco_settings','aco_trainers','aco_trainer_products','aco_availability') then 'true'
 when t in ('aco_profiles') then 'id=any($4)'
 when t='aco_accounts' then 'profile_id=any($4)'
 when t in ('aco_trainer_rates','aco_trainer_payroll','aco_earnings') then '$1=''admin'' or trainer_id=$2'
 when t='aco_clients' then 'id=any($3)'
 when t in ('aco_client_answers','aco_packages','aco_holds','aco_substitutions') then 'client_id=any($3)'
 when t='aco_package_slots' then 'package_id in(select id from public.aco_packages where client_id=any($3))'
 when t in ('aco_hold_dates','aco_hold_slots','aco_hold_terms') then 'hold_id in(select id from public.aco_holds where client_id=any($3))'
 when t='aco_sessions' then 'id=any($5)'
 when t in ('aco_public_notes','aco_comments') then 'session_id=any($5)'
 when t='aco_trainer_notes' then '$1 in (''trainer'',''admin'') and session_id=any($5)'
 when t='aco_sales' then '$1=''admin'' or $1=''client'' and client_id=$2'
 when t='aco_messages' then 'sender_id=$2 or recipient_id=$2'
 when t='aco_notice_reads' then 'profile_id=$2'
 when t='aco_activity' then '$1=''admin'''
 when t='aco_events' then '($1=''admin'' and audience in (''admin'',''all'')) or (client_id=any($3) and (audience=''all'' or $1=''client'' and audience=''client'' or $1=''trainer'' and audience=''staff''))'
 -- Codes stay inside the API to validate quotes; projectState never exposes them.
 when t='aco_promotions' then '$1=''admin'' or kind=''code'' or lower(value) in(select lower(email) from public.aco_profiles where id=any($3))'
 when t='aco_blackouts' then 'true'
 else 'false' end;
 execute format('select coalesce(jsonb_agg(jsonb_build_object(''table'',$6,''key'',r.%I::text,''version'',r.row_version,''data'',to_jsonb(r))),''[]''::jsonb) from public.%I r where %s',aco_private.relational_key(t),t,predicate)
 into part using p_role,profile,clients,contacts,sessions,t;
 result:=result||part;
 end loop;
 -- Only names are retained for former clients; their contact and questionnaire data are excluded.
 select coalesce(jsonb_agg(jsonb_build_object('table','aco_clients','key',c.id,'version',c.row_version,'data',jsonb_build_object('id',c.id,'product',c.product))), '[]') into part from public.aco_clients c where c.id=any(historical);
 result:=result||part;
 select coalesce(jsonb_agg(jsonb_build_object('table','aco_trainer_directory','key',p.id,'data',jsonb_build_object('id',p.id,'name',p.name,'avatar_path',p.avatar_path))), '[]') into part from public.aco_profiles p where p.id=any(historical) or exists(select 1 from public.aco_trainers t where t.id=p.id);
 result:=result||part;
 select case when p_role='registration' then consultation_days+1 else 366 end into days from public.aco_settings where id='company';
 -- Occupancy is intentionally anonymous: no client, package or session identifier.
 with busy as (
 select c.trainer_id,c.starts_at from public.aco_calendar_claims c where c.starts_at>=now()-interval '2 hours' and c.starts_at<now()+coalesce(days,8)*interval '1 day'
 and (c.client_id is null or not c.client_id=any(clients)) and (c.session_id is null or not c.session_id=any(sessions))
 and (c.hold_id is null or exists(select 1 from public.aco_holds h where h.id=c.hold_id and h.status='active' and h.expires_at>now())) and c.blackout_id is null
 union
 select owner.lead_trainer_id,((d::date+make_time(slot.hour,0,0)) at time zone 'Europe/Warsaw') from public.aco_packages p
 join public.aco_clients owner on owner.id=p.client_id join public.aco_package_slots slot on slot.package_id=p.id
 cross join lateral generate_series((now() at time zone 'Europe/Warsaw')::date,((now() at time zone 'Europe/Warsaw')::date+coalesce(days,8)),interval '1 day') d
 where not p.client_id=any(clients) and p.protection_until>(now() at time zone 'Europe/Warsaw')::date and d::date>=p.starts_on
 and extract(isodow from d)::int-1=slot.weekday
 and not exists(select 1 from public.aco_sessions s where s.package_id=p.id and ((s.starts_at=((d::date+make_time(slot.hour,0,0)) at time zone 'Europe/Warsaw') and s.status like 'cancelled%') or s.original_starts_at=((d::date+make_time(slot.hour,0,0)) at time zone 'Europe/Warsaw')))
 ) select coalesce(jsonb_agg(jsonb_build_object('table','aco_busy_slots','key',trainer_id::text||':'||starts_at::text,'data',jsonb_build_object('trainer_id',trainer_id,'starts_at',starts_at))), '[]') into part from busy;
 return result||part;
end $$;
create function public.aco_relational_load(p_actor uuid,p_session uuid,p_request uuid default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare role text; receipt jsonb;
begin
 role:=aco_private.relational_session(p_actor,p_session);
 select jsonb_build_object('hash',request_hash,'revision',revision) into receipt from aco_private.command_receipts where actor_id=p_actor and request_id=p_request;
 return jsonb_build_object('role',role,'now',now(),'revision',floor(extract(epoch from now())*1000000)::bigint,'rows',aco_private.relational_rows(p_actor,role),'receipt',receipt);
end $$;
create function public.aco_relational_public_load(p_email text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
begin
 if length(p_email)>254 then raise exception 'Invalid email' using errcode='22023';end if;
 return jsonb_build_object('role','registration','now',now(),'revision',floor(extract(epoch from now())*1000000)::bigint,'rows',aco_private.relational_rows(null,'registration',p_email));
end $$;
-- Fail closed, including any obsolete policies left by the initial prototype.
-- No browser token can bypass the scoped server projections with a direct REST request.
do $$declare t text; p record;begin
 foreach t in array aco_private.relational_tables() loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from anon,authenticated',t);
 for p in select policyname from pg_policies where schemaname='public' and tablename=t loop execute format('drop policy %I on public.%I',p.policyname,t);end loop;
 end loop;
end $$;
revoke all on function aco_private.relational_rows(uuid,text,text),public.aco_relational_load(uuid,uuid,uuid),public.aco_relational_public_load(text) from public,anon,authenticated;
grant execute on function aco_private.relational_rows(uuid,text,text),public.aco_relational_load(uuid,uuid,uuid),public.aco_relational_public_load(text) to service_role;


-- Financial snapshots cannot be repriced by a subsequent catalog change.
create function aco_private.protect_financial_snapshot() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_table_name='aco_packages' and (new.price_grosz,new.base_price_grosz,new.count,new.product,new.intensity,new.client_id) is distinct from (old.price_grosz,old.base_price_grosz,old.count,old.product,old.intensity,old.client_id) then
 raise exception 'Purchased package snapshot is immutable' using errcode='23514';end if;
 return new;
end $$;
create trigger protect_financial_snapshot before update on public.aco_packages for each row execute function aco_private.protect_financial_snapshot();
create function aco_private.check_checkout_transition() returns trigger language plpgsql set search_path='' as $$
begin
 if new.status='paid' and old.status<>'paid' and (old.status<>'active' or old.expires_at<=clock_timestamp()) then raise exception 'Checkout expired' using errcode='23514';end if;
 if old.status='paid' and new.status<>'paid' then raise exception 'Paid checkout cannot be reopened' using errcode='23514';end if;
 return new;
end $$;
create trigger check_checkout_transition before update on public.aco_holds for each row execute function aco_private.check_checkout_transition();
-- Index every foreign-key lookup used by authorization, scheduling and settlements.
create index aco_substitution_client on public.aco_substitutions(client_id);
create index aco_session_substitution on public.aco_sessions(substitution_id) where substitution_id is not null;
create index aco_session_credit on public.aco_sessions(credit_id) where credit_id is not null;
create index aco_packages_promotion on public.aco_packages(promotion_id) where promotion_id is not null;
create index aco_packages_protection on public.aco_packages(protection_until,client_id);
create index aco_messages_sender_created on public.aco_messages(sender_id,created_at desc);
create index aco_messages_recipient_created on public.aco_messages(recipient_id,created_at desc);
revoke all on public.aco_notifications from anon,authenticated;
revoke all on function aco_private.protect_financial_snapshot(),aco_private.check_checkout_transition() from public,anon,authenticated;
grant execute on function aco_private.protect_financial_snapshot(),aco_private.check_checkout_transition() to service_role;
-- Cutover is a separate explicit transaction, run after deploying the new API.
-- It preserves the original store, refuses unknown/new data, and does not change roles.
create function aco_private.import_initial_runtime() returns jsonb language plpgsql set search_path='' as $$
declare r record; settings jsonb; rules jsonb; source_count integer; target_count integer;
begin
 lock table aco_private.runtime_entities in share row exclusive mode;
 if exists(select 1 from aco_private.runtime_entities where kind not in ('accounts','settings','audit'))
 or exists(select 1 from aco_private.runtime_entities where kind='accounts' and payload->>'role'<>'admin') then
 raise exception 'Runtime changed: full data migration required before cutover';end if;
 if exists(select 1 from public.aco_accounts) then raise exception 'Relational database already initialized';end if;
 for r in select payload p from aco_private.runtime_entities where kind='accounts' loop
 insert into public.aco_profiles(id,auth_user_id,name,email,phone,must_change_password)
 values((r.p->>'id')::uuid,(r.p->>'id')::uuid,coalesce(r.p->>'name','Administrator ACO!'),r.p->>'email',coalesce(r.p->>'phone',''),coalesce((r.p->>'mustChangePassword')::boolean,false));
 insert into public.aco_accounts(id,profile_id,role,enabled) select user_id,user_id,role,enabled from aco_private.identities where user_id=(r.p->>'id')::uuid;
 end loop;
 select payload into strict settings from aco_private.runtime_entities where kind='settings' and id='singleton';rules:=settings->'rules';
 insert into public.aco_settings values('company',(settings->>'consultation')::numeric*100,(settings->>'personal')::numeric*100,(settings->>'physio')::numeric*100,(settings->>'cancelHours')::int,
 (rules->>'cycleWeeks')::int,(rules->>'validWeeks')::int,(rules->>'renewalDays')::int,(rules->>'coachHoldHours')::int,(rules->>'checkoutMinutes')::int,(rules->>'protectionDays')::int,(rules->>'consultationDays')::int,(rules->>'startDays')::int,(rules->>'substituteHours')::int,(rules->>'freezeDays')::int,1,now());
 insert into public.aco_products(id,name,subtitle,bullets) values
 ('personal','Trening personalny','Pakiet treningów indywidualnych. Stałe godziny i wsparcie trenera.',array['60 minut tylko dla Ciebie','Stałe godziny w grafiku','Dziennik i komentarze trenera']),
 ('physio','Powrót do zdrowia','Pakiet treningów indywidualnych. Stałe godziny i wsparcie trenera.',array['60 minut tylko dla Ciebie','Stałe godziny w grafiku','Dziennik i komentarze trenera']);
 insert into public.aco_product_prices(id,product_id,intensity,amount_grosz)
 select product||':'||intensity,product,intensity,(settings->'packagePrices'->product->>intensity::text)::numeric*100 from unnest(array['personal','physio']) product cross join generate_series(1,3) intensity;
 insert into public.aco_activity(id,description,created_at) select (payload->>'id')::uuid,payload->>'text',(payload->>'at')::timestamptz from aco_private.runtime_entities where kind='audit';
 select count(*) into source_count from aco_private.runtime_entities where kind='accounts';select count(*) into target_count from public.aco_accounts;
 if source_count<>target_count then raise exception 'Account count mismatch';end if;
 return jsonb_build_object('accounts',target_count,'products',2,'prices',6,'activity',(select count(*) from public.aco_activity));
end $$;
revoke all on function aco_private.import_initial_runtime() from public,anon,authenticated,service_role;

select aco_private.import_initial_runtime();
revoke insert,update,delete on aco_private.runtime_entities from service_role;
revoke execute on function public.aco_runtime_commit(uuid,uuid,bigint,uuid,text,jsonb,jsonb,text) from service_role;
commit;
select (select count(*) from public.aco_accounts) accounts,(select count(*) from public.aco_products) products,(select count(*) from public.aco_product_prices) prices,(select count(*) from public.aco_activity) activity;
