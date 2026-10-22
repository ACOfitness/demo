-- Additive migration; no existing visits, credits, financial snapshots or ACLs changed.
begin;
alter table public.aco_clients add column flexible_schedule boolean not null default false;
alter table public.aco_holds add column flexible boolean not null default false;
alter table public.aco_packages add column flexible boolean not null default false;
alter table public.aco_packages add column pending_start boolean not null default false;
alter table public.aco_packages add column start_deadline date;
alter table public.aco_packages add constraint aco_flexible_start_check check (
 (not flexible and not pending_start and start_deadline is null) or (flexible and start_deadline is not null)
);
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
 if actual_role='trainer' and p_action not in ('scheduleMode','individualPlan','makeup','activate','outcome','notes','comment','reschedule','hold','editHold','sendLetter','readAll','readLetter','readNotice','changePassword') then raise exception 'Trainer operation denied' using errcode='42501';end if;

 -- Defense in depth: service callers cannot accidentally submit another client's scope.
 if actual_role='client' and exists(select 1 from unnest(p_clients) c where c<>(select profile_id from public.aco_accounts where id=p_actor)) then raise exception 'Client scope denied' using errcode='42501';end if;
 if actual_role='trainer' and exists(select 1 from unnest(p_clients) x(client_id) where not exists(
 select 1 from public.aco_clients c join public.aco_accounts a on a.id=p_actor where c.id=x.client_id and (c.lead_trainer_id=a.profile_id or exists(select 1 from public.aco_substitutions s where s.client_id=c.id and s.trainer_id=a.profile_id and s.revoked_at is null and s.expires_at>aco_private.app_now()))
 )) then raise exception 'Trainer scope denied' using errcode='42501';end if;
 if p_action='startDeadline' and actual_role<>'admin' then raise exception 'Admin only' using errcode='42501';end if;
 if p_action='scheduleMode' and actual_role='trainer' and exists(select 1 from unnest(p_clients) x(client_id) join public.aco_clients c on c.id=x.client_id where c.lead_trainer_id<>(select profile_id from public.aco_accounts where id=p_actor)) then raise exception 'Lead trainer only' using errcode='42501';end if;
 -- Deterministic lock order, only affected customers. No company-wide revision lock.
 for client in select distinct unnest(p_clients) order by 1 loop perform pg_advisory_xact_lock(hashtextextended('aco-client:'||client,0));end loop;
 for trainer in select distinct unnest(p_trainers) order by 1 loop
  if p_action in ('availability','trainer','rate','deleteTrainer') then perform pg_advisory_xact_lock(hashtextextended('aco-trainer:'||trainer,0));
  else perform pg_advisory_xact_lock_shared(hashtextextended('aco-trainer:'||trainer,0));end if;
 end loop;
 -- Pattern locks protect recurring rights, while unrelated hours/trainers remain concurrent.
 if p_action in ('startDeadline','adminClient','individualPlan','reviewPlan','standardPlan','register','hold','editHold','payHold','makeup','reschedule','outcome','substitute','transferClient','block','unblock','freeze','validity','extend','availability') then
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
  if t='aco_locations' then
   if actual_role<>'admin' or p_action<>'deleteLocation' or key='00000000-0000-4000-8000-000000000ac0' then raise exception 'Deletion forbidden' using errcode='42501';end if;
  elsif t='aco_earnings' then
   if not (
    actual_role='admin' and p_action='deleteExtraHours' and exists(select 1 from public.aco_earnings where id=key::uuid and kind='company' and settled_at is null)
    or actual_role in ('admin','trainer') and p_action='outcome' and exists(
      select 1 from public.aco_earnings e join public.aco_sessions s on s.id=e.session_id
      where e.id=key::uuid and e.kind in ('training','consultation') and s.status in ('completed','no_show')
      and (actual_role='admin' or s.trainer_id=(select profile_id from public.aco_accounts where id=p_actor))
      and exists(select 1 from jsonb_array_elements(p_changes) v where v->>'table'='aco_sessions' and v->>'key'=s.id::text and v->'data'->>'status'='scheduled')
    )
   ) then raise exception 'Deletion forbidden' using errcode='42501';end if;
  elsif t not in ('aco_availability','aco_trainer_products','aco_trainer_rates','aco_client_answers','aco_hold_dates','aco_hold_slots','aco_package_slots','aco_blackouts','aco_notice_reads','aco_consultation_rates','aco_individual_plans') then raise exception 'Deletion forbidden' using errcode='42501';end if;
  if t='aco_blackouts' then delete from public.aco_calendar_claims where blackout_id=key::uuid;end if;
  execute format('delete from public.%I where %I::text=$1',t,aco_private.relational_key(t)) using key;
 end loop;
 foreach t in array aco_private.relational_tables() loop
  for item in select value from jsonb_array_elements(p_changes) where value->>'table'=t order by value->>'key' loop
   if actual_role='registration' and t='aco_accounts' and (item->'data'->>'id'<>p_actor::text or item->'data'->>'role'<>'client') then raise exception 'Invalid registration role' using errcode='42501';end if;
   if t='aco_earnings' and exists(select 1 from public.aco_earnings where id=(item->>'key')::uuid and kind='company' and settled_at is not null) then
    if actual_role<>'admin' or p_action<>'correctExtraHours' then raise exception 'Settled hours require correction' using errcode='42501';end if;
    if exists(select 1 from public.aco_earnings e where e.id=(item->>'key')::uuid and (
     item->'data'->>'trainer_id'<>e.trainer_id::text or item->'data'->>'month'<>e.month::text or (item->'data'->>'settled_at')::timestamptz is distinct from e.settled_at
     or jsonb_array_length(item->'data'->'corrections')<>jsonb_array_length(e.corrections)+1
     or ((item->'data'->'corrections') - (jsonb_array_length(item->'data'->'corrections')-1))<>e.corrections
    )) then raise exception 'Correction history must be preserved' using errcode='42501';end if;
   end if;
   perform aco_private.write_relational_row(t,item->>'key',item->'data');
  end loop;
 end loop;
 if p_action in ('startDeadline','adminClient','individualPlan','reviewPlan','standardPlan','register','hold','editHold','payHold','makeup','reschedule','outcome','substitute','transferClient','block','unblock','freeze','validity','extend','availability') then perform aco_private.rebuild_calendar(p_clients,p_trainers);end if;
 revision:=floor(extract(epoch from clock_timestamp())*1000000)::bigint;
 insert into aco_private.command_receipts(actor_id,request_id,request_hash,revision) values(p_actor,p_request,p_hash,revision);
 insert into aco_private.audit_log(actor_id,action,detail) values(p_actor,p_action,jsonb_build_object('request_id',p_request));
 return jsonb_build_object('revision',revision);
end $$;
commit;
