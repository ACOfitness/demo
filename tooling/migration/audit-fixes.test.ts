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
const source=await initialDatabase();source.settings.rules={...source.settings.rules!,consultationLeadHours:0,trainingLeadHours:0};source.accounts=[{id:id(1),email:'one@example.test',role:'client',clientId:id(1)},{id:id(2),email:'two@example.test',role:'client',clientId:id(2)},{id:id(3),email:'trainer@example.test',role:'trainer',trainerId:id(3)},{id:id(4),email:'admin@example.test',role:'admin'}];
source.trainers=[{id:id(3),name:'Trainer',rate:50,days:[0,1,2,3,4,5,6],hours:[10,11,12],products:['personal'],pesel:'12345678901'}];
source.clients=source.accounts.slice(0,2).map(a=>({id:a.id,email:a.email,name:a.id,phone:'500600700',birthDate:'1990-01-01',trainerId:id(3),service:'personal',intensity:1,active:true,invited:true,prescribed:true,answers:['PRIVATE HEALTH']}));
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
 if(url.pathname==='/auth/v1/user'&&init?.method==='PUT'){
  const token=(init.headers as Record<string,string>).Authorization.slice(7);const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());const body=JSON.parse(String(init.body));
  if(passwords.get(claims.sub)===body.password)return Response.json({error:'same_password'},{status:422});
  passwordWrites++;passwords.set(claims.sub,body.password);return Response.json({id:claims.sub});
 }
 if(''===url.pathname||url.pathname.startsWith('/auth/v1/admin/users/'))return Response.json({});
 const name=url.pathname.split('/').at(-1)!;assert.ok(known.has(name));if(name==='aco_relational_commit'&&failRegistrationCommit){failRegistrationCommit=false;throw new TypeError('Simulated database interruption')}if(name==='aco_complete_activation'&&failCompletion){failCompletion=false;throw new TypeError('Test network failure')}
 if(name==='aco_finish_email_change'&&failEmailFinish){failEmailFinish=false;throw new TypeError('Test interrupted completion')}
 const values=JSON.parse(String(init?.body)),keys=Object.keys(values);assert.ok(keys.every(k=>/^p_[a-z_]+$/.test(k)));
 try{const result=await pg.query<{value:unknown}>(`select public.${name}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) value`,Object.entries(values).map(([k,v])=>['p_clients','p_trainers'].includes(k)?v:v&&typeof v==='object'?JSON.stringify(v):v));return name==='aco_set_test_clock'?new Response(null,{status:204}):Response.json(result.rows[0].value)}catch(error){return Response.json({code:(error as {code:string}).code,message:(error as Error).message},{status:400})}
};
const handle=createHandler({url:'https://project.supabase.co',serviceKey:'server-secret',origins:['https://acofitness.github.io']},fetcher);
const request=(account:number,body:unknown)=>new Request('https://project.supabase.co/functions/v1/aco-api',{method:'POST',headers:{Origin:'https://acofitness.github.io',Authorization:'Bearer header.'+Buffer.from(JSON.stringify({sub:id(account),session_id:sessionIds.get(account)||id(account+100)})).toString('base64url')+'.signature'},body:JSON.stringify(body)});

