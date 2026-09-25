begin;
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
commit;
