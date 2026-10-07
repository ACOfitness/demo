import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../../server/handler';
import {encodeRelational} from '../../server/relational-store';
import {initialDatabase} from '../../src/auth';
import {dateOf,dayAdd,dayIndex} from '../../src/domain';
const pg=new PGlite();after(()=>pg.close());
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
await pg.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,raw_app_meta_data jsonb default '{}');create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
for(const name of (await readdir(new URL('../../supabase/migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await pg.exec(await readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8'));
// Match hosted Supabase: backend can inspect Auth sessions, never delete them.
await pg.exec('revoke delete on auth.sessions from service_role');
const sessionIds=new Map<number,string>();
const source=await initialDatabase();source.accounts=[{id:id(1),email:'one@example.test',role:'client',clientId:id(1)},{id:id(2),email:'two@example.test',role:'client',clientId:id(2)},{id:id(3),email:'trainer@example.test',role:'trainer',trainerId:id(3)},{id:id(4),email:'admin@example.test',role:'admin'}];
source.trainers=[{id:id(3),name:'Trainer',rate:50,days:[0,1,2,3,4,5,6],hours:[10,11,12],products:['personal'],pesel:'12345678901'}];
source.clients=source.accounts.slice(0,2).map(a=>({id:a.id,email:a.email,name:a.id,phone:'123',birthDate:'1990-01-01',trainerId:id(3),service:'personal',intensity:1,active:true,invited:true,prescribed:true,answers:['PRIVATE HEALTH']}));
for(const account of source.accounts){await pg.query('insert into auth.users(id) values($1)',[account.id]);await pg.query('insert into auth.sessions values($1,$2,null)',[id(Number(account.id.slice(-2))+100),account.id]);await pg.query('insert into aco_private.identities(user_id,role,enabled) values($1,$2,true)',[account.id,account.role])}
const order=(await pg.query<{tables:string[]}>('select aco_private.relational_tables() tables')).rows[0].tables;
for(const row of encodeRelational(source).sort((a,b)=>order.indexOf(a.table)-order.indexOf(b.table)))await pg.query('select aco_private.write_relational_row($1,$2,$3)',[row.table,row.key,row.data]);
await pg.exec('set role service_role');
const known=new Set(['aco_state_stamp','aco_registration_identity','aco_claim_activation_retry','aco_release_activation_attempt','aco_cancel_email_change','aco_registration_receipt','aco_begin_email_change','aco_finish_email_change','aco_set_test_clock','aco_account_lifecycle','aco_relational_load','aco_relational_commit','aco_relational_public_load','aco_rate_limit','aco_revoke_sessions','aco_claim_activation','aco_complete_activation']);
let failRegistrationCommit=false;let created=500,recoveries=0,passwordWrites=0,failCompletion=false,failEmailFinish=false,rejectEmail=false;const authEmails=new Map(source.accounts.map(a=>[a.id,a.email]));const passwords=new Map<string,string>();
const fetcher:typeof fetch=async(input,init)=>{
 const url=new URL(String(input));
 if(url.pathname==='/auth/v1/user'&&init?.method!=='PUT'){
  const header=(init?.headers as Record<string,string>).Authorization;
  const claims=JSON.parse(Buffer.from(header.slice(7).split('.')[1],'base64url').toString());
  return Response.json({id:claims.sub});
 }
 if(url.pathname==='/auth/v1/admin/users'&&init?.method==='POST'){
  const newId=id(created++),body=JSON.parse(String(init.body));await pg.exec('reset role');await pg.query('insert into auth.users(id,email,raw_app_meta_data) values($1,$2,$3)',[newId,body.email,JSON.stringify(body.app_metadata||{})]);await pg.exec('set role service_role');return Response.json({id:newId});
 }
 if(url.pathname==='/auth/v1/recover'){recoveries++;return Response.json({})}
 if(url.pathname.startsWith('/auth/v1/admin/users/')&&init?.method==='PUT'){
  const body=JSON.parse(String(init.body));if(body.email){if(rejectEmail)return Response.json({error:'Email exists'},{status:422});authEmails.set(url.pathname.split('/').at(-1)!,body.email)}if(body.password){passwordWrites++;passwords.set(url.pathname.split('/').at(-1)!,body.password)}return Response.json({});
 }
 if(url.pathname==='/auth/v1/token'){
  const body=JSON.parse(String(init?.body));const account=(await pg.query<any>('select a.id from public.aco_accounts a join public.aco_profiles p on p.id=a.profile_id where p.email=$1',[body.email])).rows[0];
  return account&&passwords.get(account.id)===body.password?Response.json({user:{id:account.id}}):Response.json({error:'invalid password'},{status:400});
 }
 if(url.pathname.startsWith('/auth/v1/admin/users/')&&init?.method==='GET')return Response.json({email:authEmails.get(url.pathname.split('/').at(-1)!)});
 if(''===url.pathname||url.pathname==='/auth/v1/user'&&init?.method==='PUT'||url.pathname.startsWith('/auth/v1/admin/users/'))return Response.json({});
 const name=url.pathname.split('/').at(-1)!;assert.ok(known.has(name));if(name==='aco_relational_commit'&&failRegistrationCommit){failRegistrationCommit=false;throw new TypeError('Simulated database interruption')}if(name==='aco_complete_activation'&&failCompletion){failCompletion=false;throw new TypeError('Test network failure')}
 if(name==='aco_finish_email_change'&&failEmailFinish){failEmailFinish=false;throw new TypeError('Test interrupted completion')}
 const values=JSON.parse(String(init?.body)),keys=Object.keys(values);assert.ok(keys.every(k=>/^p_[a-z_]+$/.test(k)));
 try{const result=await pg.query<{value:unknown}>(`select public.${name}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) value`,Object.entries(values).map(([k,v])=>['p_clients','p_trainers'].includes(k)?v:v&&typeof v==='object'?JSON.stringify(v):v));return name==='aco_set_test_clock'?new Response(null,{status:204}):Response.json(result.rows[0].value)}catch(error){return Response.json({code:(error as {code:string}).code,message:(error as Error).message},{status:400})}
};
const handle=createHandler({url:'https://project.supabase.co',serviceKey:'server-secret',origins:['https://acofitness.github.io']},fetcher);
const request=(account:number,body:unknown)=>new Request('https://project.supabase.co/functions/v1/aco-api',{method:'POST',headers:{Origin:'https://acofitness.github.io',Authorization:'Bearer header.'+Buffer.from(JSON.stringify({sub:id(account),session_id:sessionIds.get(account)||id(account+100)})).toString('base64url')+'.signature'},body:JSON.stringify(body)});
let successBody:any,successActor:number;
test('two clients cannot reserve the same package slots concurrently',async()=>{
 const start=dayAdd(dateOf(new Date()),1),slots=[{day:dayIndex(start),hour:10}],dates=[0,1,2,3].map(w=>({date:dayAdd(start,w*7),hour:10}));
 const bodies=[1,2].map(n=>({action:'command',requestId:id(n+200),command:{type:'hold',clientId:id(n),start,slots,dates}}));
 const results=await Promise.all(bodies.map((body,i)=>handle(request(i+1,body))));
 assert.deepEqual(results.map(r=>r.status).sort(),[200,422]);
 const winner=results.findIndex(r=>r.status===200);successBody=bodies[winner];successActor=winner+1;
 const view=await results[winner].json();assert.equal(view.db.holds.length,1);assert.equal(view.db.clients.length,1);assert.ok(!JSON.stringify(view).includes('12345678901'));
});
test('recurring hold ownership is anonymous in client state and enforced under database locks',async()=>{
 const loser=successActor===1?2:1;
 const response=await handle(request(loser,{action:'state'}));assert.equal(response.status,200);
 const view=await response.json();assert.equal(view.db.recurringBusy.length,1);assert.deepEqual(Object.keys(view.db.recurringBusy[0]).sort(),['day','hour','trainerId']);
 const existing=(await pg.query<any>("select to_jsonb(h) data from public.aco_holds h where status='active' limit 1")).rows[0].data;
 delete existing.row_version;delete existing.updated_at;
 const slot=(await pg.query<any>('select weekday,hour from public.aco_hold_slots where hold_id=$1',[existing.id])).rows[0];
 await pg.exec('begin');try{
  await pg.query('select aco_private.write_relational_row($1,$2,$3)',['aco_holds',id(290),{...existing,id:id(290),client_id:id(loser)}]);
  await pg.query('select aco_private.write_relational_row($1,$2,$3)',['aco_hold_slots',id(290)+':pattern',{id:id(290)+':pattern',hold_id:id(290),weekday:slot.weekday,hour:slot.hour}]);
  await assert.rejects(pg.query('select aco_private.rebuild_calendar($1,$2)',[[id(loser)],[id(3)]]),/Recurring time is protected/);
 }finally{await pg.exec('rollback')}
});
test('retry after lost response does not allocate additional sessions or holds',async()=>{
 const response=await handle(request(successActor,successBody));assert.equal(response.status,200);assert.equal((await response.json()).replayed,true);
 const rows=await pg.query<{n:number}>("select count(*)::int n from public.aco_holds");assert.equal(rows.rows[0].n,1);
});
test('public availability does not expose accounts or client information',async()=>{
 const response=await handle(new Request('https://project.supabase.co/functions/v1/aco-api',{method:'POST',headers:{Origin:'https://acofitness.github.io'},body:JSON.stringify({action:'publicState'})}));
 assert.equal(response.status,200);const result=await response.json();assert.deepEqual(result.db.clients,[]);assert.deepEqual(result.db.accounts,[]);assert.ok(!JSON.stringify(result).includes('PRIVATE HEALTH'));assert.ok(result.db.blocks.length>=1);
});

let registeredClient='';
test('registration stores a pending client without a fabricated paid sale',async()=>{
 failRegistrationCommit=true;
 const failed=await handle(new Request('https://project.supabase.co/functions/v1/aco-api',{method:'POST',headers:{Origin:'https://acofitness.github.io'},body:JSON.stringify({action:'register',requestId:id(800),command:{type:'register',name:'New client',email:'new@example.test',phone:'123',birthDate:'1990-01-01',trainerId:id(3),date:dayAdd(dateOf(new Date()),1),hour:11,answers:['Test']}})}));
 assert.notEqual(failed.status,200);assert.equal(created,501);
 const response=await handle(new Request('https://project.supabase.co/functions/v1/aco-api',{method:'POST',headers:{Origin:'https://acofitness.github.io'},body:JSON.stringify({action:'register',requestId:id(800),command:{type:'register',name:'New client',email:'new@example.test',phone:'123',birthDate:'1990-01-01',trainerId:id(3),date:dayAdd(dateOf(new Date()),1),hour:11,answers:['Test']}})}));
 assert.equal(created,501);
 assert.equal(response.status,200,JSON.stringify(await response.json()));
 const account=(await pg.query<any>('select * from public.aco_accounts where id=$1',[id(500)])).rows[0];registeredClient=account.profile_id;assert.equal(account.role,'client');assert.equal(account.password,undefined);
 assert.equal((await pg.query<{n:number}>("select count(*)::int n from public.aco_sales")).rows[0].n,0);
 await pg.exec('reset role');await pg.query('insert into auth.sessions values($1,$2,null)',[id(600),id(500)]);await pg.exec('set role service_role');
 const denied=await handle(request(500,{action:'state'}));assert.equal(denied.status,403);
});
test('registration never returns a false success for an existing email or email limit; same request safely replays',async()=>{
 const command={type:'register',name:'New client',email:'new@example.test',phone:'123',birthDate:'1990-01-01',trainerId:id(3),date:dayAdd(dateOf(new Date()),1),hour:11,answers:['Test']};
 const call=(requestId:string,cmd=command)=>handle(new Request('https://project.supabase.co/functions/v1/aco-api',{method:'POST',headers:{Origin:'https://acofitness.github.io'},body:JSON.stringify({action:'register',requestId,command:cmd})}));
 assert.equal((await call(id(800))).status,200);
 const duplicate=await call(crypto.randomUUID(),{...command,date:dayAdd(dateOf(new Date()),2)});assert.equal(duplicate.status,422);const rejected=await duplicate.json();assert.equal(rejected.ok,undefined);assert.match(rejected.error,/Nie zapisano nowej konsultacji/);
 await pg.query('delete from aco_private.request_limits');
 const email='limited@example.test',key=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('register-email:'+email))).toString('hex');
 for(let i=0;i<12;i++)await pg.query('select public.aco_rate_limit($1,12,3600)',[key]);
 const limited=await call(crypto.randomUUID(),{...command,email});assert.equal(limited.status,422);assert.match((await limited.json()).error,/Nie zapisano konsultacji/);
 assert.equal((await pg.query<any>("select count(*)::int n from public.aco_sessions where client_id=$1",[registeredClient])).rows[0].n,1);
 await pg.query('delete from aco_private.request_limits');
});
test('trainer cannot approve early, then approves consultation using server time',async()=>{
 const command={type:'activate',id:registeredClient,service:'personal',intensity:1};
 assert.equal((await handle(request(3,{action:'command',requestId:id(801),command}))).status,422);
 await pg.query("update public.aco_sessions set starts_at=($1::date+time '11:00') at time zone 'Europe/Warsaw',ends_at=($1::date+time '12:30') at time zone 'Europe/Warsaw' where client_id=$2",[dayAdd(dateOf(new Date()),-1),registeredClient]);
 assert.equal((await handle(request(3,{action:'command',requestId:id(802),command}))).status,200);
});
test('direct activation verifies approval, never emails and cannot overwrite credentials on retry',async()=>{
 const call=(birthDate:string,password?:string)=>handle(new Request('https://project.supabase.co/functions/v1/aco-api',{method:'POST',headers:{Origin:'https://acofitness.github.io'},body:JSON.stringify({action:'activation',email:'new@example.test',birthDate,...(password?{password,requestId:crypto.randomUUID()}:{})})}));
 assert.equal((await call('1980-01-01')).status,422);assert.equal(recoveries,0);
 assert.equal((await call('1990-01-01')).status,200);assert.equal(recoveries,0);
 assert.equal((await handle(request(500,{action:'state'}))).status,403);
 failCompletion=true;
 assert.equal((await call('1990-01-01','A-new-password-123!')).status,422);
 assert.equal(passwordWrites,1);
 assert.equal((await call('1990-01-01','Another-password-456!')).status,403);assert.equal(passwordWrites,1);
 const activated=await call('1990-01-01','A-new-password-123!');assert.equal(activated.status,200,JSON.stringify(await activated.json()));assert.equal(passwordWrites,1);
 await pg.exec('reset role');await pg.query('insert into auth.sessions values($1,$2,null)',[id(1600),id(500)]);await pg.exec('set role service_role');sessionIds.set(500,id(1600));
 const state=await handle(request(500,{action:'state'}));assert.equal(state.status,200);const data=await state.json();assert.equal(data.db.clients[0].active,true);assert.deepEqual(data.db.messages.map((m:any)=>m.title),['Witamy w ACO!']);
 await pg.query('delete from aco_private.request_limits');
 assert.equal((await call('1990-01-01','Overwrite-password-789!')).status,422);assert.equal(passwordWrites,1);
 assert.equal((await handle(request(500,{action:'finishActivation',requestId:id(803),password:'Not-allowed-123!'}))).status,400);
});
test('activation claims serialize concurrent requests and are not callable by browser roles',async()=>{
 await pg.query("update public.aco_clients set status='approved' where id=$1",[id(1)]);
 const claim=()=>pg.query<any>('select public.aco_claim_activation($1,$2,$3) result',['one@example.test','1990-01-01',crypto.randomUUID()]);
 const result=await Promise.all([claim(),claim()]);assert.equal(result.filter(r=>r.rows[0].result.fresh).length,1);assert.equal(result[0].rows[0].result.requestId,result[1].rows[0].result.requestId);
 const proof='a'.repeat(64),attempt=crypto.randomUUID();const retry=(value=proof,attemptId=attempt)=>pg.query<any>('select public.aco_claim_activation_retry($1,$2,$3,$4,$5) result',['one@example.test','1990-01-01',crypto.randomUUID(),value,attemptId]);
 const lease=(await retry()).rows[0].result;assert.equal(lease.canWrite,true);assert.equal((await retry()).rows[0].result.canWrite,false);await assert.rejects(retry('b'.repeat(64)),/same password/);
 await pg.query('select public.aco_release_activation_attempt($1,$2)',[id(1),crypto.randomUUID()]);assert.equal((await retry()).rows[0].result.canWrite,false);
 await pg.query('select public.aco_release_activation_attempt($1,$2)',[id(1),attempt]);assert.equal((await retry()).rows[0].result.canWrite,true);
 for(const role of ['anon','authenticated']){await pg.exec('reset role;set role '+role);await assert.rejects(retry(),/permission denied/);await assert.rejects(pg.query('select public.aco_registration_identity($1,$2,$3)',[crypto.randomUUID(),'x','one@example.test']),/permission denied/);await assert.rejects(claim(),/permission denied/);await assert.rejects(pg.query('select * from aco_private.direct_activations'),/permission denied/)}
 await pg.exec('reset role;set role service_role');await pg.query("update public.aco_clients set status='active' where id=$1",[id(1)]);await pg.exec('reset role');await pg.query('insert into auth.sessions values($1,$2,null)',[id(1101),id(1)]);await pg.exec('set role service_role');sessionIds.set(1,id(1101));
});
test('administrator password reset revokes already-issued sessions',async()=>{
 const result=await handle(request(4,{action:'resetPassword',requestId:id(804),accountId:id(3)}));assert.equal(result.status,200,JSON.stringify(await result.clone().json()));const body=await result.json();assert.ok(body.temporary.length>=20);
 assert.equal((await handle(request(3,{action:'state'}))).status,403);
 const replay=await handle(request(4,{action:'resetPassword',requestId:id(804),accountId:id(3)}));assert.equal(replay.status,200);assert.equal((await replay.json()).temporary,body.temporary);
});
test('locations are typed, admin-only, persisted and inaccessible through direct browser roles',async()=>{
 const location=id(950);const cmd={type:'saveLocation',id:location,name:'Studio testowe',address:'Testowa 12'};
 const denied=await handle(request(1,{action:'command',requestId:id(951),command:cmd}));assert.equal(denied.status,422);
 const saved=await handle(request(4,{action:'command',requestId:id(952),command:cmd}));assert.equal(saved.status,200);assert.ok((await saved.json()).db.locations.some((l:any)=>l.id===location&&l.address==='Testowa 12'));
 assert.equal((await pg.query<any>('select name from public.aco_locations where id=$1',[location])).rows[0].name,'Studio testowe');
 const session=(await pg.query<any>('select id from public.aco_sessions limit 1')).rows[0].id;const changed=await handle(request(4,{action:'command',requestId:id(953),command:{type:'sessionLocation',id:session,locationId:location}}));assert.equal(changed.status,200);assert.equal((await pg.query<any>('select location_id from public.aco_sessions where id=$1',[session])).rows[0].location_id,location);
 const security=await pg.query<any>("select relrowsecurity, has_table_privilege('authenticated','public.aco_locations','SELECT') browser_read from pg_class where oid='public.aco_locations'::regclass");assert.equal(security.rows[0].relrowsecurity,true);assert.equal(security.rows[0].browser_read,false);
});

