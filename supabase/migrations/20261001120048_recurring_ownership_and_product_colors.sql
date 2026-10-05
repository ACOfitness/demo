alter table public.aco_holds add column holiday_override boolean not null default false;
alter table public.aco_sessions add column holiday_override boolean not null default false;
-- Recurring ownership is checked atomically after pattern locks.
update public.aco_settings set coach_hold_hours=72 where coach_hold_hours=48;
update public.aco_packages set protection_until=valid_until+(select protection_days from public.aco_settings limit 1) where not frozen;
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
 where c.trainer_id=any(p_trainers) and c.starts_at>aco_private.app_now() and not p.frozen and p.protection_until>today and (c.starts_at at time zone 'Europe/Warsaw')::date>=p.starts_on
 and c.client_id is distinct from p.client_id
 and slot.weekday=extract(isodow from c.starts_at at time zone 'Europe/Warsaw')::integer-1 and slot.hour=extract(hour from c.starts_at at time zone 'Europe/Warsaw')::integer
 and not exists(select 1 from public.aco_sessions s where s.package_id=p.id and ((s.starts_at=c.starts_at and s.status like 'cancelled%') or s.original_starts_at=c.starts_at)))
 then raise exception 'Recurring time is protected for another client' using errcode='23514';end if;

 if exists(select 1 from public.aco_calendar_claims c join public.aco_holds h on h.trainer_id=c.trainer_id join public.aco_hold_slots s on s.hold_id=h.id
 where c.trainer_id=any(p_trainers) and c.starts_at>aco_private.app_now() and h.status='active' and h.expires_at>aco_private.app_now() and c.client_id is distinct from h.client_id
 and (c.starts_at at time zone 'Europe/Warsaw')::date>=h.starts_on and s.weekday=extract(isodow from c.starts_at at time zone 'Europe/Warsaw')::int-1 and s.hour=extract(hour from c.starts_at at time zone 'Europe/Warsaw')::int
 and not exists(select 1 from public.aco_hold_dates d where d.hold_id=h.id and d.original_starts_at=c.starts_at))
 then raise exception 'Recurring time is protected for another client' using errcode='23514';end if;
 -- Two different clients cannot own the same recurring pattern, even if all dates were moved to exceptions.
 if exists(with rights as (
 select p.client_id,c.lead_trainer_id trainer_id,s.weekday,s.hour from public.aco_packages p join public.aco_clients c on c.id=p.client_id join public.aco_package_slots s on s.package_id=p.id where not p.frozen and p.protection_until>today
 union all select h.client_id,h.trainer_id,s.weekday,s.hour from public.aco_holds h join public.aco_hold_slots s on s.hold_id=h.id where h.status='active' and h.expires_at>aco_private.app_now()
 ) select 1 from rights where trainer_id=any(p_trainers) group by trainer_id,weekday,hour having count(distinct client_id)>1)
 then raise exception 'Recurring time is protected for another client' using errcode='23514';end if;
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
 if p_action in ('individualPlan','reviewPlan','standardPlan','register','hold','editHold','payHold','makeup','reschedule','outcome','substitute','transferClient','block','unblock','freeze','validity','extend','availability') then
  for pattern in select distinct x from (
   select c.trainer_id::text||':'||(extract(isodow from c.starts_at at time zone 'Europe/Warsaw')::int-1)||':'||extract(hour from c.starts_at at time zone 'Europe/Warsaw')::int x from public.aco_calendar_claims c where c.client_id=any(p_clients)
   union select (v->'data'->>'trainer_id')||':'||(extract(isodow from (v->'data'->>'starts_at')::timestamptz at time zone 'Europe/Warsaw')::int-1)||':'||extract(hour from (v->'data'->>'starts_at')::timestamptz at time zone 'Europe/Warsaw')::int from jsonb_array_elements(p_changes) v where v->>'table' in ('aco_sessions','aco_blackouts')
   union select (v->'data'->>'trainer_id')||':'||(extract(isodow from ((v->'data'->>'starts_at')::timestamptz+interval '1 hour') at time zone 'Europe/Warsaw')::int-1)||':'||extract(hour from ((v->'data'->>'starts_at')::timestamptz+interval '1 hour') at time zone 'Europe/Warsaw')::int from jsonb_array_elements(p_changes) v where v->>'table'='aco_sessions' and v->'data'->>'kind'='consultation'
   union select coalesce((select v->'data'->>'trainer_id' from jsonb_array_elements(p_changes) v where v->>'table'='aco_holds' and v->'data'->>'id'=d->'data'->>'hold_id'),(select trainer_id::text from public.aco_holds where id=(d->'data'->>'hold_id')::uuid))||':'||(extract(isodow from (d->'data'->>'starts_at')::timestamptz at time zone 'Europe/Warsaw')::int-1)||':'||extract(hour from (d->'data'->>'starts_at')::timestamptz at time zone 'Europe/Warsaw')::int
    from jsonb_array_elements(p_changes) d where d->>'table'='aco_hold_dates'
   union select c.lead_trainer_id::text||':'||s.weekday||':'||s.hour from public.aco_package_slots s join public.aco_packages p on p.id=s.package_id join public.aco_clients c on c.id=p.client_id where p.client_id=any(p_clients)
   union select tr.trainer_id::text||':'||(d->'data'->>'weekday')||':'||(d->'data'->>'hour') from unnest(p_trainers) tr(trainer_id) cross join jsonb_array_elements(p_changes) d where d->>'table'in ('aco_package_slots','aco_hold_slots')
   union select h.trainer_id::text||':'||s.weekday||':'||s.hour from public.aco_hold_slots s join public.aco_holds h on h.id=s.hold_id where h.client_id=any(p_clients)
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
 if p_action in ('individualPlan','reviewPlan','standardPlan','register','hold','editHold','payHold','makeup','reschedule','outcome','substitute','transferClient','block','unblock','freeze','validity','extend','availability') then perform aco_private.rebuild_calendar(p_clients,p_trainers);end if;
 revision:=floor(extract(epoch from clock_timestamp())*1000000)::bigint;
 insert into aco_private.command_receipts(actor_id,request_id,request_hash,revision) values(p_actor,p_request,p_hash,revision);
 insert into aco_private.audit_log(actor_id,action,detail) values(p_actor,p_action,jsonb_build_object('request_id',p_request));
 return jsonb_build_object('revision',revision);
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
 where not p.client_id=any(clients) and not p.frozen and p.protection_until>(aco_private.app_now() at time zone 'Europe/Warsaw')::date and d::date>=p.starts_on
 and extract(isodow from d)::int-1=slot.weekday
 and not exists(select 1 from public.aco_sessions s where s.package_id=p.id and ((s.starts_at=((d::date+make_time(slot.hour,0,0)) at time zone 'Europe/Warsaw') and s.status like 'cancelled%') or s.original_starts_at=((d::date+make_time(slot.hour,0,0)) at time zone 'Europe/Warsaw')))
 union
 select h.trainer_id,((d::date+make_time(slot.hour,0,0)) at time zone 'Europe/Warsaw') from public.aco_holds h join public.aco_hold_slots slot on slot.hold_id=h.id
 cross join lateral generate_series((aco_private.app_now() at time zone 'Europe/Warsaw')::date,((aco_private.app_now() at time zone 'Europe/Warsaw')::date+coalesce(days,8)),interval '1 day') d
 where not h.client_id=any(clients) and h.status='active' and h.expires_at>aco_private.app_now() and d::date>=h.starts_on and extract(isodow from d)::int-1=slot.weekday
 and not exists(select 1 from public.aco_hold_dates hd where hd.hold_id=h.id and hd.original_starts_at=((d::date+make_time(slot.hour,0,0)) at time zone 'Europe/Warsaw'))
 ) select coalesce(jsonb_agg(jsonb_build_object('table','aco_busy_slots','key',trainer_id::text||':'||starts_at::text,'data',jsonb_build_object('trainer_id',trainer_id,'starts_at',starts_at))), '[]') into part from busy;
 result:=result||part;
 with rights as (
 select c.lead_trainer_id trainer_id,s.weekday,s.hour from public.aco_packages p join public.aco_clients c on c.id=p.client_id join public.aco_package_slots s on s.package_id=p.id where not p.client_id=any(clients) and not p.frozen and not p.frozen and p.protection_until>(aco_private.app_now() at time zone 'Europe/Warsaw')::date
 union select h.trainer_id,s.weekday,s.hour from public.aco_holds h join public.aco_hold_slots s on s.hold_id=h.id where not h.client_id=any(clients) and h.status='active' and h.expires_at>aco_private.app_now()
 ) select coalesce(jsonb_agg(jsonb_build_object('table','aco_recurring_busy','key',trainer_id::text||':'||weekday||':'||hour,'data',jsonb_build_object('trainer_id',trainer_id,'weekday',weekday,'hour',hour))),'[]') into part from rights;
 return result||part;
end $$;

alter table public.aco_products add column color text not null default '#CF513C' check(color ~ '^#[0-9a-fA-F]{6}$');
update public.aco_products set color='#317E77' where id='physio';
