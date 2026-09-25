begin;
-- Private command store. No browser receives a full database snapshot or write grant.
-- Each entity is independent; the revision coordinates cross-entity booking invariants.
create table aco_private.runtime_revision (
 singleton boolean primary key default true check(singleton),
 revision bigint not null default 0 check(revision>=0)
);
insert into aco_private.runtime_revision(singleton) values(true);
create table aco_private.runtime_entities (
 kind text not null check(kind in ('accounts','clients','trainers','sessions','packages','holds','messages','sales','substitutions','audit','blocks','letters','promotions','extraHours','settings','productCopies','noticeReads')),
 id text not null check(length(id) between 1 and 150),
 payload jsonb not null check(jsonb_typeof(payload)='object'),
 updated_at timestamptz not null default now(),
 primary key(kind,id)
);
create table aco_private.command_receipts (
 actor_id uuid not null references auth.users(id),
 request_id uuid not null,
 request_hash text not null check(length(request_hash)=64),
 revision bigint not null,
 created_at timestamptz not null default now(),
 primary key(actor_id,request_id)
);
alter table aco_private.runtime_revision enable row level security;
alter table aco_private.runtime_entities enable row level security;
alter table aco_private.command_receipts enable row level security;
revoke all on aco_private.runtime_revision,aco_private.runtime_entities,aco_private.command_receipts from public,anon,authenticated;
grant select,insert,update,delete on aco_private.runtime_revision,aco_private.runtime_entities,aco_private.command_receipts to service_role;

-- The service key is held only inside the Edge Function. The supplied session is
-- independently checked against Auth so revoked/deleted sessions cannot keep writing.
create function aco_private.check_runtime_session(p_actor uuid,p_session uuid)
returns text language plpgsql security invoker set search_path='' as $$
declare v_role text;
begin
 if not exists(select 1 from auth.sessions where id=p_session and user_id=p_actor and (not_after is null or not_after>now())) then
  raise exception 'Session revoked' using errcode='42501';
 end if;
 select role into v_role from aco_private.identities where user_id=p_actor and enabled;
 if v_role is null then raise exception 'Account disabled' using errcode='42501'; end if;
 return v_role;
end $$;
revoke all on function aco_private.check_runtime_session(uuid,uuid) from public,anon,authenticated;
grant execute on function aco_private.check_runtime_session(uuid,uuid) to service_role;

grant usage on schema auth to service_role;
grant select,delete on auth.sessions to service_role;