test('revocation rejects old sessions for reads and writes without Auth DELETE permission',async()=>{
 assert.equal((await pg.query<any>("select has_table_privilege('service_role','auth.sessions','DELETE') allowed")).rows[0].allowed,false);
 assert.equal((await pg.query<any>('select count(*)::int n from auth.sessions where id=$1',[id(103)])).rows[0].n,1);
 await assert.rejects(pg.query('select aco_private.relational_session($1,$2)',[id(3),id(103)]),/Session revoked/);
 await assert.rejects(pg.query('select aco_private.check_runtime_session($1,$2)',[id(3),id(103)]),/Session revoked/);
 assert.equal((await handle(request(3,{action:'command',requestId:id(1999),command:{type:'updateProfile',name:'Blocked'}}))).status,403);
 // Repeated revocation is idempotent; a genuinely new login is still permitted.
 await pg.query('select public.aco_revoke_sessions($1)',[id(3)]);
 await pg.exec('reset role');await pg.query('insert into auth.sessions values($1,$2,null)',[id(1103),id(3)]);await pg.exec('set role service_role');
 assert.equal((await pg.query<any>('select aco_private.relational_session($1,$2) role',[id(3),id(1103)])).rows[0].role,'trainer');
 for(const role of ['anon','authenticated']){
 await pg.exec('reset role;set role '+role);
 await assert.rejects(pg.query('select * from aco_private.revoked_sessions'),/permission denied/);
 await assert.rejects(pg.query('select public.aco_revoke_sessions($1)',[id(4)]),/permission denied/);
 }
 await pg.exec('reset role;set role service_role');
});

