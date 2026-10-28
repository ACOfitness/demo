-- Business version conflicts must not trigger PostgREST 14 transaction retries.
-- Preserve existing function ownership, signatures, privileges and authorization.
begin;
do $migration$
declare f record; definition text;
begin
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('aco_relational_commit','aco_runtime_commit')
  and p.prosrc like '%40001%'
 loop
  definition:=pg_get_functiondef(f.oid);
  definition:=replace(definition,'''40001''','''PT409''');
  execute definition;
 end loop;
end $migration$;
commit;
