import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../../server/handler';
import {encodeRelational} from '../../server/relational-store';
import {initialDatabase} from '../../src/auth';
import {dateOf,dayAdd} from '../../src/domain';
const pg=new PGlite();after(()=>pg.close());
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
await pg.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,raw_app_meta_data jsonb default '{}');create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
for(const name of (await readdir(new URL('../../supabase/migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await pg.exec(await readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8'));
// Match hosted Supabase: backend can inspect Auth sessions, never delete them.
await pg.exec('revoke delete on auth.sessions from service_role');
const sessionIds=new Map<number,string>();
const source=await initialDatabase();source.settings.rules={...source.settings.rules!,consultationLeadHours:0,trainingLeadHours:0};source.accounts=[{id:id(1),email:'one@example.test',role:'client',clientId:id(1)},{id:id(2),email:'two@example.test',role:'client',clientId:id(2)},{id:id(3),email:'trainer@example.test',role:'trainer',trainerId:id(3)},{id:id(4),email:'admin@example.test',role:'admin'}];
source.trainers=[{id:id(3),name:'Trainer',rate:0,consultationRate:75,days:[0,1,2,3,4,5,6],hours:[10,11,12],products:['personal'],pesel:'12345678901'}];
source.clients=source.accounts.slice(0,2).map(a=>({id:a.id,email:a.email,name:a.id,phone:'500600700',birthDate:'1990-01-01',trainerId:id(3),service:'personal',intensity:1,active:true,invited:true,prescribed:true,answers:['PRIVATE HEALTH']}));
for(const account of source.accounts){await pg.query('insert into auth.users(id) values($1)',[account.id]);await pg.query('insert into auth.sessions values($1,$2,null)',[id(Number(account.id.slice(-2))+100),account.id]);await pg.query('insert into aco_private.identities(user_id,role,enabled) values($1,$2,true)',[account.id,account.role])}
const order=(await pg.query<{tables:string[]}>('select aco_private.relational_tables() tables')).rows[0].tables;
for(const row of encodeRelational(source).sort((a,b)=>order.indexOf(a.table)-order.indexOf(b.table)))await pg.query('select aco_private.write_relational_row($1,$2,$3)',[row.table,row.key,row.data]);
await pg.exec('set role service_role');
let createdClient=6000;
const fetcher:typeof fetch=async(input,init)=>{
 const url=new URL(String(input));
 if(url.pathname==='/auth/v1/admin/users'&&init?.method==='POST'){const n=id(createdClient++);await pg.exec('reset role');await pg.query('insert into auth.users(id,email,raw_app_meta_data) values($1,$2,$3)',[n,JSON.parse(String(init.body)).email,JSON.stringify(JSON.parse(String(init.body)).app_metadata)]);await pg.exec('set role service_role');return Response.json({id:n});}
 if(url.pathname==='/auth/v1/user'){
  const token=(init?.headers as Record<string,string>).Authorization.slice(7);
  return Response.json({id:JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).sub});
 }
 const name=url.pathname.split('/').at(-1)!;
 assert.ok(['aco_registration_identity','aco_relational_load','aco_relational_commit','aco_rate_limit'].includes(name));
 const values=JSON.parse(String(init?.body)),keys=Object.keys(values);
 assert.ok(keys.every(k=>/^p_[a-z_]+$/.test(k)));
 try{
  const result=await pg.query<{value:unknown}>(`select public.${name}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) value`,Object.entries(values).map(([k,v])=>['p_clients','p_trainers'].includes(k)?v:v&&typeof v==='object'?JSON.stringify(v):v));
  return Response.json(result.rows[0].value);
 }catch(error){return Response.json({code:(error as {code:string}).code,message:(error as Error).message},{status:400})}
};
const handle=createHandler({url:'https://project.supabase.co',serviceKey:'server-secret',origins:['https://acofitness.github.io']},fetcher);
const request=(account:number,body:unknown)=>new Request('https://project.supabase.co/functions/v1/aco-api',{method:'POST',headers:{Origin:'https://acofitness.github.io',Authorization:'Bearer header.'+Buffer.from(JSON.stringify({sub:id(account),session_id:sessionIds.get(account)||id(account+100)})).toString('base64url')+'.signature'},body:JSON.stringify(body)});


for(const actor of [3,4])for(const kind of ['training','consultation'])for(const status of ['completed','no_show'])test(`${actor} ${kind} ${status}`,async()=>{
 const n=1000+actor*10+(kind==='training'?0:2)+(status==='completed'?0:1),sid=id(n),pid=id(n+100);
 const date=dayAdd(dateOf(new Date()),-(n-1000)*7);
 if(kind==='training')await pg.query("insert into public.aco_packages(id,client_id,product,intensity,count,starts_on,cycle_end,valid_until,protection_until,price_grosz,base_price_grosz) values($1,$2,'personal',1,4,$3,$3::date+28,$3::date+42,$3::date+49,159900,159900)",[pid,id(1),date]);
 await pg.query("insert into public.aco_sessions(id,client_id,trainer_id,package_id,kind,starts_at,ends_at,status) values($1,$2,$3,$4,$5,(($6::date+time '10:00') at time zone 'Europe/Warsaw'),(($6::date+time '12:00') at time zone 'Europe/Warsaw'),'scheduled')",[sid,id(1),id(3),kind==='training'?pid:null,kind,date]);
 const response=await handle(request(actor,{action:'command',requestId:id(n+200),command:{type:'outcome',id:sid,status}}));
 const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));
 assert.equal((await pg.query<any>('select status from aco_sessions where id=$1',[sid])).rows[0].status,status);
 assert.equal((await pg.query<any>('select amount_grosz from aco_earnings where session_id=$1',[sid])).rows[0].amount_grosz,kind==='training'?0:7500);
});