test('shared clock is admin-only, idempotent, and does not extend expired auth sessions',async()=>{
 const real=Date.now(),target=new Date(real+2*86400000).toISOString(),body={action:'testClock',requestId:id(2001),target};
 assert.equal((await handle(request(1,body))).status,403);
 const shifted=await handle(request(4,body));assert.equal(shifted.status,200,JSON.stringify(await shifted.clone().json()));const state=await shifted.json();assert.ok(Math.abs(Date.parse(state.db.now)-Date.parse(target))<5000);assert.ok(state.db.timeOffsetSeconds>172790);
 const replay=await handle(request(4,body));assert.equal(replay.status,200);
 const same=(await handle(request(1,{action:'state'})));assert.equal(same.status,200);assert.ok(Math.abs(Date.parse((await same.json()).db.now)-Date.parse(target))<5000);
 await pg.exec('reset role');await pg.query("insert into auth.sessions values($1,$2,now()-interval '1 hour')",[id(2999),id(1)]);await pg.exec('set role service_role');
 await assert.rejects(pg.query('select aco_private.relational_session($1,$2)',[id(1),id(2999)]),/revoked/);
 assert.equal((await handle(request(4,{action:'testClock',requestId:id(2002),target:null}))).status,200);
 for(const role of ['anon','authenticated']){await pg.exec('reset role;set role '+role);await assert.rejects(pg.query('select * from aco_private.test_clock'),/permission denied/)}await pg.exec('reset role;set role service_role');
});
test('archival preserves history and rejects every old session; permanent deletion removes typed data',async()=>{
 const body={action:'accountLifecycle',requestId:id(2010),accountId:id(500),mode:'archive',confirmation:''};
 assert.equal((await handle(request(1,body))).status,403);
 assert.equal((await handle(request(4,{...body,accountId:id(3)}))).status,422);
 const archived=await handle(request(4,body));assert.equal(archived.status,200,JSON.stringify(await archived.clone().json()));
 assert.equal((await handle(request(500,{action:'state'}))).status,403);
 assert.equal((await pg.query<any>('select count(*)::int n from public.aco_sessions where client_id=$1',[registeredClient])).rows[0].n,1);
 const denied=await handle(request(4,{...body,requestId:id(2011),mode:'purge'}));assert.equal(denied.status,422);
 const purged=await handle(request(4,{...body,requestId:id(2012),mode:'purge',confirmation:'USUŃ'}));assert.equal(purged.status,200,JSON.stringify(await purged.clone().json()));
 assert.equal((await pg.query<any>('select count(*)::int n from public.aco_profiles where id=$1',[registeredClient])).rows[0].n,0);
 assert.equal((await pg.query<any>('select count(*)::int n from public.aco_sessions where client_id=$1',[registeredClient])).rows[0].n,0);
 const replay=await handle(request(4,{...body,requestId:id(2012),mode:'purge',confirmation:'USUŃ'}));assert.equal(replay.status,200);
});
test('permanent trainer removal leaves other trainers and clients intact',async()=>{
 const trainerId=id(3000);await pg.exec('reset role');await pg.query('insert into auth.users(id) values($1)',[trainerId]);await pg.exec('set role service_role');
 await pg.query("insert into public.aco_profiles(id,auth_user_id,name,email) values($1,$1,'Disposable trainer','disposable@example.test')",[trainerId]);
 await pg.query("insert into public.aco_accounts(id,profile_id,role) values($1,$1,'trainer')",[trainerId]);await pg.query('insert into public.aco_trainers(id) values($1)',[trainerId]);
 await pg.query("insert into public.aco_earnings(id,trainer_id,kind,hours,rate_grosz,amount_grosz,month,description) values($1,$2,'company',2,5000,10000,'2026-09-01','Test')",[id(3001),trainerId]);
 const response=await handle(request(4,{action:'accountLifecycle',requestId:id(3002),accountId:trainerId,mode:'purge',confirmation:'USUŃ'}));assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
 assert.equal((await pg.query<any>('select count(*)::int n from public.aco_trainers where id=$1',[trainerId])).rows[0].n,0);
 assert.equal((await pg.query<any>('select count(*)::int n from public.aco_clients')).rows[0].n,2);
 assert.equal((await pg.query<any>('select count(*)::int n from public.aco_earnings where trainer_id=$1',[trainerId])).rows[0].n,0);
});
test('individual plans, trainer details and flat consultation rates persist as typed rows',async()=>{
 const proposal={type:'individualPlan',clientId:id(1),plan:{service:'personal',intensity:4,cycleWeeks:4,validWeeks:6,price:1700}};
 const result=await handle(request(4,{action:'command',requestId:id(3010),command:proposal}));assert.equal(result.status,200,JSON.stringify(await result.clone().json()));
 const client=await handle(request(1,{action:'state'}));assert.equal((await client.json()).db.clients[0].individualPlan.price,1700);
 const record=(await pg.query<any>('select * from public.aco_individual_plans where client_id=$1',[id(1)])).rows[0];assert.equal(record.price_grosz,170000);assert.equal(record.intensity,4);
 const {encodeRelational,decodeRelational}=await import('../../server/relational-store');
 const snapshot=(await pg.query<any>('select public.aco_relational_load($1,$2) result',[id(4),id(104)])).rows[0].result;
 const db=decodeRelational(snapshot);db.trainers[0].description='Public trainer description';db.trainers[0].consultationRate=135;db.trainers[0].consultationRateHistory=[{from:'2026-01-01',rate:135}];
 const roundtrip=decodeRelational({...snapshot,rows:encodeRelational(db)});assert.equal(roundtrip.trainers[0].consultationRate,135);assert.equal(roundtrip.trainers[0].description,'Public trainer description');assert.equal(roundtrip.trainers[0].consultationRateHistory?.[0].rate,135);
});
test('product color persists in typed rows and only admin can change it',async()=>{
 const command={type:'productCopy',service:'personal',copy:{name:'Trening personalny',subtitle:'Opis produktu',bullets:['Opieka trenera'],color:'#4169A3'}};
 const denied=await handle(request(3,{action:'command',requestId:id(997),command}));assert.notEqual(denied.status,200);
 const result=await handle(request(4,{action:'command',requestId:id(998),command}));assert.equal(result.status,200,JSON.stringify(await result.json()));
 assert.equal((await pg.query<any>("select color from public.aco_products where id='personal'")).rows[0].color,'#4169A3');
 await assert.rejects(pg.query("update public.aco_products set color='url(https://example.invalid)' where id='personal'"),/check constraint/);
});

