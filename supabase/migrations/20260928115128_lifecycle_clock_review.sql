begin;
alter table public.aco_clients add column archived_at timestamptz;
alter table public.aco_trainers add column description text not null default '' check(length(description)<=2000), add column location_id uuid not null default '00000000-0000-4000-8000-000000000ac0' references public.aco_locations(id), add column consultation_rate_grosz integer check(consultation_rate_grosz>0);
create index aco_trainers_location_idx on public.aco_trainers(location_id);
create table public.aco_consultation_rates(id text primary key,trainer_id uuid not null references public.aco_trainers(id),effective_from date not null,rate_grosz integer not null check(rate_grosz>0),row_version bigint not null default 1,updated_at timestamptz not null default clock_timestamp(),unique(trainer_id,effective_from));
create table public.aco_individual_plans(id text primary key,client_id uuid not null references public.aco_clients(id),slot text not null check(slot in ('approved','proposal')),product text not null references public.aco_products(id),intensity integer not null check(intensity between 1 and 7),cycle_weeks integer not null check(cycle_weeks between 1 and 52),validity_weeks integer not null check(validity_weeks between cycle_weeks and 104),price_grosz integer not null check(price_grosz>=0),status text not null check(status in ('pending','approved','rejected')),proposed_by text not null,proposed_at timestamptz not null,approved_at timestamptz,row_version bigint not null default 1,updated_at timestamptz not null default clock_timestamp(),unique(client_id,slot));
alter table public.aco_hold_terms drop constraint aco_settings_check;
alter table public.aco_hold_terms add check(validity_weeks between cycle_weeks and 104);
alter table public.aco_holds add column base_price_grosz integer check(base_price_grosz>=0),add column ignore_limits boolean not null default false;
alter table public.aco_sessions add column ignore_limits boolean not null default false;
drop index public.aco_training_one_per_day;
create unique index aco_training_one_per_day on public.aco_sessions(client_id,((starts_at at time zone 'Europe/Warsaw')::date)) where kind='training' and status in ('scheduled','completed','no_show','cancelled_late') and not ignore_limits;
-- Expand only individual plan constraints; ordinary product price tiers remain 1/2/3.
do $$declare r record;begin
 for r in select conrelid::regclass tab,conname,pg_get_constraintdef(oid) def from pg_constraint where contype='c' and conrelid in ('public.aco_clients'::regclass,'public.aco_packages'::regclass,'public.aco_holds'::regclass) and (pg_get_constraintdef(oid) like '%intensity%' or pg_get_constraintdef(oid) like '%156%') loop
 execute format('alter table %s drop constraint %I',r.tab,r.conname);
 execute format('alter table %s add constraint %I %s',r.tab,r.conname,replace(replace(r.def,'<= 3','<= 7'),'<= 156','<= 364'));
 end loop;
