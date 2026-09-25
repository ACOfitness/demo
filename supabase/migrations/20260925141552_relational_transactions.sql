begin;
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
commit;
