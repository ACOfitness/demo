begin;
-- Financial snapshots cannot be repriced by a subsequent catalog change.
create function aco_private.protect_financial_snapshot() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_table_name='aco_packages' and (new.price_grosz,new.base_price_grosz,new.count,new.product,new.intensity,new.client_id) is distinct from (old.price_grosz,old.base_price_grosz,old.count,old.product,old.intensity,old.client_id) then
 raise exception 'Purchased package snapshot is immutable' using errcode='23514';end if;
 return new;
end $$;
create trigger protect_financial_snapshot before update on public.aco_packages for each row execute function aco_private.protect_financial_snapshot();
create function aco_private.check_checkout_transition() returns trigger language plpgsql set search_path='' as $$
begin
 if new.status='paid' and old.status<>'paid' and (old.status<>'active' or old.expires_at<=clock_timestamp()) then raise exception 'Checkout expired' using errcode='23514';end if;
 if old.status='paid' and new.status<>'paid' then raise exception 'Paid checkout cannot be reopened' using errcode='23514';end if;
 return new;
end $$;
create trigger check_checkout_transition before update on public.aco_holds for each row execute function aco_private.check_checkout_transition();
-- Index every foreign-key lookup used by authorization, scheduling and settlements.
create index aco_substitution_client on public.aco_substitutions(client_id);
create index aco_session_substitution on public.aco_sessions(substitution_id) where substitution_id is not null;
create index aco_session_credit on public.aco_sessions(credit_id) where credit_id is not null;
create index aco_packages_promotion on public.aco_packages(promotion_id) where promotion_id is not null;
create index aco_packages_protection on public.aco_packages(protection_until,client_id);
create index aco_messages_sender_created on public.aco_messages(sender_id,created_at desc);
create index aco_messages_recipient_created on public.aco_messages(recipient_id,created_at desc);
revoke all on public.aco_notifications from anon,authenticated;
revoke all on function aco_private.protect_financial_snapshot(),aco_private.check_checkout_transition() from public,anon,authenticated;
grant execute on function aco_private.protect_financial_snapshot(),aco_private.check_checkout_transition() to service_role;
-- Cutover is a separate explicit transaction, run after deploying the new API.
-- It preserves the original store, refuses unknown/new data, and does not change roles.
create function aco_private.import_initial_runtime() returns jsonb language plpgsql set search_path='' as $$
declare r record; settings jsonb; rules jsonb; source_count integer; target_count integer;
begin
 lock table aco_private.runtime_entities in share row exclusive mode;
 if exists(select 1 from aco_private.runtime_entities where kind not in ('accounts','settings','audit'))
 or exists(select 1 from aco_private.runtime_entities where kind='accounts' and payload->>'role'<>'admin') then
 raise exception 'Runtime changed: full data migration required before cutover';end if;
 if exists(select 1 from public.aco_accounts) then raise exception 'Relational database already initialized';end if;
 for r in select payload p from aco_private.runtime_entities where kind='accounts' loop
 insert into public.aco_profiles(id,auth_user_id,name,email,phone,must_change_password)
 values((r.p->>'id')::uuid,(r.p->>'id')::uuid,coalesce(r.p->>'name','Administrator ACO!'),r.p->>'email',coalesce(r.p->>'phone',''),coalesce((r.p->>'mustChangePassword')::boolean,false));
 insert into public.aco_accounts(id,profile_id,role,enabled) select user_id,user_id,role,enabled from aco_private.identities where user_id=(r.p->>'id')::uuid;
 end loop;
 select payload into strict settings from aco_private.runtime_entities where kind='settings' and id='singleton';rules:=settings->'rules';
 insert into public.aco_settings values('company',(settings->>'consultation')::numeric*100,(settings->>'personal')::numeric*100,(settings->>'physio')::numeric*100,(settings->>'cancelHours')::int,
 (rules->>'cycleWeeks')::int,(rules->>'validWeeks')::int,(rules->>'renewalDays')::int,(rules->>'coachHoldHours')::int,(rules->>'checkoutMinutes')::int,(rules->>'protectionDays')::int,(rules->>'consultationDays')::int,(rules->>'startDays')::int,(rules->>'substituteHours')::int,(rules->>'freezeDays')::int,1,now());
 insert into public.aco_products(id,name,subtitle,bullets) values
 ('personal','Trening personalny','Pakiet treningów indywidualnych. Stałe godziny i wsparcie trenera.',array['60 minut tylko dla Ciebie','Stałe godziny w grafiku','Dziennik i komentarze trenera']),
 ('physio','Powrót do zdrowia','Pakiet treningów indywidualnych. Stałe godziny i wsparcie trenera.',array['60 minut tylko dla Ciebie','Stałe godziny w grafiku','Dziennik i komentarze trenera']);
 insert into public.aco_product_prices(id,product_id,intensity,amount_grosz)
 select product||':'||intensity,product,intensity,(settings->'packagePrices'->product->>intensity::text)::numeric*100 from unnest(array['personal','physio']) product cross join generate_series(1,3) intensity;
 insert into public.aco_activity(id,description,created_at) select (payload->>'id')::uuid,payload->>'text',(payload->>'at')::timestamptz from aco_private.runtime_entities where kind='audit';
 select count(*) into source_count from aco_private.runtime_entities where kind='accounts';select count(*) into target_count from public.aco_accounts;
 if source_count<>target_count then raise exception 'Account count mismatch';end if;
 return jsonb_build_object('accounts',target_count,'products',2,'prices',6,'activity',(select count(*) from public.aco_activity));
end $$;
revoke all on function aco_private.import_initial_runtime() from public,anon,authenticated,service_role;
commit;
