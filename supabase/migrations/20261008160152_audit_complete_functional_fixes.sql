begin;
alter table public.aco_holds add column payment_quote jsonb check(payment_quote is null or jsonb_typeof(payment_quote)='object');

create or replace function public.aco_registration_identity(p_request uuid,p_hash text,p_email text)
returns uuid language sql stable security definer set search_path='' as $$
 select u.id from auth.users u where lower(to_jsonb(u)->>'email')=lower(trim(p_email))
 and ((to_jsonb(u)->'raw_app_meta_data'->'aco_registration'->>'requestId'=p_request::text
 and to_jsonb(u)->'raw_app_meta_data'->'aco_registration'->>'hash'=p_hash)
 or (jsonb_typeof(to_jsonb(u)->'raw_app_meta_data'->'aco_registration')='object'
 and to_jsonb(u)->>'email_confirmed_at' is null
 and not exists(select 1 from public.aco_accounts a where a.id=u.id)))
 limit 1
$$;
revoke all on function public.aco_registration_identity(uuid,text,text) from public,anon,authenticated;
grant execute on function public.aco_registration_identity(uuid,text,text) to service_role;
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
 or p_role='trainer' and s.trainer_id=profile and s.ends_at<=aco_private.app_now();
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
 when t='aco_trainer_rates' then '$1=''admin'' or trainer_id=$2 or $1=''client'' and trainer_id in(select trainer_id from public.aco_sessions where client_id=any($3))'
 when t in ('aco_consultation_rates','aco_trainer_payroll','aco_earnings') then '$1=''admin'' or trainer_id=$2'
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
-- Recover pending requests made by the previous API, which persisted the code only.
with prices as (
 select h.id,coalesce(h.base_price_grosz,h.price_grosz) base,
 p.percent,p.id promo,p.kind,p.value from public.aco_holds h
 join public.aco_profiles owner on owner.id=h.client_id
 left join lateral (select promo.* from public.aco_promotions promo where
 (promo.kind='code' and upper(promo.value)=upper(h.promotion_code)
 and (promo.expires_on is null or promo.expires_on>=(h.payment_requested_at at time zone 'Europe/Warsaw')::date))
 or (promo.kind='email' and lower(promo.value)=lower(owner.email) and promo.active)
 order by promo.percent desc limit 1) p on true
 where h.payment_requested_at is not null and h.payment_quote is null and h.status='active'
)
update public.aco_holds h set price_grosz=round(prices.base*(100-coalesce(prices.percent,0))/100)::integer,
 payment_quote=jsonb_strip_nulls(jsonb_build_object('base',prices.base/100.0,
 'total',round(prices.base*(100-coalesce(prices.percent,0))/100)/100.0,'percent',coalesce(prices.percent,0),
 'promotionId',prices.promo,'code',case when prices.kind='code' then prices.value else null end))
from prices where h.id=prices.id;

commit;
