import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../../server/handler';
import {encodeRelational} from '../../server/relational-store';
import {initialDatabase} from '../../src/auth';
import {dateOf,dayAdd,seed,execute,at,currentPackage,unbooked,balance} from '../../src/domain';
const pg=new PGlite();after(()=>pg.close());
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
await pg.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,raw_app_meta_data jsonb default '{}');create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
for(const name of (await readdir(new URL('../../supabase/migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await pg.exec(await readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8'));
// Match hosted Supabase: backend can inspect Auth sessions, never delete them.
await pg.exec('revoke delete on auth.sessions from service_role');
const sessionIds=new Map<number,string>();
const source=await initialDatabase();source.settings.rules={...source.settings.rules!,consultationLeadHours:0,trainingLeadHours:0};source.accounts=[{id:id(1),email:'one@example.test',role:'client',clientId:id(1)},{id:id(2),email:'two@example.test',role:'client',clientId:id(2)},{id:id(3),email:'trainer@example.test',role:'trainer',trainerId:id(3)},{id:id(4),email:'admin@example.test',role:'admin'},{id:id(5),email:'flex@example.test',role:'client',clientId:id(5)}];
source.trainers=[{id:id(3),name:'Trainer',rate:0,consultationRate:75,days:[0,1,2,3,4,5,6],hours:[10,11,12],products:['personal'],pesel:'12345678901'}];
source.clients=source.accounts.filter(a=>a.role==='client').map(a=>({id:a.id,email:a.email,name:a.id,phone:'500600700',birthDate:'1990-01-01',trainerId:id(3),service:'personal',intensity:1,active:true,invited:true,prescribed:true,answers:['PRIVATE HEALTH']}));
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


function micro(){const db=seed();db.sessions=[];db.holds=[];db.packages=[];db.blocks=[];const c=db.clients[0];c.intensity=1;const t=db.trainers[0];t.days=[0,1,2,3,4,5,6];t.hours=[10,11,12];const p={id:'micro',clientId:c.id,count:1,start:'2026-10-19',cycleEnd:'2026-10-26',validUntil:'2026-11-02',protectionUntil:'2026-11-03',slots:[],service:'personal',intensity:1,price:100};db.packages=[p];db.sessions=[{id:'visit',clientId:c.id,trainerId:t.id,packageId:p.id,date:'2026-10-20',hour:10,kind:'training',status:'scheduled',publicNote:'',privateNote:'',comments:[]}];return db}
const coach={role:'trainer' as const,trainerId:'t1',clientId:'c1'};
test('A: one-visit package cancellation returns credit and permits rebooking',()=>{let db=micro();db=execute(db,coach,{type:'outcome',id:'visit',status:'cancelled_trainer'});assert.equal(unbooked(db,db.packages[0]),1);assert.equal(balance(db,'c1'),1);const next=execute(db,coach,{type:'makeup',packageId:'micro',date:'2026-10-21',hour:10});assert.equal(unbooked(next,next.packages[0]),0);assert.equal(next.sales.length,db.sales.length)});
test('B: future paid package keeps its available credit after cancellation',()=>{let db=micro();db.packages[0].start='2026-10-20';db=execute(db,coach,{type:'outcome',id:'visit',status:'cancelled_trainer'});assert.equal(unbooked(db,db.packages[0]),1);assert.equal(currentPackage(db,'c1'),undefined);assert.equal(balance(db,'c1'),1);assert.doesNotThrow(()=>execute(db,coach,{type:'makeup',packageId:'micro',date:'2026-10-21',hour:10}))});
test('C: newer package does not hide or prevent using still-valid older credit',()=>{let db=micro();db=execute(db,coach,{type:'outcome',id:'visit',status:'cancelled_trainer'});db.packages.push({...db.packages[0],id:'newer',start:'2026-10-26',cycleEnd:'2026-11-02',validUntil:'2026-11-09'});db.now=at('2026-10-26',8).toISOString();assert.equal(currentPackage(db,'c1')?.id,'newer');assert.equal(unbooked(db,db.packages[0]),1);assert.equal(balance(db,'c1'),2);assert.doesNotThrow(()=>execute(db,coach,{type:'makeup',packageId:'micro',date:'2026-10-27',hour:10}))});
test('D: expiry does not consume returned credit but prevents booking',()=>{let db=micro();db=execute(db,coach,{type:'outcome',id:'visit',status:'cancelled_trainer'});db.now=at('2026-11-02',8).toISOString();assert.equal(unbooked(db,db.packages[0]),1);assert.equal(balance(db,'c1'),0);assert.throws(()=>execute(db,coach,{type:'makeup',packageId:'micro',date:'2026-11-03',hour:10}),/Brak ważnego wejścia/)});
test('E: SQL releases the sole credit on trainer cancellation and reuses it once',async()=>{const date=dayAdd(dateOf(new Date()),3),pid=id(9400),sid=id(9401);await pg.query("insert into aco_packages(id,client_id,product,intensity,count,starts_on,cycle_end,valid_until,protection_until,price_grosz,base_price_grosz) values($1,$2,'personal',1,1,$3,$3::date+7,$3::date+14,$3::date+15,10000,10000)",[pid,id(1),date]);await pg.query("insert into aco_sessions(id,client_id,trainer_id,package_id,kind,starts_at,ends_at,status) values($1,$2,$3,$4,'training',(($5::date+time '10:00') at time zone 'Europe/Warsaw'),(($5::date+time '11:00') at time zone 'Europe/Warsaw'),'scheduled')",[sid,id(1),id(3),pid,date]);const original=(await pg.query<any>('select credit_id from aco_sessions where id=$1',[sid])).rows[0].credit_id;let response=await handle(request(3,{action:'command',requestId:id(9402),command:{type:'outcome',id:sid,status:'cancelled_trainer'}}));assert.equal(response.status,200,JSON.stringify(await response.json()));response=await handle(request(3,{action:'command',requestId:id(9403),command:{type:'makeup',packageId:pid,date:dayAdd(date,1),hour:10}}));assert.equal(response.status,200,JSON.stringify(await response.json()));const rows=(await pg.query<any>('select status,credit_id from aco_sessions where package_id=$1',[pid])).rows;assert.equal(rows.length,2);assert.ok(rows.every(r=>r.credit_id===original));assert.equal(rows.filter(r=>r.status==='scheduled').length,1);response=await handle(request(3,{action:'command',requestId:id(9404),command:{type:'makeup',packageId:pid,date:dayAdd(date,2),hour:10}}));assert.notEqual(response.status,200);});
test('F: account approval already works without recurring slots or package',()=>{const db=seed();const next=execute(db,{...coach,role:'admin'},{type:'activate',id:'c9',service:'personal',intensity:1});assert.equal(next.clients.find(c=>c.id==='c9')?.invited,true);assert.equal(next.packages.filter(p=>p.clientId==='c9').length,0);assert.equal(next.holds.filter(h=>h.clientId==='c9').length,0)});
test('G: current paid-package checkout requires all recurring appointments',()=>{const db=micro();db.packages=[];db.sessions=[];assert.throws(()=>execute(db,coach,{type:'hold',clientId:'c1',start:'2026-10-20',slots:[],dates:[]}),/stałe godziny/)});
test('H: purchased package count is immutable; extra grants need a separate path',async()=>{const pid=id(9500),date=dateOf(new Date());await pg.query("insert into aco_packages(id,client_id,product,intensity,count,starts_on,cycle_end,valid_until,protection_until,price_grosz,base_price_grosz) values($1,$2,'personal',1,1,$3,$3::date+7,$3::date+14,$3::date+15,10000,10000)",[pid,id(2),date]);await assert.rejects(pg.query('update aco_packages set count=2 where id=$1',[pid]),/Purchased package snapshot is immutable/);assert.equal((await pg.query<any>('select count(*)::int n from aco_credits where package_id=$1',[pid])).rows[0].n,1)});
test('I: flexible mode, payment, first booking and cancellation persist through real SQL and handler',async()=>{
 let seq=9600;const call=async(account:number,command:any)=>{const response=await handle(request(account,{action:'command',requestId:id(seq++),command})),result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;};
 const forbidden=await handle(request(5,{action:'command',requestId:id(seq++),command:{type:'scheduleMode',clientId:id(5),flexible:true}}));assert.notEqual(forbidden.status,200);
 await call(3,{type:'scheduleMode',clientId:id(5),flexible:true});
 const today=dateOf(new Date());await call(5,{type:'hold',clientId:id(5),start:today,slots:[],dates:[]});
 const hold=(await pg.query<any>('select * from aco_holds where client_id=$1',[id(5)])).rows[0];assert.equal(hold.flexible,true);assert.equal((await pg.query<any>('select count(*)::int n from aco_hold_dates where hold_id=$1',[hold.id])).rows[0].n,0);
 await call(5,{type:'requestPayment',id:hold.id});await call(4,{type:'payHold',id:hold.id});
 let pack=(await pg.query<any>('select * from aco_packages where client_id=$1',[id(5)])).rows[0];assert.equal(pack.pending_start,true);assert.equal(pack.count,4);
 const first=dayAdd(today,2);await call(5,{type:'makeup',packageId:pack.id,date:first,hour:12});
 pack=(await pg.query<any>('select * from aco_packages where id=$1',[pack.id])).rows[0];assert.equal(pack.pending_start,false);assert.equal(new Date(pack.starts_on).toISOString().slice(0,10),first);assert.equal(new Date(pack.valid_until).toISOString().slice(0,10),dayAdd(first,42));
 const visit=(await pg.query<any>('select * from aco_sessions where package_id=$1',[pack.id])).rows[0];assert.ok(visit.credit_id);
 await call(3,{type:'outcome',id:visit.id,status:'cancelled_trainer'});
 await call(3,{type:'makeup',packageId:pack.id,date:dayAdd(first,1),hour:12});
 const live=(await pg.query<any>("select count(*)::int n from aco_sessions where package_id=$1 and status='scheduled'",[pack.id])).rows[0].n;assert.equal(live,1);
 assert.equal((await pg.query<any>("select count(*)::int n from aco_sales where package_id=$1",[pack.id])).rows[0].n,1);
 const leak=await pg.query<any>("select has_table_privilege('authenticated','public.aco_packages','INSERT') access");assert.equal(leak.rows[0].access,false);
});