test('negative session rates and zero company-hour rates stay forbidden',async()=>{
 await assert.rejects(pg.query("insert into aco_earnings(id,trainer_id,kind,hours,rate_grosz,amount_grosz,month) values($1,$2,'company',1,0,0,'2026-10-01')",[id(9001),id(3)]),/aco_earnings_rate_grosz_check/);
 await assert.rejects(pg.query('update aco_earnings set rate_grosz=-1 where session_id=$1',[id(1030)]),/aco_earnings_rate_grosz_check/);
});

test('correction persists, reopening removes one earning and repeat cannot double charge',async()=>{
 const sid=id(1032);
 for(const [status,n] of [['no_show',9100],['scheduled',9101],['completed',9102]] as const){
  const body={action:'command',requestId:id(n),command:{type:'outcome',id:sid,status}};
  const response=await handle(request(3,body));assert.equal(response.status,200,JSON.stringify(await response.json()));
  assert.equal((await pg.query<any>('select status from aco_sessions where id=$1',[sid])).rows[0].status,status);
  assert.equal((await pg.query<any>('select count(*)::int n from aco_earnings where session_id=$1',[sid])).rows[0].n,status==='scheduled'?0:1);
  const replay=await handle(request(3,body));assert.equal(replay.status,200);
 }
 const blocked=await handle(request(1,{action:'command',requestId:id(9103),command:{type:'outcome',id:sid,status:'scheduled'}}));assert.notEqual(blocked.status,200);
});
test('admin client creation is authenticated, atomic, replay-safe and initially inactive',async()=>{
 const input={mode:'skip',date:'2026-10-28',hour:-1,name:'Manual Client',email:'manual@example.test',phone:'500600700',birthDate:'1990-01-01',trainerId:id(3),answers:[],service:'personal',intensity:2};
 const body={action:'adminClient',requestId:id(9200),input};
 for(const actor of [1,3])assert.notEqual((await handle(request(actor,body))).status,200);
 assert.equal(createdClient,6000);
 let response=await handle(request(4,body));assert.equal(response.status,200,JSON.stringify(await response.json()));
 response=await handle(request(4,body));assert.equal(response.status,200);assert.equal(createdClient,6001);
 const row=(await pg.query<any>("select c.status,c.product,c.intensity from aco_clients c join aco_profiles p on p.id=c.id where p.email='manual@example.test'")).rows[0];
 assert.deepEqual(row,{status:'approved',product:'personal',intensity:2});
 const duplicate=await handle(request(4,{...body,requestId:id(9201)}));assert.notEqual(duplicate.status,200);assert.equal(createdClient,6001);
});
test('admin consultation creates a real reservation but never a paid sale',async()=>{
 const input={mode:'consultation',name:'Phone Client',email:'phone@example.test',phone:'500600700',birthDate:'1990-01-01',trainerId:id(3),answers:[],date:dayAdd(dateOf(new Date()),2),hour:10};
 const response=await handle(request(4,{action:'adminClient',requestId:id(9300),input}));assert.equal(response.status,200,JSON.stringify(await response.json()));
 const session=(await pg.query<any>("select s.id,s.status,s.kind from aco_sessions s join aco_profiles p on p.id=s.client_id where p.email='phone@example.test'")).rows[0];assert.equal(session.status,'scheduled');assert.equal(session.kind,'consultation');
 assert.equal((await pg.query<any>('select count(*)::int n from aco_calendar_claims where session_id=$1',[session.id])).rows[0].n,2);
 assert.equal((await pg.query<any>('select count(*)::int n from aco_sales where session_id=$1',[session.id])).rows[0].n,0);
});
