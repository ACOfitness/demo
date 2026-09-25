begin;
-- One irreversible credential-writing claim per account. Never store a password here.
create table aco_private.direct_activations (
 user_id uuid primary key references public.aco_accounts(id),
 request_id uuid not null unique,
 created_at timestamptz not null default now(),
 completed_at timestamptz
);
alter table aco_private.direct_activations enable row level security;
revoke all on aco_private.direct_activations from public,anon,authenticated;
grant select,insert,update on aco_private.direct_activations to service_role;
create function public.aco_claim_activation(p_email text,p_birth_date date,p_request uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare a public.aco_accounts; c public.aco_clients; claim aco_private.direct_activations;
begin
 select ac.* into a from public.aco_accounts ac join public.aco_profiles p on p.id=ac.profile_id
 where lower(p.email)=lower(trim(p_email)) and ac.role='client' and ac.enabled for update of ac;
 if a.id is null then raise exception 'Activation unavailable' using errcode='42501';end if;
 select * into c from public.aco_clients where id=a.profile_id for update;
 if c.status is distinct from 'approved' or c.birth_date is distinct from p_birth_date or c.product is null or c.intensity is null or c.approved_at is null then
 raise exception 'Activation unavailable' using errcode='42501';end if;
 select * into claim from aco_private.direct_activations where user_id=a.id;
 if claim.user_id is not null then
  return jsonb_build_object('userId',a.id,'requestId',claim.request_id,'fresh',false);
 end if;
 insert into aco_private.direct_activations(user_id,request_id) values(a.id,p_request);
 perform public.aco_revoke_sessions(a.id);
 return jsonb_build_object('userId',a.id,'requestId',p_request,'fresh',true);
end $$;
create function public.aco_complete_activation(p_user uuid,p_request uuid)
returns boolean language plpgsql security invoker set search_path='' as $$
declare a public.aco_accounts; c public.aco_clients; claim aco_private.direct_activations;
begin
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
 insert into public.aco_events(id,client_id,title,body,audience,created_at) values(gen_random_uuid(),c.id,'Witamy w ACO!','Twoje konto jest aktywne. Możesz wybrać terminy treningów.','client',now());
 insert into public.aco_activity(id,actor_id,description,created_at) values(gen_random_uuid(),c.id,'Aktywacja konta klienta bez linku e-mail.',now());
 return true;
end $$;
revoke all on function public.aco_claim_activation(text,date,uuid),public.aco_complete_activation(uuid,uuid) from public,anon,authenticated;
grant execute on function public.aco_claim_activation(text,date,uuid),public.aco_complete_activation(uuid,uuid) to service_role;
commit;
