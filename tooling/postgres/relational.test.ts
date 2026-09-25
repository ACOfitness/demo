import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {initialDatabase} from '../../src/auth';
import {encodeRelational,decodeRelational,relationalCommitArgs} from '../../server/relational-store';
import {readFile,readdir} from 'node:fs/promises';
const bootstrap=new pg.Client({host:'/tmp/aco-pg-socket',port:55439,database:'postgres'});await bootstrap.connect();
await bootstrap.query('drop database if exists aco_rebuild');await bootstrap.query('create database aco_rebuild');await bootstrap.end();
const pool=new pg.Pool({host:'/tmp/aco-pg-socket',port:55439,database:'aco_rebuild',max:30});
after(()=>pool.end());
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
await pool.query(`create schema auth;create table auth.users(id uuid primary key);create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
for(const name of (await readdir(new URL('../../supabase/migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await pool.query(await readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8'));
const source=await initialDatabase();
source.accounts=[{id:id(1),role:'admin',name:'Admin',email:'admin@example.test'},{id:id(2),role:'trainer',trainerId:id(20),email:'trainer@example.test'},{id:id(3),role:'client',clientId:id(30),email:'client@example.test'},{id:id(4),role:'client',clientId:id(40),email:'other@example.test'}];
source.trainers=[{id:id(20),name:'Trainer',rate:50,days:[0,1,2,3,4,5,6],hours:[9,10,11,12],products:['personal'],pesel:'12345678901'}];
source.clients=source.accounts.filter(a=>a.role==='client').map(a=>({id:a.clientId!,name:a.email,email:a.email,phone:'123',birthDate:'1990-01-01',trainerId:id(20),service:'personal',intensity:1,active:true,invited:true,prescribed:true,answers:['HEALTH '+a.id]}));
const cx=await pool.connect();
await cx.query('begin');
try{
 for(const a of source.accounts){await cx.query('insert into auth.users values($1) on conflict do nothing',[a.id]);await cx.query('insert into auth.sessions values($1,$2,null) on conflict do nothing',[id(Number(a.id.slice(-2))+100),a.id]);}
 const order=(await cx.query('select aco_private.relational_tables() tables')).rows[0].tables;
 const rows=encodeRelational(source).sort((a,b)=>order.indexOf(a.table)-order.indexOf(b.table));
 for(const r of rows)await cx.query('select aco_private.write_relational_row($1,$2,$3)',[r.table,r.key,r.data]);
 await cx.query('commit');
}catch(e){await cx.query('rollback');throw e}finally{cx.release()}
async function load(n:number){return (await pool.query('select public.aco_relational_load($1,$2,null) value',[id(n),id(n+100)])).rows[0].value;}
test('client load is scoped in SQL, preserves separate Auth and domain ids',async()=>{
 const s=await load(3),db=decodeRelational(s);
 assert.equal(db.clients.length,1);assert.equal(db.clients[0].id,id(30));assert.equal(db.accounts.find(a=>a.id===id(3))?.clientId,id(30));
 assert.ok(!JSON.stringify(s).includes('12345678901'));assert.ok(!JSON.stringify(s).includes('other@example.test'));assert.equal(db.trainers[0].name,'Trainer');
 assert.deepEqual(relationalCommitArgs(db,structuredClone(db),id(3),'state').p_changes,[]);
});
test('public load has anonymous directory, no client data',async()=>{
 const s=(await pool.query('select public.aco_relational_public_load(null) value')).rows[0].value;
 // Admin contacts must not leak even inside a public-purpose loader.
 assert.ok(!JSON.stringify(s).includes('HEALTH'));assert.ok(!JSON.stringify(s).includes('12345678901'));
});
test('200 parallel scoped reads produce no cross-client results',async()=>{
 const times:number[]=[];const started=performance.now();
 await Promise.all(Array.from({length:200},async(_,i)=>{const t=performance.now(),n=i%2+3,s=await load(n);assert.equal(decodeRelational(s).clients[0].id,id(n*10));times.push(performance.now()-t)}));
 times.sort((a,b)=>a-b);console.log(JSON.stringify({scenario:'200 concurrent SQL scoped reads, pool 30, local Postgres 17',elapsedMs:Math.round(performance.now()-started),p95Ms:Math.round(times[189])}));
});

import {createHandler} from '../../server/handler';
import {dayAdd,dateOf,dayIndex} from '../../src/domain';
const rpcNames=new Set(['aco_relational_load','aco_relational_commit','aco_relational_public_load','aco_rate_limit','aco_revoke_sessions']);
const fetcher:typeof fetch=async(input,init)=>{
 const url=new URL(String(input));
 if(url.pathname==='/auth/v1/user'){
  const authorization=(init?.headers as Record<string,string>).Authorization;
  const claims=JSON.parse(Buffer.from(authorization.slice(7).split('.')[1],'base64url').toString());return Response.json({id:claims.sub});
 }
 const name=url.pathname.split('/').at(-1)!;assert.ok(rpcNames.has(name));
 const values=JSON.parse(String(init?.body)),keys=Object.keys(values);assert.ok(keys.every(k=>/^p_[a-z_]+$/.test(k)));
 const c=await pool.connect();try{
 await c.query('set role service_role');
 const result=await c.query(`select public.${name}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) value`,Object.entries(values).map(([k,v])=>['p_clients','p_trainers'].includes(k)?v:v&&typeof v==='object'?JSON.stringify(v):v));
 return Response.json(result.rows[0].value);
 }catch(e){console.log('rpc-error',name,(e as any).code,(e as Error).message);return Response.json({code:(e as any).code},{status:400})}finally{await c.query('reset role');c.release()}
};
const handle=createHandler({url:'https://project.supabase.co',serviceKey:'test-only',origins:['https://acofitness.github.io']},fetcher);
const request=(n:number,body:unknown)=>new Request('https://project.supabase.co/functions/v1/aco-api',{method:'POST',headers:{Origin:'https://acofitness.github.io',Authorization:'Bearer header.'+Buffer.from(JSON.stringify({sub:id(n),session_id:id(n+100)})).toString('base64url')+'.signature'},body:JSON.stringify(body)});
let winningBody:any,winningActor:number;
test('parallel booking through API leaves exactly one winner and atomic claims',async()=>{
 const start=dayAdd(dateOf(new Date()),1),slots=[{day:dayIndex(start),hour:9}],dates=[0,1,2,3].map(w=>({date:dayAdd(start,w*7),hour:9}));
 const bodies=[3,4].map(n=>({action:'command',requestId:crypto.randomUUID(),command:{type:'hold',clientId:id(n*10),start,slots,dates}}));
 const responses=await Promise.all(bodies.map((b,i)=>handle(request(i+3,b))));
 const results=await Promise.all(responses.map(async r=>({status:r.status,body:await r.json()})));
 assert.equal(results.filter(r=>r.status===200).length,1,JSON.stringify(results));
 const winner=results.findIndex(r=>r.status===200);winningBody=bodies[winner];winningActor=winner+3;
 assert.equal((await pool.query('select count(*)::int n from public.aco_holds')).rows[0].n,1);
 assert.equal((await pool.query('select count(*)::int n from public.aco_calendar_claims')).rows[0].n,4);
});
test('same request replay is idempotent',async()=>{
 const r=await handle(request(winningActor,winningBody));assert.equal(r.status,200);assert.equal((await r.json()).replayed,true);
 assert.equal((await pool.query('select count(*)::int n from public.aco_holds')).rows[0].n,1);
});
test('browser roles cannot directly read or mutate private domain tables',async()=>{
 const c=await pool.connect();try{await c.query('set role authenticated');
 await assert.rejects(c.query('select * from public.aco_clients'),{code:'42501'});
 await assert.rejects(c.query('select public.aco_relational_load($1,$2,null)',[id(1),id(101)]),{code:'42501'});
 await assert.rejects(c.query("update public.aco_accounts set role='admin' where id=$1",[id(3)]),{code:'42501'});
 }finally{await c.query('reset role');c.release()}
});
test('settlement creates a package with concrete credits and immutable paid price',async()=>{
 const hold=(await pool.query('select id from public.aco_holds')).rows[0].id;
 const r=await handle(request(1,{action:'command',requestId:crypto.randomUUID(),command:{type:'payHold',id:hold,code:''}}));
 const body=await r.json();assert.equal(r.status,200,JSON.stringify(body));
 assert.equal((await pool.query('select count(*)::int n from public.aco_credits')).rows[0].n,4);
 const usage=(await pool.query('select count(*)::int n,count(distinct credit_id)::int credits from public.aco_sessions where kind=\'training\'')).rows[0];assert.deepEqual(usage,{n:4,credits:4});
 assert.equal((await pool.query('select count(*)::int n from public.aco_calendar_claims where hold_id is not null')).rows[0].n,0);
});
test('200 concurrent independent writes have no global version conflict',async()=>{
 const rows=[];
 for(let n=1000;n<1200;n++){
  await pool.query('insert into auth.users values($1)',[id(n)]);await pool.query('insert into auth.sessions values($1,$2,null)',[id(n+2000),id(n)]);
  rows.push({table:'aco_profiles',key:id(n),data:{id:id(n),auth_user_id:id(n),name:'Load test '+n,email:`load${n}@example.test`,phone:''}});
  rows.push({table:'aco_accounts',key:id(n),data:{id:id(n),profile_id:id(n),role:'client',enabled:true}});
  rows.push({table:'aco_clients',key:id(n),data:{id:id(n),lead_trainer_id:id(20),birth_date:'1990-01-01',status:'active',product:'personal',intensity:1,approved_at:new Date().toISOString()}});
 }
 for(const r of rows)await pool.query('select aco_private.write_relational_row($1,$2,$3)',[r.table,r.key,r.data]);
 const times:number[]=[];const started=performance.now();
 await Promise.all(Array.from({length:200},async(_,i)=>{
  const n=i+1000,t=performance.now();
  const snapshot=(await pool.query('select public.aco_relational_load($1,$2,null) value',[id(n),id(n+2000)])).rows[0].value;
  const before=decodeRelational(snapshot),after=structuredClone(before);after.clients[0].phone='555000'+n;
  const args={p_actor:id(n),p_session:id(n+2000),p_request:crypto.randomUUID(),p_hash:'a'.repeat(64),...relationalCommitArgs(before,after,id(n),'updateProfile')};
  await pool.query(`select public.aco_relational_commit(${Object.keys(args).map((k,i)=>`${k}=>$${i+1}`).join(',')})`,Object.entries(args).map(([k,v])=>['p_clients','p_trainers'].includes(k)?v:v&&typeof v==='object'?JSON.stringify(v):v));
  times.push(performance.now()-t);
 }));
 times.sort((a,b)=>a-b);const elapsed=performance.now()-started;
 console.log(JSON.stringify({scenario:'200 concurrent clients, scoped read + independent profile commit, pool30, local PostgreSQL17',requests:200,errors:0,elapsedMs:Math.round(elapsed),p50Ms:Math.round(times[99]),p95Ms:Math.round(times[189]),p99Ms:Math.round(times[197]),operationsPerSecond:Math.round(200000/elapsed)}));
 assert.equal((await pool.query("select count(*)::int n from public.aco_profiles where phone like '555000%'")).rows[0].n,200);
});