test('ACO-18: a different registration request can reuse an unattached Auth identity after failed commit',async()=>{
 const command={type:'register',name:'Retry client',email:'retry@example.test',phone:'500600700',birthDate:'1990-01-01',trainerId:id(3),date:dayAdd(dateOf(new Date()),2),hour:10,answers:[]};
 const register=(requestId:string,cmd=command)=>handle(new Request('https://project.supabase.co/functions/v1/aco-api',{method:'POST',headers:{Origin:'https://acofitness.github.io'},body:JSON.stringify({action:'register',requestId,command:cmd})}));
 failRegistrationCommit=true;assert.notEqual((await register(id(900))).status,200);assert.equal(created,501);
 const response=await register(id(901),{...command,date:dayAdd(command.date,1)});assert.equal(response.status,200,JSON.stringify(await response.json()));assert.equal(created,501);
 assert.equal((await pg.query<any>('select count(*)::int n from public.aco_accounts where id=$1',[id(500)])).rows[0].n,1);
 // Ordinary accounts and confirmed/attached registration identities cannot be hijacked.
 assert.equal((await pg.query<any>('select public.aco_registration_identity($1,$2,$3) value',[id(902),'a'.repeat(64),'retry@example.test'])).rows[0].value,null);
});
test('ACO-04: client late cancellation uses private server rate without exposing payroll',async()=>{
 const packageId=id(910),sessionId=id(911),tomorrow=dayAdd(dateOf(new Date()),1);
 await pg.query("insert into public.aco_packages(id,client_id,product,intensity,count,starts_on,cycle_end,valid_until,protection_until,price_grosz,base_price_grosz) values($1,$2,'personal',1,4,$3,$3::date+28,$3::date+42,$3::date+49,159900,159900)",[packageId,id(1),tomorrow]);
 await pg.query("insert into public.aco_sessions(id,client_id,trainer_id,package_id,kind,starts_at,ends_at,status) values($1,$2,$3,$4,'training',(($5::date+time '10:00') at time zone 'Europe/Warsaw'),(($5::date+time '11:00') at time zone 'Europe/Warsaw'),'scheduled')",[sessionId,id(1),id(3),packageId,tomorrow]);
 const response=await handle(request(1,{action:'command',requestId:id(912),command:{type:'outcome',id:sessionId,status:'cancelled_early'}}));
 const view=await response.json();assert.equal(response.status,200,JSON.stringify(view));assert.equal(view.db.sessions.find((s:any)=>s.id===sessionId).status,'cancelled_late');assert.equal(view.db.sessions.find((s:any)=>s.id===sessionId).earned,undefined);
 const earned=(await pg.query<any>('select amount_grosz,rate_grosz from public.aco_earnings where session_id=$1',[sessionId])).rows[0];assert.equal(earned.amount_grosz,5000);assert.equal(earned.rate_grosz,5000);assert.ok(!JSON.stringify(view).includes('12345678901'));
});
test('ACO-03: expired substitute keeps their earnings and minimal historical identity only',async()=>{
 const sub=id(920),session=id(921);
 await pg.query('insert into public.aco_substitutions(id,client_id,trainer_id,starts_at,expires_at) values($1,$2,$3,aco_private.app_now()-interval \'4 days\',aco_private.app_now()-interval \'1 hour\')',[sub,id(1),id(3)]);
 // Transfer the client away so the historical access rule is the only possible source of visibility.
 await pg.exec('reset role');await pg.query('insert into auth.users(id) values($1)',[id(922)]);await pg.query("insert into public.aco_profiles(id,auth_user_id,name,email) values($1,$1,'Other trainer','other@example.test')",[id(922)]);await pg.query("insert into public.aco_trainers(id) values($1)",[id(922)]);await pg.query('update public.aco_clients set lead_trainer_id=$1 where id=$2',[id(922),id(1)]);await pg.exec('set role service_role');
 await pg.query("insert into public.aco_sessions(id,client_id,trainer_id,substitution_id,kind,starts_at,ends_at,status) values($1,$2,$3,$4,'consultation',aco_private.app_now()-interval '3 days',aco_private.app_now()-interval '3 days'+interval '90 minutes','completed')",[session,id(1),id(3),sub]);
 await pg.query("insert into public.aco_earnings(id,session_id,trainer_id,kind,hours,rate_grosz,amount_grosz,month) values($1,$1,$2,'consultation',1.5,5000,7500,date_trunc('month',aco_private.app_now())::date)",[session,id(3)]);
 const response=await handle(request(3,{action:'state'})),view=await response.json();assert.equal(response.status,200);assert.equal(view.db.sessions.find((s:any)=>s.id===session)?.earned,75);const client=view.db.clients.find((c:any)=>c.id===id(1));assert.equal(client.email,'');assert.deepEqual(client.answers,[]);assert.equal(client.trainerId,'');
});

test('REG-02: resetting time preserves committed claims after availability edits and never revives an elapsed checkout',async()=>{
 const sid=id(970),hid=id(971),requestId=id(972);
 await pg.query("insert into public.aco_sessions(id,client_id,trainer_id,kind,starts_at,ends_at,status) values($1,$2,$3,'consultation',now()+interval '1 day',now()+interval '1 day 90 minutes','scheduled')",[sid,id(2),id(3)]);
 await pg.query('insert into public.aco_calendar_claims(trainer_id,starts_at,client_id,session_id) select trainer_id,starts_at,client_id,id from public.aco_sessions where id=$1',[sid]);
 await pg.query("select public.aco_set_test_clock($1,$2,$3,$4,now()+interval '3 days')",[id(4),id(104),id(973),'a'.repeat(64)]);
 await pg.query('delete from public.aco_availability where trainer_id=$1',[id(3)]);
 await pg.query("insert into public.aco_holds(id,client_id,trainer_id,product_id,intensity,starts_on,expires_at,price_grosz,status,kind) values($1,$2,$3,'personal',1,current_date+1,now()+interval '1 day',0,'active','checkout')",[hid,id(2),id(3)]);
 await pg.query("insert into public.aco_calendar_claims(trainer_id,starts_at,client_id,hold_id) values($1,now()+interval '2 days',$2,$3)",[id(3),id(2),hid]);
 await pg.query('select public.aco_set_test_clock($1,$2,$3,$4,null)',[id(4),id(104),requestId,'b'.repeat(64)]);
 assert.equal((await pg.query<any>('select time_offset_seconds from aco_private.test_clock')).rows[0].time_offset_seconds,0);
 assert.equal((await pg.query<any>('select status from public.aco_holds where id=$1',[hid])).rows[0].status,'expired');
 assert.equal((await pg.query<any>('select count(*)::int n from public.aco_calendar_claims where hold_id=$1',[hid])).rows[0].n,0);
 assert.equal((await pg.query<any>('select count(*)::int n from public.aco_calendar_claims where session_id=$1',[sid])).rows[0].n,1);
 const version=(await pg.query<any>('select version from aco_private.test_clock')).rows[0].version;
 await pg.query('select public.aco_set_test_clock($1,$2,$3,$4,null)',[id(4),id(104),requestId,'b'.repeat(64)]);
 assert.equal((await pg.query<any>('select version from aco_private.test_clock')).rows[0].version,version);
 await assert.rejects(pg.query('select public.aco_set_test_clock($1,$2,$3,$4,null)',[id(3),id(103),id(974),'c'.repeat(64)]),/Admin required/);
 await assert.rejects(pg.query('select aco_private.rebuild_calendar($1,$2)',[[id(2)],[id(3)]]),/Reservation outside trainer availability/);
});