test('company hours persist edits, reject settled deletions, preserve corrections and revoke trainer editing',async()=>{
 const call=(command:unknown)=>handle(request(4,{action:'command',requestId:crypto.randomUUID(),command}));
 let response=await call({type:'extraHours',trainerId:id(3),month:'2026-10',hours:2,rate:100,description:'Team meeting'});assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
 const hours=(await response.json()).db.extraHours.find((h:any)=>h.description==='Team meeting'),hid=hours.id;
 response=await call({type:'editExtraHours',id:hid,hours:3,rate:100,description:'Team meeting'});assert.equal(response.status,200);
 response=await call({type:'settleExtraHours',id:hid});assert.equal(response.status,200);
 assert.equal((await call({type:'deleteExtraHours',id:hid})).status,422);
 response=await call({type:'correctExtraHours',id:hid,hours:1,rate:100,description:'Team meeting',reason:'Duplicate entry'});assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
 const row=(await pg.query<any>('select * from public.aco_earnings where id=$1',[hid])).rows[0];assert.equal(row.amount_grosz,10000);assert.equal(row.corrections[0].before.amount,300);assert.ok(row.settled_at);
 response=await call({type:'correctExtraHours',id:hid,hours:0,rate:100,description:'Cancelled',reason:'Incorrect entry'});assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
 assert.equal((await pg.query<any>('select amount_grosz from public.aco_earnings where id=$1',[hid])).rows[0].amount_grosz,0);
 response=await call({type:'extraHours',trainerId:id(3),month:'2026-10',hours:1,rate:50,description:'Remove me'});const removeId=(await response.json()).db.extraHours.find((h:any)=>h.description==='Remove me').id;
 assert.equal((await call({type:'deleteExtraHours',id:removeId})).status,200);
 assert.equal((await pg.query<any>('select count(*)::int n from public.aco_earnings where id=$1',[removeId])).rows[0].n,0);
});
test('admin email requires confirmation, persists login, revokes sessions and replays safely',async()=>{
 const command={type:'clientProfile',id:id(2),name:'Updated client',phone:'555',birthDate:'1990-02-02',answers:['Changed']};
 let response=await handle(request(4,{action:'command',requestId:crypto.randomUUID(),command}));assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
 const body={action:'adminEmail',requestId:crypto.randomUUID(),accountId:id(2),email:'changed@example.test',confirmation:'ZMIEŃ E-MAIL'};
 assert.equal((await handle(request(4,{...body,confirmation:''}))).status,422);
 response=await handle(request(4,body));assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
 assert.equal(authEmails.get(id(2)),'changed@example.test');
 assert.equal((await pg.query<any>('select email,pending_email from public.aco_profiles where id=$1',[id(2)])).rows[0].email,'changed@example.test');
 assert.equal((await handle(request(2,{action:'state'}))).status,403);
 assert.equal((await handle(request(4,body))).status,200);
 for(const role of ['anon','authenticated']){await pg.exec('reset role;set role '+role);await assert.rejects(pg.query('select public.aco_begin_email_change($1,$2,$3,$4,$5,$6)',[id(4),id(104),id(2),'bad@example.test',crypto.randomUUID(),'a'.repeat(64)]),/permission denied/)}await pg.exec('reset role;set role service_role');
});