end $$;
alter table public.aco_package_slots drop constraint aco_package_slots_package_id_weekday_key;
alter table public.aco_package_slots add unique(package_id,weekday,hour);
alter table public.aco_hold_slots drop constraint aco_hold_slots_hold_id_weekday_key;
alter table public.aco_hold_slots add unique(hold_id,weekday,hour);
do $$declare t text;begin foreach t in array array['aco_consultation_rates','aco_individual_plans'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant all on public.%I to service_role',t);
 execute format('create trigger bump_row_version before update on public.%I for each row execute function aco_private.bump_row_version()',t);
 execute format('create trigger touch_parent after insert or update or delete on public.%I for each row execute function aco_private.touch_parent()',t);
end loop;end $$;
create table aco_private.test_clock(id boolean primary key default true check(id),time_offset_seconds bigint not null default 0 check(abs(time_offset_seconds)<=315576000),version bigint not null default 0,enabled boolean not null default false,updated_at timestamptz not null default clock_timestamp(),updated_by uuid);
insert into aco_private.test_clock(id,enabled) values(true,true);
alter table aco_private.test_clock enable row level security;
revoke all on aco_private.test_clock from public,anon,authenticated;
grant select,update on aco_private.test_clock to service_role;
create function aco_private.app_now() returns timestamptz language sql stable security invoker set search_path='' as $$select statement_timestamp()+case when enabled then time_offset_seconds else 0 end*interval '1 second' from aco_private.test_clock where id$$;
revoke all on function aco_private.app_now() from public,anon,authenticated;
grant execute on function aco_private.app_now() to service_role;
-- Shared business operations may run concurrently; clock changes and account lifecycle take an exclusive gate.
create function public.aco_set_test_clock(p_actor uuid,p_session uuid,p_request uuid,p_hash text,p_target timestamptz) returns void language plpgsql security invoker set search_path='' as $$
declare r aco_private.command_receipts;delta bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended('aco-clock',0));
 if aco_private.relational_session(p_actor,p_session)<>'admin' then raise exception 'Admin required' using errcode='42501';end if;
 if not (select enabled from aco_private.test_clock where id) then raise exception 'Test tools disabled' using errcode='42501';end if;
 select * into r from aco_private.command_receipts where actor_id=p_actor and request_id=p_request;
 if found then if r.request_hash<>p_hash then raise exception 'Request reused';end if;return;end if;
 delta:=case when p_target is null then 0 else round(extract(epoch from p_target-clock_timestamp()))::bigint end;
 if abs(delta)>315576000 then raise exception 'Offset exceeds ten years';end if;
 update aco_private.test_clock set time_offset_seconds=delta,version=version+1,updated_at=clock_timestamp(),updated_by=p_actor where id;
 -- Expired reservations must not revive and collide when an administrator moves backwards.
 update public.aco_holds set status='expired' where status='active' and expires_at<=aco_private.app_now();
 perform aco_private.rebuild_calendar(array(select id from public.aco_clients),array(select id from public.aco_trainers));
 insert into aco_private.command_receipts(actor_id,request_id,request_hash,revision) values(p_actor,p_request,p_hash,floor(extract(epoch from clock_timestamp())*1000000));
 insert into aco_private.audit_log(actor_id,action,detail) values(p_actor,'testClock',jsonb_build_object('offset_seconds',delta));
