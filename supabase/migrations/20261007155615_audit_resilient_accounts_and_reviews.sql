begin;
alter table public.aco_settings add column payment_review_hours integer not null default 72 check(payment_review_hours between 1 and 366);
alter table public.aco_hold_terms add column payment_review_hours integer not null default 72 check(payment_review_hours between 1 and 366);
alter table aco_private.direct_activations add column credential_proof text check(credential_proof ~ '^[a-f0-9]{64}$'),add column attempt_id uuid,add column lease_until timestamptz;
-- Only the backend can look up identities created by this exact registration.
create function public.aco_registration_identity(p_request uuid,p_hash text,p_email text)
returns uuid language sql stable security definer set search_path='' as $$
 select u.id from auth.users u where lower(to_jsonb(u)->>'email')=lower(trim(p_email))
 and to_jsonb(u)->'raw_app_meta_data'->'aco_registration'->>'requestId'=p_request::text
 and to_jsonb(u)->'raw_app_meta_data'->'aco_registration'->>'hash'=p_hash
 limit 1
$$;
create function public.aco_claim_activation_retry(p_email text,p_birth_date date,p_request uuid,p_proof text,p_attempt uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare a public.aco_accounts;c public.aco_clients;claim aco_private.direct_activations;fresh boolean;can_write boolean;
begin
 if p_proof is null or p_proof !~ '^[a-f0-9]{64}$' then raise exception 'Invalid proof' using errcode='42501';end if;
 select ac.* into a from public.aco_accounts ac join public.aco_profiles p on p.id=ac.profile_id
 where lower(p.email)=lower(trim(p_email)) and ac.role='client' and ac.enabled for update of ac;
 if a.id is null then raise exception 'Activation unavailable' using errcode='42501';end if;
 select * into c from public.aco_clients where id=a.profile_id for update;
 if c.status is distinct from 'approved' or c.birth_date is distinct from p_birth_date or c.product is null or c.intensity is null or c.approved_at is null then raise exception 'Activation unavailable' using errcode='42501';end if;
 select * into claim from aco_private.direct_activations where user_id=a.id for update;
 fresh:=claim.user_id is null;
 if not fresh and claim.credential_proof is not null and claim.credential_proof<>p_proof then raise exception 'Retry with the same password' using errcode='42501';end if;
 can_write:=fresh or claim.lease_until is null or claim.lease_until<clock_timestamp();
 if fresh then
  insert into aco_private.direct_activations(user_id,request_id,credential_proof,attempt_id,lease_until) values(a.id,p_request,p_proof,p_attempt,clock_timestamp()+interval '2 minutes');
  perform public.aco_revoke_sessions(a.id);
 elsif can_write then
  update aco_private.direct_activations set credential_proof=p_proof,attempt_id=p_attempt,lease_until=clock_timestamp()+interval '2 minutes' where user_id=a.id;
 end if;
 return jsonb_build_object('userId',a.id,'requestId',coalesce(claim.request_id,p_request),'fresh',fresh,'canWrite',can_write);
end $$;
create function public.aco_release_activation_attempt(p_user uuid,p_attempt uuid)
returns void language sql security invoker set search_path='' as $$
 update aco_private.direct_activations set lease_until=null where user_id=p_user and attempt_id=p_attempt and completed_at is null
$$;
revoke all on function public.aco_registration_identity(uuid,text,text),public.aco_claim_activation_retry(text,date,uuid,text,uuid),public.aco_release_activation_attempt(uuid,uuid) from public,anon,authenticated;
grant execute on function public.aco_registration_identity(uuid,text,text),public.aco_claim_activation_retry(text,date,uuid,text,uuid),public.aco_release_activation_attempt(uuid,uuid) to service_role;
create or replace function public.aco_account_lifecycle(p_actor uuid,p_session uuid,p_request uuid,p_hash text,p_target uuid,p_mode text) returns jsonb language plpgsql security invoker set search_path='' as $$
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
 if a.role='trainer' and (exists(select 1 from public.aco_clients where lead_trainer_id=a.profile_id and archived_at is null) or exists(select 1 from public.aco_sessions where trainer_id=a.profile_id and status='scheduled') or exists(select 1 from public.aco_holds where trainer_id=a.profile_id and status='active' and expires_at>aco_private.app_now())) then raise exception 'Trainer still has clients or unsettled appointments' using errcode='23514';end if;
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
create function public.aco_state_stamp(p_actor uuid,p_session uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare role text;t timestamptz;boundary text;tag text;
begin
 role:=aco_private.relational_session(p_actor,p_session);t:=aco_private.app_now();
 select concat_ws(':',min(ends_at)::text) into boundary from public.aco_sessions where ends_at>t;
 boundary:=boundary||coalesce((select min(expires_at)::text from public.aco_holds where status='active' and expires_at>t),'');
 boundary:=boundary||coalesce((select min(expires_at)::text from public.aco_substitutions where revoked_at is null and expires_at>t),'');
 tag:=md5(pg_current_snapshot()::text||':'||p_actor::text||':'||role||':'||(t at time zone 'Europe/Warsaw')::date::text||':'||boundary);
 return jsonb_build_object('tag',tag,'now',t);
end $$;
revoke all on function public.aco_state_stamp(uuid,uuid) from public,anon,authenticated;
grant execute on function public.aco_state_stamp(uuid,uuid) to service_role;
create index if not exists aco_sessions_end_boundary on public.aco_sessions(ends_at);
create index if not exists aco_holds_expiry_boundary on public.aco_holds(expires_at) where status='active';
commit;
