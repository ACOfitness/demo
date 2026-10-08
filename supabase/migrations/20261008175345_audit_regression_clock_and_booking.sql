begin;
create or replace function public.aco_set_test_clock(p_actor uuid,p_session uuid,p_request uuid,p_hash text,p_target timestamptz) returns void language plpgsql security invoker set search_path='' as $$
declare r aco_private.command_receipts;delta bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended('aco-clock',0));
 if aco_private.relational_session(p_actor,p_session)<>'admin' then raise exception 'Admin required' using errcode='42501';end if;
 if not (select enabled from aco_private.test_clock where id) then raise exception 'Test tools disabled' using errcode='42501';end if;
 select * into r from aco_private.command_receipts where actor_id=p_actor and request_id=p_request;
 if found then if r.request_hash<>p_hash then raise exception 'Request reused';end if;return;end if;
 delta:=case when p_target is null then 0 else round(extract(epoch from p_target-clock_timestamp()))::bigint end;
 if abs(delta)>315576000 then raise exception 'Offset exceeds ten years';end if;
 -- First expire under the previous clock so backwards travel cannot revive an elapsed checkout.
 update public.aco_holds set status='expired' where status='active' and expires_at<=aco_private.app_now();
 update aco_private.test_clock set time_offset_seconds=delta,version=version+1,updated_at=clock_timestamp(),updated_by=p_actor where id;
 -- Expired reservations must not revive and collide when an administrator moves backwards.
 update public.aco_holds set status='expired' where status='active' and expires_at<=aco_private.app_now();
 -- Changing the clock does not create or edit bookings. Keep committed session claims intact.
 -- Revalidating past bookings against today's availability would prevent restoring the clock.
 delete from public.aco_calendar_claims c using public.aco_holds h where c.hold_id=h.id and h.status='expired';
 insert into aco_private.command_receipts(actor_id,request_id,request_hash,revision) values(p_actor,p_request,p_hash,floor(extract(epoch from clock_timestamp())*1000000));
 insert into aco_private.audit_log(actor_id,action,detail) values(p_actor,'testClock',jsonb_build_object('offset_seconds',delta));
end $$;
revoke all on function public.aco_set_test_clock(uuid,uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.aco_set_test_clock(uuid,uuid,uuid,text,timestamptz) to service_role;
commit;
