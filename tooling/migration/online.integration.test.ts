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
await pg.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
for(const name of (await readdir(new URL('../../supabase/migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await pg.exec(await readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8'));
// Match hosted Supabase: backend can inspect Auth sessions, never delete them.
await pg.exec('revoke delete on auth.sessions from service_role');
const sessionIds=new Map<number,string>();
const source=await initialDatabase();source.accounts=[{id:id(1),email:'one@example.test',role:'client',clientId:id(1)},{id:id(2),email:'two@example.test',role:'client',clientId:id(2)},{id:id(3),email:'trainer@example.test',role:'trainer',trainerId:id(3)},{id:id(4),email:'admin@example.test',role:'admin'}];
source.trainers=[{id:id(3),name:'Trainer',rate:50,days:[0,1,2,3,4,5,6],hours:[10,11,12],products:['personal'],pesel:'12345678901'}];
source.clients=source.accounts.slice(0,2).map(a=>({id:a.id,email:a.email,name:a.id,phone:'123',birthDate:'1990-01-01',trainerId:id(3),service:'personal',intensity:1,active:true,invited:true,prescribed:true,answers:['PRIVATE HEALTH']}));
for(const account of source.accounts){await pg.query('insert into auth.users values($1)',[account.id]);await pg.query('insert into auth.sessions values($1,$2,null)',[id(Number(account.id.slice(-2))+100),account.id]);await pg.query('insert into aco_private.identities(user_id,role,enabled) values($1,$2,true)',[account.id,account.role])}
const order=(await pg.query<{tables:string[]}>('select aco_private.relational_tables() tables')).rows[0].tables;
for(const row of encodeRelational(source).sort((a,b)=>order.indexOf(a.table)-order.indexOf(b.table)))await pg.query('select aco_private.write_relational_row($1,$2,$3)',[row.table,row.key,row.data]);
await pg.exec('set role service_role');
const known=new Set(['aco_relational_load','aco_relational_commit','aco_relational_public_load','aco_rate_limit','aco_revoke_sessions','aco_claim_activation','aco_complete_activation']);
let created=500,recoveries=0,passwordWrites=0,failCompletion=false;const passwords=new Map<string,string>();
const fetcher:typeof fetch=async(input,init)=>{
 const url=new URL(String(input));
 if(url.pathname==='/auth/v1/user'&&init?.method!=='PUT'){
  const header=(init?.headers as Record<string,string>).Authorization;
  const claims=JSON.parse(Buffer.from(header.slice(7).split('.')[1],'base64url').toString());
  return Response.json({id:claims.sub});
 }
 if(url.pathname==='/auth/v1/admin/users'&&init?.method==='POST'){
  const newId=id(created++);await pg.exec('reset role');await pg.query('insert into auth.users values($1)',[newId]);await pg.exec('set role service_role');return Response.json({id:newId});
 }
 if(url.pathname==='/auth/v1/recover'){recoveries++;return Response.json({})}
 if(url.pathname.startsWith('/auth/v1/admin/users/')&&init?.method==='PUT'){
  const body=JSON.parse(String(init.body));if(body.password){passwordWrites++;passwords.set(url.pathname.split('/').at(-1)!,body.password)}return Response.json({});
 }
 if(url.pathname==='/auth/v1/token'){
  const body=JSON.parse(String(init?.body));const account=(await pg.query<any>('select a.id from public.aco_accounts a join public.aco_profiles p on p.id=a.profile_id where p.email=$1',[body.email])).rows[0];
  return account&&passwords.get(account.id)===body.password?Response.json({user:{id:account.id}}):Response.json({error:'invalid password'},{status:400});
 }
 if(''===url.pathname||url.pathname==='/auth/v1/user'&&init?.method==='PUT'||url.pathname.startsWith('/auth/v1/admin/users/'))return Response.json({});
 const name=url.pathname.split('/').at(-1)!;assert.ok(known.has(name));if(name==='aco_complete_activation'&&failCompletion){failCompletion=false;throw new TypeError('Test network failure')}
 const values=JSON.parse(String(init?.body)),keys=Object.keys(values);assert.ok(keys.every(k=>/^p_[a-z_]+$/.test(k)));
 try{const result=await pg.query<{value:unknown}>(`select public.${name}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) value`,Object.entries(values).map(([k,v])=>['p_clients','p_trainers'].includes(k)?v:v&&typeof v==='object'?JSON.stringify(v):v));return Response.json(result.rows[0].value)}catch(error){return Response.json({code:(error as {code:string}).code,message:(error as Error).message},{status:400})}
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
 const response=await handle(new Request('https://project.supabase.co/functions/v1/aco-api',{method:'POST',headers:{Origin:'https://acofitness.github.io'},body:JSON.stringify({action:'register',requestId:id(800),command:{type:'register',name:'New client',email:'new@example.test',phone:'123',birthDate:'1990-01-01',trainerId:id(3),date:dayAdd(dateOf(new Date()),1),hour:11,answers:['Test']}})}));
 assert.equal(response.status,200,JSON.stringify(await response.json()));
 const account=(await pg.query<any>('select * from public.aco_accounts where id=$1',[id(500)])).rows[0];registeredClient=account.profile_id;assert.equal(account.role,'client');assert.equal(account.password,undefined);
 assert.equal((await pg.query<{n:number}>("select count(*)::int n from public.aco_sales")).rows[0].n,0);
 await pg.exec('reset role');await pg.query('insert into auth.sessions values($1,$2,null)',[id(600),id(500)]);await pg.exec('set role service_role');
 const denied=await handle(request(500,{action:'state'}));assert.equal(denied.status,403);
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
 assert.equal((await call('1990-01-01','Another-password-456!')).status,422);assert.equal(passwordWrites,1);
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
 for(const role of ['anon','authenticated']){await pg.exec('reset role;set role '+role);await assert.rejects(claim(),/permission denied/);await assert.rejects(pg.query('select * from aco_private.direct_activations'),/permission denied/)}
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