create function public.aco_runtime_load(p_actor uuid,p_session uuid,p_request uuid default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_role text; v_result jsonb;
begin
 v_role:=aco_private.check_runtime_session(p_actor,p_session);
 -- One SQL snapshot includes revision and all entity rows.
 select jsonb_build_object('revision',r.revision,'now',clock_timestamp(),'role',v_role,
  'receipt',(select jsonb_build_object('hash',request_hash,'revision',revision) from aco_private.command_receipts where actor_id=p_actor and request_id=p_request),
  'entities',coalesce((select jsonb_agg(jsonb_build_object('kind',e.kind,'id',e.id,'payload',e.payload)) from aco_private.runtime_entities e),'[]'::jsonb))
 into v_result from aco_private.runtime_revision r where singleton;
 return v_result;
end $$;
revoke all on function public.aco_runtime_load(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.aco_runtime_load(uuid,uuid,uuid) to service_role;

create function public.aco_runtime_commit(p_actor uuid,p_session uuid,p_revision bigint,p_request uuid,p_hash text,p_changes jsonb,p_removed jsonb,p_action text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_revision bigint; v_receipt aco_private.command_receipts; v_item jsonb;
begin
 if p_action='register' then
  if p_session is not null or exists(select 1 from aco_private.identities where user_id=p_actor) or not exists(select 1 from auth.users where id=p_actor) then raise exception 'Invalid registration identity' using errcode='42501'; end if;
 else
  perform aco_private.check_runtime_session(p_actor,p_session);
 end if;
 if jsonb_typeof(p_changes)<>'array' or jsonb_typeof(p_removed)<>'array' or jsonb_array_length(p_changes)>10000 or length(p_action)>100 or p_hash!~'^[a-f0-9]{64}$' then
  raise exception 'Invalid command envelope' using errcode='22023';
 end if;
 select revision into v_revision from aco_private.runtime_revision where singleton for update;
 select * into v_receipt from aco_private.command_receipts where actor_id=p_actor and request_id=p_request;
 if found then
  if v_receipt.request_hash<>p_hash then raise exception 'Request id reused for different command' using errcode='22023'; end if;
  return jsonb_build_object('revision',v_receipt.revision,'replayed',true);
 end if;
 if v_revision<>p_revision then raise exception 'Concurrent change; reload and retry' using errcode='40001'; end if;
 for v_item in select value from jsonb_array_elements(p_changes) loop
  if v_item->>'kind'='accounts' and ((v_item->'payload') ? 'password' or (v_item->'payload') ? 'token') then
   raise exception 'Credentials must remain in Auth' using errcode='22023';
  end if;
  if v_item->>'kind'='accounts' then
   if p_action='register' and (v_item->>'id'<>p_actor::text or v_item->'payload'->>'role'<>'client') then raise exception 'Invalid registration role' using errcode='42501'; end if;
   insert into aco_private.identities(user_id,role,enabled) values((v_item->>'id')::uuid,v_item->'payload'->>'role',not coalesce((v_item->'payload'->>'disabled')::boolean,false))
   on conflict(user_id) do update set enabled=excluded.enabled;
  end if;
  insert into aco_private.runtime_entities(kind,id,payload) values(v_item->>'kind',v_item->>'id',v_item->'payload')
  on conflict(kind,id) do update set payload=excluded.payload,updated_at=clock_timestamp();
 end loop;
 for v_item in select value from jsonb_array_elements(p_removed) loop
  -- Domain entities and history are never hard-deleted by normal commands.
  if v_item->>'kind' not in ('blocks') then raise exception 'Unsupported deletion' using errcode='22023'; end if;
  delete from aco_private.runtime_entities where kind=v_item->>'kind' and id=v_item->>'id';
 end loop;
 update aco_private.runtime_revision set revision=revision+1 where singleton returning revision into v_revision;
 insert into aco_private.command_receipts(actor_id,request_id,request_hash,revision) values(p_actor,p_request,p_hash,v_revision);
 insert into aco_private.audit_log(actor_id,action,detail) values(p_actor,p_action,jsonb_build_object('request_id',p_request,'revision',v_revision));
 return jsonb_build_object('revision',v_revision,'replayed',false);
end $$;
revoke all on function public.aco_runtime_commit(uuid,uuid,bigint,uuid,text,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.aco_runtime_commit(uuid,uuid,bigint,uuid,text,jsonb,jsonb,text) to service_role;

create function public.aco_runtime_system_load()
returns jsonb language sql security invoker set search_path='' as $$
 select jsonb_build_object('revision',r.revision,'now',clock_timestamp(),'role','system',
 'entities',coalesce((select jsonb_agg(jsonb_build_object('kind',e.kind,'id',e.id,'payload',e.payload)) from aco_private.runtime_entities e),'[]'::jsonb))
 from aco_private.runtime_revision r where singleton
$$;
revoke all on function public.aco_runtime_system_load() from public,anon,authenticated;
grant execute on function public.aco_runtime_system_load() to service_role;
create table aco_private.request_limits (
 key_hash text primary key check(length(key_hash)=64), started_at timestamptz not null, hits integer not null
);
alter table aco_private.request_limits enable row level security;
revoke all on aco_private.request_limits from public,anon,authenticated;
grant select,insert,update,delete on aco_private.request_limits to service_role;
create function public.aco_rate_limit(p_key text,p_max integer,p_seconds integer)
returns boolean language plpgsql security invoker set search_path='' as $$
declare v_hits integer;
begin
 if p_max<1 or p_seconds<1 then return false; end if;
 insert into aco_private.request_limits(key_hash,started_at,hits) values(p_key,now(),1)
 on conflict(key_hash) do update set
  hits=case when aco_private.request_limits.started_at<now()-make_interval(secs=>p_seconds) then 1 else aco_private.request_limits.hits+1 end,
  started_at=case when aco_private.request_limits.started_at<now()-make_interval(secs=>p_seconds) then now() else aco_private.request_limits.started_at end
 returning hits into v_hits;
 return v_hits<=p_max;
end $$;
revoke all on function public.aco_rate_limit(text,integer,integer) from public,anon,authenticated;
grant execute on function public.aco_rate_limit(text,integer,integer) to service_role;
create function public.aco_revoke_sessions(p_target uuid)
returns void language sql security invoker set search_path='' as $$ delete from auth.sessions where user_id=p_target $$;
revoke all on function public.aco_revoke_sessions(uuid) from public,anon,authenticated;
grant execute on function public.aco_revoke_sessions(uuid) to service_role;
commit;
