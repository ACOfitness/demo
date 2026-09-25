import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
const db=new PGlite();
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
await db.exec(await readFile(new URL('../../supabase/migrations/20260925094836_aco_access_foundation.sql',import.meta.url),'utf8'));
for(let n=1;n<=7;n++){
 await db.query('insert into auth.users values ($1)',[id(n)]);
 await db.query('insert into aco_private.identities(user_id,role,enabled) values($1,$2,true)',[id(n),n===1?'admin':n<=4?'trainer':'client']);
 await db.query('insert into public.aco_profiles(id,name,email) values($1,$2,$3)',[id(n),`Fixture ${n}`,`fixture${n}@example.test`]);
}
for(let n=2;n<=4;n++)await db.query("insert into public.aco_trainers(id,products) values($1,array['personal'])",[id(n)]);
for(let n=5;n<=7;n++)await db.query("insert into public.aco_clients(id,lead_trainer_id,birth_date,status,product,intensity,approved_at) values($1,$2,'1990-01-01','active','personal',1,now())",[id(n),n===6?id(3):id(2)]);
await db.query("insert into public.aco_sessions(id,client_id,trainer_id,kind,starts_at,ends_at,status) values($1,$2,$3,'consultation',now()-interval '3 days',now()-interval '3 days'+interval '90 minutes','completed')",[id(10),id(5),id(2)]);
await db.query("insert into public.aco_public_notes(session_id,body,updated_by) values($1,'public note',$2)",[id(10),id(2)]);
await db.query("insert into public.aco_trainer_notes(session_id,body,updated_by) values($1,'secret trainer note',$2)",[id(10),id(2)]);
await db.query("insert into public.aco_messages(sender_id,recipient_id,subject,body) values($1,$2,'Subject','private correspondence')",[id(5),id(2)]);
await db.query("insert into public.aco_trainer_payroll(trainer_id,pesel) values($1,'12345678901')",[id(2)]);
const asUser=async(n,fn)=>{await db.exec('begin;set local role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,true)",[id(n)]);try{return await fn()}finally{await db.exec('rollback')}};
const count=async(table)=>Number((await db.query(`select count(*) n from public.${table}`)).rows[0].n);
test('Client cannot read another client or trainer-only notes and payroll',async()=>asUser(5,async()=>{assert.equal(await count('aco_clients'),1);assert.equal(await count('aco_public_notes'),1);assert.equal(await count('aco_trainer_notes'),0);assert.equal(await count('aco_trainer_payroll'),0)}));
test('Trainer reads only assigned clients; unrelated trainer has no session access',async()=>{await asUser(2,async()=>{assert.equal(await count('aco_clients'),2);assert.equal(await count('aco_trainer_notes'),1)});await asUser(3,async()=>{assert.equal(await count('aco_clients'),1);assert.equal(await count('aco_sessions'),0);assert.equal(await count('aco_trainer_notes'),0)})});
test('Admin sees operational data but not private messages of others',async()=>asUser(1,async()=>{assert.equal(await count('aco_clients'),3);assert.equal(await count('aco_trainer_notes'),1);assert.equal(await count('aco_messages'),0)}));
test('Messages remain private even after lead-trainer transfer',async()=>{await db.query('update public.aco_clients set lead_trainer_id=$1 where id=$2',[id(3),id(5)]);await asUser(2,async()=>{assert.equal(await count('aco_sessions'),1);assert.equal(await count('aco_messages'),1)});await asUser(3,async()=>{assert.equal(await count('aco_messages'),0)});await db.query('update public.aco_clients set lead_trainer_id=$1 where id=$2',[id(2),id(5)])});
test('Substitution expires at the database clock without waiting for JWT refresh',async()=>{await db.query("insert into public.aco_substitutions(id,client_id,trainer_id,starts_at,expires_at) values($1,$2,$3,now()-interval '1 hour',now()+interval '1 hour')",[id(20),id(5),id(4)]);await asUser(4,async()=>assert.equal(await count('aco_trainer_notes'),1));await db.query("update public.aco_substitutions set starts_at=now()-interval '3 hours',expires_at=now()-interval '1 hour' where id=$1",[id(20)]);await asUser(4,async()=>assert.equal(await count('aco_trainer_notes'),0))});
test('Disabled identities lose access despite a previously issued JWT',async()=>{await db.query('update aco_private.identities set enabled=false where user_id=$1',[id(5)]);await asUser(5,async()=>{assert.equal(await count('aco_clients'),0);assert.equal(await count('aco_messages'),0);assert.equal(await count('aco_profiles'),0)});await db.query('update aco_private.identities set enabled=true where user_id=$1',[id(5)])});
test('Forged metadata does not grant admin rights',async()=>asUser(5,async()=>{await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:id(5),user_metadata:{role:'admin'},app_metadata:{role:'admin'}})]);assert.equal(await count('aco_trainer_payroll'),0);assert.equal(await count('aco_clients'),1)}));
test('Direct updates and role escalation are denied to browser clients',async()=>{await assert.rejects(()=>asUser(5,()=>db.query("update public.aco_clients set lead_trainer_id=$1 where id=$2",[id(4),id(5)])),/permission denied/);await assert.rejects(()=>asUser(5,()=>db.query("update aco_private.identities set role='admin' where user_id=$1",[id(5)])),/permission denied/)});
test('Unauthenticated requests have no access',async()=>{await db.exec('begin;set local role anon');try{await assert.rejects(()=>count('aco_clients'),/permission denied/)}finally{await db.exec('rollback')}});
test('SQL injection string remains a value in a parameterized query',async()=>asUser(5,async()=>{assert.equal((await db.query('select * from public.aco_profiles where email=$1',["x' OR true; --"])).rows.length,0);assert.equal(await count('aco_clients'),1)}));
test('Every application table has RLS enabled',async()=>{const result=await db.query("select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','aco_private') and c.relkind='r' and not c.relrowsecurity");assert.deepEqual(result.rows,[])});

after(()=>db.close());
