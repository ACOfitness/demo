import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../../server/handler';
import {encode} from '../../server/store';
import {initialDatabase} from '../../src/auth';
import {dateOf,dayAdd,dayIndex} from '../../src/domain';
const pg=new PGlite();after(()=>pg.close());
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
await pg.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
for(const name of ['20260925094836_aco_access_foundation.sql','20260925125207_aco_command_transactions.sql','20260925133351_registration_identity_check.sql'])await pg.exec(await readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8'));
const source=await initialDatabase();source.accounts=[{id:id(1),email:'one@example.test',role:'client',clientId:id(1)},{id:id(2),email:'two@example.test',role:'client',clientId:id(2)},{id:id(3),email:'trainer@example.test',role:'trainer',trainerId:id(3)},{id:id(4),email:'admin@example.test',role:'admin'}];
source.trainers=[{id:id(3),name:'Trainer',rate:50,days:[0,1,2,3,4,5,6],hours:[10,11,12],products:['personal'],pesel:'12345678901'}];
source.clients=source.accounts.slice(0,2).map(a=>({id:a.id,email:a.email,name:a.id,phone:'123',trainerId:id(3),service:'personal',intensity:1,active:true,invited:true,prescribed:true,answers:['PRIVATE HEALTH']}));
for(const account of source.accounts){await pg.query('insert into auth.users values($1)',[account.id]);await pg.query('insert into auth.sessions values($1,$2,null)',[id(Number(account.id.slice(-2))+100),account.id]);await pg.query('insert into aco_private.identities(user_id,role,enabled) values($1,$2,true)',[account.id,account.role])}
for(const row of encode(source))await pg.query('insert into aco_private.runtime_entities(kind,id,payload) values($1,$2,$3)',[row.kind,row.id,row.payload]);
await pg.exec('set role service_role');
const known=new Set(['aco_runtime_load','aco_runtime_commit','aco_runtime_system_load','aco_rate_limit','aco_revoke_sessions']);
let created=500,recoveries=0;
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
 if(url.pathname==='/auth/v1/token'||url.pathname==='/auth/v1/user'&&init?.method==='PUT'||url.pathname.startsWith('/auth/v1/admin/users/'))return Response.json({});
 const name=url.pathname.split('/').at(-1)!;assert.ok(known.has(name));
 const values=JSON.parse(String(init?.body)),keys=Object.keys(values);assert.ok(keys.every(k=>/^p_[a-z_]+$/.test(k)));
 try{const result=await pg.query<{value:unknown}>(`select public.${name}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) value`,Object.values(values).map(v=>v&&typeof v==='object'?JSON.stringify(v):v));return Response.json(result.rows[0].value)}catch(error){return Response.json({code:(error as {code:string}).code,message:(error as Error).message},{status:400})}
};
const handle=createHandler({url:'https://project.supabase.co',serviceKey:'server-secret',origins:['https://acofitness.github.io']},fetcher);
const request=(account:number,body:unknown)=>new Request('https://project.supabase.co/functions/v1/aco-api',{method:'POST',headers:{Origin:'https://acofitness.github.io',Authorization:'Bearer header.'+Buffer.from(JSON.stringify({sub:id(account),session_id:id(account+100)})).toString('base64url')+'.signature'},body:JSON.stringify(body)});
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
 const rows=await pg.query<{n:number}>("select count(*)::int n from aco_private.runtime_entities where kind='holds'");assert.equal(rows.rows[0].n,1);
});
test('public availability does not expose accounts or client information',async()=>{
 const response=await handle(new Request('https://project.supabase.co/functions/v1/aco-api',{method:'POST',headers:{Origin:'https://acofitness.github.io'},body:JSON.stringify({action:'publicState'})}));
 assert.equal(response.status,200);const result=await response.json();assert.deepEqual(result.db.clients,[]);assert.deepEqual(result.db.accounts,[]);assert.ok(!JSON.stringify(result).includes('PRIVATE HEALTH'));assert.ok(result.db.blocks.length>=4);
});

let registeredClient='';
test('registration stores a pending client without a fabricated paid sale',async()=>{
 const response=await handle(new Request('https://project.supabase.co/functions/v1/aco-api',{method:'POST',headers:{Origin:'https://acofitness.github.io'},body:JSON.stringify({action:'register',requestId:id(800),command:{type:'register',name:'New client',email:'new@example.test',phone:'123',birthDate:'1990-01-01',trainerId:id(3),date:dayAdd(dateOf(new Date()),1),hour:11,answers:['Test']}})}));
 assert.equal(response.status,200,JSON.stringify(await response.json()));
 const account=(await pg.query<{payload:any}>("select payload from aco_private.runtime_entities where kind='accounts' and id=$1",[id(500)])).rows[0].payload;registeredClient=account.clientId;assert.equal(account.role,'client');assert.equal(account.password,undefined);
 assert.equal((await pg.query<{n:number}>("select count(*)::int n from aco_private.runtime_entities where kind='sales'")).rows[0].n,0);
 await pg.exec('reset role');await pg.query('insert into auth.sessions values($1,$2,null)',[id(600),id(500)]);await pg.exec('set role service_role');
 const denied=await handle(request(500,{action:'state'}));assert.equal(denied.status,403);
});
test('trainer cannot approve early, then approves consultation using server time',async()=>{
 const command={type:'activate',id:registeredClient,service:'personal',intensity:1};
 assert.equal((await handle(request(3,{action:'command',requestId:id(801),command}))).status,422);
 await pg.query("update aco_private.runtime_entities set payload=jsonb_set(payload,'{date}',to_jsonb($1::text)) where kind='sessions' and payload->>'clientId'=$2",[dayAdd(dateOf(new Date()),-1),registeredClient]);
 assert.equal((await handle(request(3,{action:'command',requestId:id(802),command}))).status,200);
});
test('birth date alone cannot activate; activation request only sends ownership link',async()=>{
 const call=(birthDate:string)=>handle(new Request('https://project.supabase.co/functions/v1/aco-api',{method:'POST',headers:{Origin:'https://acofitness.github.io'},body:JSON.stringify({action:'activation',email:'new@example.test',birthDate})}));
 assert.equal((await call('1980-01-01')).status,200);assert.equal(recoveries,0);
 assert.equal((await call('1990-01-01')).status,200);assert.equal(recoveries,1);
 assert.equal((await handle(request(500,{action:'state'}))).status,403);
 const activated=await handle(request(500,{action:'finishActivation',requestId:id(803),password:'A-new-password-123!'}));assert.equal(activated.status,200,JSON.stringify(await activated.json()));
 const state=await handle(request(500,{action:'state'}));assert.equal(state.status,200);const data=await state.json();assert.equal(data.db.clients.length,1);assert.equal(data.db.clients[0].active,true);
});
test('administrator password reset revokes already-issued sessions',async()=>{
 const result=await handle(request(4,{action:'resetPassword',requestId:id(804),accountId:id(3)}));assert.equal(result.status,200,JSON.stringify(await result.clone().json()));const body=await result.json();assert.ok(body.temporary.length>=20);
 assert.equal((await handle(request(3,{action:'state'}))).status,403);
 const replay=await handle(request(4,{action:'resetPassword',requestId:id(804),accountId:id(3)}));assert.equal(replay.status,200);assert.equal((await replay.json()).temporary,body.temporary);
});
