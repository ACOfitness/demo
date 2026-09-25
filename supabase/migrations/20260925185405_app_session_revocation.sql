begin;
-- Supabase's postgres role cannot delegate DELETE on managed auth.sessions.
-- Retain those rows and deny their immutable session IDs at every ACO API gate.
create table aco_private.revoked_sessions (
 session_id uuid primary key,
 user_id uuid not null,
 revoked_at timestamptz not null default now()
);
alter table aco_private.revoked_sessions enable row level security;
revoke all on aco_private.revoked_sessions from public,anon,authenticated;
grant select,insert on aco_private.revoked_sessions to service_role;
create or replace function public.aco_revoke_sessions(p_target uuid)
returns void language sql security invoker set search_path='' as $$
 insert into aco_private.revoked_sessions(session_id,user_id)
 select id,user_id from auth.sessions where user_id=p_target
 on conflict(session_id) do nothing
$$;
create or replace function aco_private.relational_session(p_actor uuid,p_session uuid)
returns text language plpgsql security invoker set search_path='' as $$
declare result text;
begin
 if not exists(select 1 from auth.sessions s where s.id=p_session and s.user_id=p_actor
 and (s.not_after is null or s.not_after>now())
 and not exists(select 1 from aco_private.revoked_sessions r where r.session_id=s.id)) then
 raise exception 'Session revoked' using errcode='42501';end if;
 select role into result from public.aco_accounts where id=p_actor and enabled;
 if result is null then raise exception 'Account disabled' using errcode='42501';end if;
 return result;
end $$;
create or replace function aco_private.check_runtime_session(p_actor uuid,p_session uuid)
returns text language plpgsql security invoker set search_path='' as $$
declare v_role text;
begin
 if not exists(select 1 from auth.sessions s where s.id=p_session and s.user_id=p_actor
 and (s.not_after is null or s.not_after>now())
 and not exists(select 1 from aco_private.revoked_sessions r where r.session_id=s.id)) then
 raise exception 'Session revoked' using errcode='42501';end if;
 select role into v_role from aco_private.identities where user_id=p_actor and enabled;
 if v_role is null then raise exception 'Account disabled' using errcode='42501';end if;
 return v_role;
end $$;
revoke all on function public.aco_revoke_sessions(uuid),aco_private.relational_session(uuid,uuid),aco_private.check_runtime_session(uuid,uuid) from public,anon,authenticated;
grant execute on function public.aco_revoke_sessions(uuid),aco_private.relational_session(uuid,uuid),aco_private.check_runtime_session(uuid,uuid) to service_role;
commit;