test('email change recovers after Auth succeeds but database completion is interrupted',async()=>{
 const body={action:'adminEmail',requestId:crypto.randomUUID(),accountId:id(2),email:'recovered@example.test',confirmation:'ZMIEŃ E-MAIL'};
 failEmailFinish=true;assert.equal((await handle(request(4,body))).status,503);assert.equal(authEmails.get(id(2)),body.email);
 assert.equal((await pg.query<any>('select pending_email from public.aco_profiles where id=$1',[id(2)])).rows[0].pending_email,body.email);
 await assert.rejects(pg.query('select aco_private.relational_session($1,$2)',[id(2),id(102)]),/Email change pending/);
 const recovered=await handle(request(4,body));assert.equal(recovered.status,200,JSON.stringify(await recovered.clone().json()));
 assert.equal((await pg.query<any>('select pending_email from public.aco_profiles where id=$1',[id(2)])).rows[0].pending_email,null);
 const later={...body,requestId:crypto.randomUUID(),email:'later@example.test'};assert.equal((await handle(request(4,later))).status,200);
 assert.equal((await handle(request(4,body))).status,200);assert.equal(authEmails.get(id(2)),later.email);
 rejectEmail=true;assert.equal((await handle(request(4,{...body,requestId:crypto.randomUUID(),email:'taken@example.test'}))).status,422);rejectEmail=false;
 assert.equal((await pg.query<any>('select pending_email from public.aco_profiles where id=$1',[id(2)])).rows[0].pending_email,null);assert.equal(authEmails.get(id(2)),later.email);
});
test('trainer cannot change profile via command or database action whitelist',async()=>{
 await pg.query('update public.aco_profiles set must_change_password=false where id=$1',[id(3)]);sessionIds.set(3,id(1103));
 const response=await handle(request(3,{action:'command',requestId:crypto.randomUUID(),command:{type:'updateProfile',name:'Not allowed',email:'trainer@example.test',phone:'555',photo:''}}));assert.equal(response.status,422);assert.match((await response.json()).error,/administrator/);
 const clock=(await pg.query<any>('select version from aco_private.test_clock')).rows[0].version;
 await assert.rejects(pg.query('select public.aco_relational_commit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[id(3),id(1103),crypto.randomUUID(),'a'.repeat(64),'updateProfile','trainer','[]','[]','[]',[],[],clock]),/Trainer operation denied/);
 assert.equal((await handle(request(3,{action:'adminEmail',requestId:crypto.randomUUID(),accountId:id(2),email:'stolen@example.test',confirmation:'ZMIEŃ E-MAIL'}))).status,403);
});

test('state cache skips full history only while authorized and unchanged',async()=>{const first=await handle(request(4,{action:'state'})),body=await first.json();assert.equal(first.status,200);assert.ok(body.cacheTag);const same=await handle(request(4,{action:'state',cacheTag:body.cacheTag}));const compact=await same.json();assert.equal(same.status,200);assert.equal(compact.unchanged,true);assert.equal(compact.db,undefined);await pg.query("update public.aco_settings set consultation_grosz=consultation_grosz+1 where id='company'");const changed=await handle(request(4,{action:'state',cacheTag:body.cacheTag}));assert.ok((await changed.json()).db)});