end $$;
revoke all on function public.aco_set_test_clock(uuid,uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.aco_set_test_clock(uuid,uuid,uuid,text,timestamptz) to service_role;
create table aco_private.account_deletions(target uuid primary key,actor_id uuid not null,created_at timestamptz not null default clock_timestamp());
alter table aco_private.account_deletions enable row level security;
revoke all on aco_private.account_deletions from public,anon,authenticated;
grant select,insert on aco_private.account_deletions to service_role;
grant update on aco_private.audit_log to service_role;
grant delete on aco_private.direct_activations,aco_private.command_receipts,aco_private.identities to service_role;
create function public.aco_account_lifecycle(p_actor uuid,p_session uuid,p_request uuid,p_hash text,p_target uuid,p_mode text) returns jsonb language plpgsql security invoker set search_path='' as $$
declare a public.aco_accounts;sid uuid[];hid uuid[];pid uuid[];subid uuid[];r aco_private.command_receipts;
begin
 perform pg_advisory_xact_lock(hashtextextended('aco-clock',0));
 if aco_private.relational_session(p_actor,p_session)<>'admin' or p_target=p_actor or p_mode not in ('archive','purge') then raise exception 'Admin operation denied' using errcode='42501';end if;
 select * into r from aco_private.command_receipts where actor_id=p_actor and request_id=p_request;
 if found then if r.request_hash<>p_hash then raise exception 'Request reused';end if;return jsonb_build_object('authUserId',case when p_mode='purge' then p_target else null end);end if;
 select * into a from public.aco_accounts where id=p_target for update;
 if not found then
  if p_mode='purge' and exists(select 1 from aco_private.account_deletions where target=p_target) then return jsonb_build_object('authUserId',p_target);end if;
  raise exception 'Account missing' using errcode='22023';
 end if;
 if a.role not in ('client','trainer') then raise exception 'Cannot remove administrator' using errcode='42501';end if;
 if a.role='trainer' and (exists(select 1 from public.aco_clients where lead_trainer_id=a.profile_id) or exists(select 1 from public.aco_sessions where trainer_id=a.profile_id and status='scheduled') or exists(select 1 from public.aco_holds where trainer_id=a.profile_id and status='active' and expires_at>aco_private.app_now())) then raise exception 'Trainer still has clients or unsettled appointments' using errcode='23514';end if;
 if p_mode='purge' and a.role='trainer' and exists(select 1 from public.aco_sessions where trainer_id=a.profile_id) then raise exception 'Existing client history must be preserved' using errcode='23514';end if;
 update public.aco_accounts set enabled=false where id=p_target;
 perform public.aco_revoke_sessions(p_target);
 update aco_private.identities set enabled=false where user_id=p_target;
 if p_mode='archive' then
  if a.role='client' then
   update public.aco_clients set archived_at=clock_timestamp() where id=a.profile_id;
   update public.aco_holds set status='expired' where client_id=a.profile_id and status='active';
   update public.aco_sessions set status='cancelled_early' where client_id=a.profile_id and status='scheduled' and starts_at>aco_private.app_now();
   update public.aco_packages set frozen=true,protection_until=least(protection_until,(aco_private.app_now() at time zone 'Europe/Warsaw')::date) where client_id=a.profile_id;
   perform aco_private.rebuild_calendar(array[a.profile_id],array(select lead_trainer_id from public.aco_clients where id=a.profile_id));
  else update public.aco_trainers set deleted_at=clock_timestamp() where id=a.profile_id;end if;
 else
  select coalesce(array_agg(id),'{}') into sid from public.aco_sessions where client_id=a.profile_id or trainer_id=a.profile_id;
  select coalesce(array_agg(id),'{}') into hid from public.aco_holds where client_id=a.profile_id or trainer_id=a.profile_id;
  select coalesce(array_agg(id),'{}') into pid from public.aco_packages where client_id=a.profile_id;
  select coalesce(array_agg(id),'{}') into subid from public.aco_substitutions where client_id=a.profile_id or trainer_id=a.profile_id;
  delete from public.aco_calendar_claims where client_id=a.profile_id or trainer_id=a.profile_id or session_id=any(sid) or hold_id=any(hid);
  delete from public.aco_public_notes where session_id=any(sid);
  delete from public.aco_trainer_notes where session_id=any(sid);
  delete from public.aco_comments where session_id=any(sid) or author_id=a.profile_id;
  update public.aco_public_notes set updated_by=null where updated_by=a.profile_id;
  update public.aco_trainer_notes set updated_by=null where updated_by=a.profile_id;
  delete from public.aco_earnings where session_id=any(sid) or trainer_id=a.profile_id;
  -- Retain a different client's purchase when only their former trainer is removed.
  update public.aco_sales set session_id=null where session_id=any(sid) and client_id<>a.profile_id;
  delete from public.aco_sales where client_id=a.profile_id;
  update public.aco_sales set settled_by=null where settled_by=a.profile_id;
  delete from public.aco_sessions where id=any(sid);
  update public.aco_sessions set substitution_id=null where substitution_id=any(subid);
  delete from public.aco_hold_dates where hold_id=any(hid);
  delete from public.aco_hold_slots where hold_id=any(hid);
  delete from public.aco_hold_terms where hold_id=any(hid);
  delete from public.aco_holds where id=any(hid);
  delete from public.aco_package_slots where package_id=any(pid);
  delete from public.aco_credits where package_id=any(pid);
  delete from public.aco_packages where id=any(pid);
  delete from public.aco_substitutions where id=any(subid);
  delete from public.aco_individual_plans where client_id=a.profile_id;
  delete from public.aco_client_answers where client_id=a.profile_id;
  delete from public.aco_events where client_id=a.profile_id;
  delete from public.aco_notice_reads where profile_id=a.profile_id;
  delete from public.aco_messages where sender_id=a.profile_id or recipient_id=a.profile_id;
  delete from public.aco_notifications where recipient_id=a.profile_id;
  update public.aco_clients set approved_by=null where approved_by=a.profile_id;
  delete from public.aco_clients where id=a.profile_id;
  delete from public.aco_blackouts where trainer_id=a.profile_id;
  delete from public.aco_availability where trainer_id=a.profile_id;
  delete from public.aco_trainer_products where trainer_id=a.profile_id;
  delete from public.aco_trainer_rates where trainer_id=a.profile_id;
  delete from public.aco_consultation_rates where trainer_id=a.profile_id;
  delete from public.aco_trainer_payroll where trainer_id=a.profile_id;
  delete from public.aco_trainers where id=a.profile_id;
  update public.aco_activity set actor_id=null where actor_id=a.profile_id;
  delete from aco_private.direct_activations where user_id=p_target;
  delete from aco_private.command_receipts where actor_id=p_target;
  update aco_private.audit_log set actor_id=null where actor_id=p_target;
  delete from aco_private.identities where user_id=p_target;
  delete from public.aco_accounts where id=p_target;
  delete from public.aco_profiles where id=a.profile_id;
  insert into aco_private.account_deletions(target,actor_id) values(p_target,p_actor);
 end if;
 insert into aco_private.command_receipts(actor_id,request_id,request_hash,revision) values(p_actor,p_request,p_hash,floor(extract(epoch from clock_timestamp())*1000000));
 insert into aco_private.audit_log(actor_id,action,detail) values(p_actor,'accountLifecycle',jsonb_build_object('target',p_target,'mode',p_mode));
 return jsonb_build_object('authUserId',case when p_mode='purge' then p_target else null end);
end $$;
revoke all on function public.aco_account_lifecycle(uuid,uuid,uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.aco_account_lifecycle(uuid,uuid,uuid,text,uuid,text) to service_role;

create or replace function aco_private.relational_tables() returns text[] language sql immutable set search_path='' as $$
 select array['aco_profiles','aco_accounts','aco_products','aco_settings','aco_locations','aco_product_prices','aco_trainers','aco_trainer_products','aco_trainer_rates','aco_consultation_rates','aco_trainer_payroll','aco_availability','aco_clients','aco_client_answers','aco_individual_plans','aco_promotions','aco_substitutions','aco_packages','aco_package_slots','aco_holds','aco_hold_terms','aco_hold_slots','aco_hold_dates','aco_sessions','aco_public_notes','aco_trainer_notes','aco_comments','aco_earnings','aco_blackouts','aco_sales','aco_messages','aco_events','aco_notice_reads','aco_activity']::text[]
$$;
create or replace function aco_private.touch_parent() returns trigger language plpgsql security invoker set search_path='' as $$
declare r jsonb:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end; parent uuid;
begin
 if tg_table_name in ('aco_availability','aco_consultation_rates','aco_trainer_rates','aco_trainer_products') then
  update public.aco_trainers set row_version=row_version where id=(r->>'trainer_id')::uuid;
 elsif tg_table_name in ('aco_individual_plans','aco_sessions','aco_holds','aco_packages','aco_substitutions') then
  update public.aco_clients set row_version=row_version where id=(r->>'client_id')::uuid;
 elsif tg_table_name in ('aco_hold_dates','aco_hold_slots','aco_hold_terms') then
  update public.aco_holds set row_version=row_version where id=(r->>'hold_id')::uuid;
 elsif tg_table_name='aco_package_slots' then
  update public.aco_packages set row_version=row_version where id=(r->>'package_id')::uuid;
 end if;
 return null;
end $$;
create or replace function aco_private.relational_rows(p_actor uuid,p_role text,p_email text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare profile uuid; clients uuid[]; historical uuid[]; sessions uuid[]; contacts uuid[];
 result jsonb:='[]'; part jsonb; t text; predicate text; days integer;
begin
 select profile_id into profile from public.aco_accounts where id=p_actor;
 select coalesce(array_agg(c.id),'{}') into clients from public.aco_clients c where
 p_role='admin' or c.id=profile or p_role='trainer' and (c.lead_trainer_id=profile or exists(
 select 1 from public.aco_substitutions s where s.client_id=c.id and s.trainer_id=profile and s.revoked_at is null and s.expires_at>aco_private.app_now()))
 or p_role='registration' and exists(select 1 from public.aco_profiles p where p.id=c.id and lower(p.email)=lower(p_email));
 select coalesce(array_agg(s.id),'{}') into sessions from public.aco_sessions s where s.client_id=any(clients)
 or p_role='trainer' and s.trainer_id=profile and s.substitution_id is null and s.ends_at<=aco_private.app_now();
 select coalesce(array_agg(distinct client_id),'{}') into historical from public.aco_sessions where id=any(sessions) and not client_id=any(clients);
 select coalesce(array_agg(distinct id),'{}') into contacts from public.aco_profiles p where p_role='admin' or p.id=profile or p.id=any(clients)
 or p_role<>'registration' and exists(select 1 from public.aco_accounts a where a.profile_id=p.id and a.role='admin')
 or exists(select 1 from public.aco_clients c where c.id=any(clients) and c.lead_trainer_id=p.id)
 or exists(select 1 from public.aco_substitutions s where s.client_id=any(clients) and s.trainer_id=p.id and s.revoked_at is null and s.expires_at>aco_private.app_now())
 or exists(select 1 from public.aco_messages m where (m.sender_id=profile and m.recipient_id=p.id) or (m.recipient_id=profile and m.sender_id=p.id));
 foreach t in array aco_private.relational_tables() loop
 predicate:=case
 when t in ('aco_locations','aco_products','aco_product_prices','aco_settings','aco_trainers','aco_trainer_products','aco_availability') then 'true'
 when t in ('aco_profiles') then 'id=any($4)'
 when t='aco_accounts' then 'profile_id=any($4)'
 when t in ('aco_consultation_rates','aco_trainer_rates','aco_trainer_payroll','aco_earnings') then '$1=''admin'' or trainer_id=$2'
 when t='aco_clients' then 'id=any($3)'
 when t in ('aco_individual_plans','aco_client_answers','aco_packages','aco_holds','aco_substitutions') then 'client_id=any($3)'
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
 select c.trainer_id,c.starts_at from public.aco_calendar_claims c where c.starts_at>=aco_private.app_now()-interval '2 hours' and c.starts_at<aco_private.app_now()+coalesce(days,8)*interval '1 day'
 and (c.client_id is null or not c.client_id=any(clients)) and (c.session_id is null or not c.session_id=any(sessions))
 and (c.hold_id is null or exists(select 1 from public.aco_holds h where h.id=c.hold_id and h.status='active' and h.expires_at>aco_private.app_now())) and c.blackout_id is null
 union
 select owner.lead_trainer_id,((d::date+make_time(slot.hour,0,0)) at time zone 'Europe/Warsaw') from public.aco_packages p
 join public.aco_clients owner on owner.id=p.client_id join public.aco_package_slots slot on slot.package_id=p.id
 cross join lateral generate_series((aco_private.app_now() at time zone 'Europe/Warsaw')::date,((aco_private.app_now() at time zone 'Europe/Warsaw')::date+coalesce(days,8)),interval '1 day') d
 where not p.client_id=any(clients) and p.protection_until>(aco_private.app_now() at time zone 'Europe/Warsaw')::date and d::date>=p.starts_on
 and extract(isodow from d)::int-1=slot.weekday
 and not exists(select 1 from public.aco_sessions s where s.package_id=p.id and ((s.starts_at=((d::date+make_time(slot.hour,0,0)) at time zone 'Europe/Warsaw') and s.status like 'cancelled%') or s.original_starts_at=((d::date+make_time(slot.hour,0,0)) at time zone 'Europe/Warsaw')))
 ) select coalesce(jsonb_agg(jsonb_build_object('table','aco_busy_slots','key',trainer_id::text||':'||starts_at::text,'data',jsonb_build_object('trainer_id',trainer_id,'starts_at',starts_at))), '[]') into part from busy;
 return result||part;
end $$;
create or replace function public.aco_relational_load(p_actor uuid,p_session uuid,p_request uuid default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare role text; receipt jsonb;
begin
 role:=aco_private.relational_session(p_actor,p_session);
 select jsonb_build_object('hash',request_hash,'revision',revision) into receipt from aco_private.command_receipts where actor_id=p_actor and request_id=p_request;
 return jsonb_build_object('role',role,'now',aco_private.app_now(),'clockVersion',(select version from aco_private.test_clock where id),'timeOffsetSeconds',(select case when enabled then time_offset_seconds else 0 end from aco_private.test_clock where id),'testToolsEnabled',(select enabled from aco_private.test_clock where id),'revision',floor(extract(epoch from now())*1000000)::bigint,'rows',aco_private.relational_rows(p_actor,role),'receipt',receipt);
end $$;
create or replace function public.aco_relational_public_load(p_email text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
begin
 if length(p_email)>254 then raise exception 'Invalid email' using errcode='22023';end if;
 return jsonb_build_object('role','registration','now',aco_private.app_now(),'clockVersion',(select version from aco_private.test_clock where id),'timeOffsetSeconds',(select case when enabled then time_offset_seconds else 0 end from aco_private.test_clock where id),'testToolsEnabled',(select enabled from aco_private.test_clock where id),'revision',floor(extract(epoch from now())*1000000)::bigint,'rows',aco_private.relational_rows(null,'registration',p_email));
end $$;
create or replace function aco_private.rebuild_calendar(p_clients uuid[],p_trainers uuid[]) returns void language plpgsql security invoker set search_path='' as $$
declare today date:=(aco_private.app_now() at time zone 'Europe/Warsaw')::date;
begin
 -- Only expired claims in the affected trainer scope are reclaimed.
 delete from public.aco_calendar_claims c using public.aco_holds h where c.hold_id=h.id and h.expires_at<=aco_private.app_now() and c.trainer_id=any(p_trainers);
 delete from public.aco_calendar_claims where client_id=any(p_clients);
 insert into public.aco_calendar_claims(trainer_id,starts_at,client_id,session_id)
 select s.trainer_id,s.starts_at+n*interval '1 hour',s.client_id,s.id from public.aco_sessions s
 cross join lateral generate_series(0,case when s.kind='consultation' then 1 else 0 end) n
 where s.client_id=any(p_clients) and (s.status='scheduled' or s.kind='consultation' and s.status='completed' and s.ends_at>aco_private.app_now());
 insert into public.aco_calendar_claims(trainer_id,starts_at,client_id,hold_id)
 select h.trainer_id,d.starts_at,h.client_id,h.id from public.aco_holds h join public.aco_hold_dates d on d.hold_id=h.id
 where h.client_id=any(p_clients) and h.status='active' and h.expires_at>aco_private.app_now();
 -- A blackout is a real claim, not just an interface hint.
 delete from public.aco_calendar_claims c where c.blackout_id is not null and c.trainer_id=any(p_trainers)
 and not exists(select 1 from public.aco_blackouts b where b.id=c.blackout_id and b.starts_at=c.starts_at and b.trainer_id=c.trainer_id);
 insert into public.aco_calendar_claims(trainer_id,starts_at,blackout_id)
 select b.trainer_id,b.starts_at,b.id from public.aco_blackouts b where b.trainer_id=any(p_trainers)
 and not exists(select 1 from public.aco_calendar_claims c where c.blackout_id=b.id);
 -- Availability edits cannot strand booked sessions. Half-hour consultations still require both hourly blocks.
 if exists(select 1 from public.aco_calendar_claims c where c.trainer_id=any(p_trainers) and c.starts_at>aco_private.app_now() and c.blackout_id is null and not exists(
  select 1 from public.aco_availability a where a.trainer_id=c.trainer_id and a.weekday=extract(isodow from c.starts_at at time zone 'Europe/Warsaw')::integer-1 and a.hour=extract(hour from c.starts_at at time zone 'Europe/Warsaw')::integer
 )) then raise exception 'Reservation outside trainer availability' using errcode='23514';end if;
 -- These checks include holds, so a concurrent checkout cannot exceed day/week intensity.
 if exists(with dates as (
  select s.client_id,s.starts_at,s.ignore_limits,coalesce(p.intensity,c.intensity) intensity from public.aco_sessions s join public.aco_clients c on c.id=s.client_id left join public.aco_packages p on p.id=s.package_id where s.client_id=any(p_clients) and s.kind='training' and s.status in ('scheduled','completed','no_show','cancelled_late')
  union all select h.client_id,d.starts_at,h.ignore_limits,h.intensity from public.aco_holds h join public.aco_hold_dates d on d.hold_id=h.id where h.client_id=any(p_clients) and h.status='active' and h.expires_at>aco_private.app_now()
 ) select 1 from dates group by client_id,(starts_at at time zone 'Europe/Warsaw')::date having count(*)>1 and not bool_or(ignore_limits))
 then raise exception 'Only one training per client per day' using errcode='23514';end if;
 if exists(with dates as (
  select s.client_id,s.starts_at,s.ignore_limits,coalesce(p.intensity,c.intensity) intensity from public.aco_sessions s join public.aco_clients c on c.id=s.client_id left join public.aco_packages p on p.id=s.package_id where s.client_id=any(p_clients) and s.kind='training' and s.status in ('scheduled','completed','no_show','cancelled_late')
  union all select h.client_id,d.starts_at,h.ignore_limits,h.intensity from public.aco_holds h join public.aco_hold_dates d on d.hold_id=h.id where h.client_id=any(p_clients) and h.status='active' and h.expires_at>aco_private.app_now()
 ) select 1 from dates d group by d.client_id,date_trunc('week',d.starts_at at time zone 'Europe/Warsaw') having count(*)>max(d.intensity) and not bool_or(d.ignore_limits))
 then raise exception 'Weekly intensity exceeded' using errcode='23514';end if;
 if exists(select 1 from public.aco_holds where client_id=any(p_clients) and status='active' and expires_at>aco_private.app_now() group by client_id having count(*)>1)
 then raise exception 'Client already has an active checkout' using errcode='23514';end if;
 -- Protect recurring slots against phantom package/hold inserts in another transaction.
 if exists(select 1 from public.aco_calendar_claims c
 join public.aco_clients owner on owner.lead_trainer_id=c.trainer_id
 join public.aco_packages p on p.client_id=owner.id
 join public.aco_package_slots slot on slot.package_id=p.id
 where c.trainer_id=any(p_trainers) and c.starts_at>aco_private.app_now() and p.protection_until>today and (c.starts_at at time zone 'Europe/Warsaw')::date>=p.starts_on
 and c.client_id is distinct from p.client_id
 and slot.weekday=extract(isodow from c.starts_at at time zone 'Europe/Warsaw')::integer-1 and slot.hour=extract(hour from c.starts_at at time zone 'Europe/Warsaw')::integer
 and not exists(select 1 from public.aco_sessions s where s.package_id=p.id and ((s.starts_at=c.starts_at and s.status like 'cancelled%') or s.original_starts_at=c.starts_at)))
 then raise exception 'Recurring time is protected for another client' using errcode='23514';end if;
end $$;
create or replace function aco_private.check_checkout_transition() returns trigger language plpgsql set search_path='' as $$
begin
 if new.status='paid' and old.status<>'paid' and (old.status<>'active' or old.expires_at<=aco_private.app_now()) then raise exception 'Checkout expired' using errcode='23514';end if;
 if old.status='paid' and new.status<>'paid' then raise exception 'Paid checkout cannot be reopened' using errcode='23514';end if;
 return new;
end $$;
create or replace function public.aco_relational_commit(p_actor uuid,p_session uuid,p_request uuid,p_hash text,p_action text,p_role text,p_changes jsonb,p_removed jsonb,p_dependencies jsonb,p_clients uuid[],p_trainers uuid[],p_clock_version bigint)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare actual_role text; item jsonb; t text; key text; actual_version bigint; expected_version bigint; receipt aco_private.command_receipts; revision bigint; trainer uuid; client uuid; pattern text; writing boolean;
begin
 perform pg_advisory_xact_lock_shared(hashtextextended('aco-clock',0));
 if p_clock_version is distinct from (select version from aco_private.test_clock where id) then raise exception 'Clock changed; reload' using errcode='40001';end if;
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
 if actual_role='client' and p_action not in ('outcome','reschedule','hold','editHold','makeup','comment','sendLetter','readAll','readLetter','readNotice','updateProfile','changePassword','finishActivation','requestPayment','emailVerified') then raise exception 'Client operation denied' using errcode='42501';end if;
 if actual_role='trainer' and p_action not in ('individualPlan','makeup','activate','outcome','notes','comment','reschedule','hold','editHold','sendLetter','readAll','readLetter','readNotice','updateProfile','changePassword','emailVerified') then raise exception 'Trainer operation denied' using errcode='42501';end if;

 -- Defense in depth: service callers cannot accidentally submit another client's scope.
 if actual_role='client' and exists(select 1 from unnest(p_clients) c where c<>(select profile_id from public.aco_accounts where id=p_actor)) then raise exception 'Client scope denied' using errcode='42501';end if;
 if actual_role='trainer' and exists(select 1 from unnest(p_clients) x(client_id) where not exists(
 select 1 from public.aco_clients c join public.aco_accounts a on a.id=p_actor where c.id=x.client_id and (c.lead_trainer_id=a.profile_id or exists(select 1 from public.aco_substitutions s where s.client_id=c.id and s.trainer_id=a.profile_id and s.revoked_at is null and s.expires_at>aco_private.app_now()))
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
  if t not in ('aco_availability','aco_trainer_products','aco_trainer_rates','aco_client_answers','aco_hold_dates','aco_hold_slots','aco_package_slots','aco_blackouts','aco_notice_reads','aco_consultation_rates','aco_individual_plans') then raise exception 'Deletion forbidden' using errcode='42501';end if;
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
revoke all on function public.aco_relational_commit(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb,uuid[],uuid[],bigint) from public,anon,authenticated;
grant execute on function public.aco_relational_commit(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb,uuid[],uuid[],bigint) to service_role;

create or replace function public.aco_relational_commit(p_actor uuid,p_session uuid,p_request uuid,p_hash text,p_action text,p_role text,p_changes jsonb,p_removed jsonb,p_dependencies jsonb,p_clients uuid[],p_trainers uuid[]) returns jsonb language sql security invoker set search_path='' as $$
 select public.aco_relational_commit(p_actor,p_session,p_request,p_hash,p_action,p_role,p_changes,p_removed,p_dependencies,p_clients,p_trainers,0::bigint)
$$;
create or replace function public.aco_complete_activation(p_user uuid,p_request uuid)
returns boolean language plpgsql security invoker set search_path='' as $$
declare a public.aco_accounts; c public.aco_clients; claim aco_private.direct_activations;
begin
 perform pg_advisory_xact_lock_shared(hashtextextended('aco-clock',0));
 select * into a from public.aco_accounts where id=p_user and role='client' and enabled for update;
 if a.id is null then raise exception 'Activation unavailable' using errcode='42501';end if;
 select * into c from public.aco_clients where id=a.profile_id for update;
 select * into claim from aco_private.direct_activations where user_id=p_user and request_id=p_request for update;
 if claim.user_id is null then raise exception 'Activation unavailable' using errcode='42501';end if;
 if claim.completed_at is not null then return true;end if;
 if c.status is distinct from 'approved' or c.product is null or c.intensity is null then raise exception 'Activation unavailable' using errcode='42501';end if;
 perform public.aco_revoke_sessions(a.id);
 update public.aco_clients set status='active' where id=c.id;
 update aco_private.direct_activations set completed_at=now() where user_id=p_user;
 insert into public.aco_events(id,client_id,title,body,audience,created_at) values(gen_random_uuid(),c.id,'Witamy w ACO!','Twoje konto jest aktywne. Możesz wybrać terminy treningów.','client',aco_private.app_now());
 insert into public.aco_activity(id,actor_id,description,created_at) values(gen_random_uuid(),c.id,'Aktywacja konta klienta bez linku e-mail.',aco_private.app_now());
 return true;
end $$;
commit;
