import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../../server/handler';
import {applyCommand} from '../../server/commands';
import {decodeRelational,relationalCommitArgs,encodeRelational} from '../../server/relational-store';
import {initialDatabase} from '../../src/auth';
import {rules,dateOf,dayAdd,seed,execute,at,currentPackage,unbooked,balance} from '../../src/domain';
const pg=new PGlite();after(()=>pg.close());
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
await pg.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,raw_app_meta_data jsonb default '{}');create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
for(const name of (await readdir(new URL('../../supabase/migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await pg.exec(await readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8'));
// Match hosted Supabase: backend can inspect Auth sessions, never delete them.
await pg.exec('revoke delete on auth.sessions from service_role');
const sessionIds=new Map<number,string>();
const source=await initialDatabase();source.settings.rules={...rules(source),consultationLeadHours:0,trainingLeadHours:0};source.accounts=[{id:id(1),email:'one@example.test',role:'client',clientId:id(1)},{id:id(2),email:'two@example.test',role:'client',clientId:id(2)},{id:id(3),email:'trainer@example.test',role:'trainer',trainerId:id(3)},{id:id(4),email:'admin@example.test',role:'admin'},{id:id(5),email:'flex@example.test',role:'client',clientId:id(5)}];
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

async function command(actor:number,cmd:any,key:number){const response=await handle(request(actor,{action:'command',requestId:id(key),command:cmd}));const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result}
test('zero prices persist and zero checkout atomically activates once without admin settlement',async()=>{
 await command(4,{type:'settings',...source.settings,consultation:0,personal:0,physio:0,packagePrices:{personal:{1:0,2:0,3:0},physio:{1:0,2:0,3:0}}},10001);
 await command(4,{type:'scheduleMode',clientId:id(1),flexible:true},10002);
 const res=await command(1,{type:'hold',clientId:id(1),start:dateOf(new Date()),slots:[],dates:[]},10003);const h=res.db.holds.find((h:any)=>h.clientId===id(1));assert.ok(h);
 const paid=await command(1,{type:'requestPayment',id:h.id,useWallet:false},10004);assert.equal(paid.db.packages.length,1);assert.equal(paid.db.packages[0].price,0);assert.equal(paid.db.sales[0].amount,0);await command(1,{type:'requestPayment',id:h.id,useWallet:false},10004);
 assert.equal((await pg.query<any>('select count(*)::int n from aco_packages where client_id=$1',[id(1)])).rows[0].n,1);
});
test('trainer outcome awards both wallets, no ledger leaks, stale spend rejected and remainder retained',async()=>{
 await command(4,{type:'referralSettings',program:{enabled:true,referrerAmount:200,newClientAmount:100,monthlyLimit:5,validDays:180}},10005);
 const coded=await command(1,{type:'referralCode'},10006);const code=coded.db.referralCodes[0].code;
 await command(4,{type:'attachReferral',clientId:id(2),code},10007);
 const date=dayAdd(dateOf(new Date()),-7),pid=id(11000),sid=id(11001);
 await pg.query("insert into aco_packages(id,client_id,product,intensity,count,starts_on,cycle_end,valid_until,protection_until,price_grosz,base_price_grosz) values($1,$2,'personal',1,1,$3,$3::date+7,$3::date+14,$3::date+15,10000,10000)",[pid,id(2),date]);
 await pg.query("insert into aco_sales(id,client_id,package_id,label,amount_grosz,status,settled_at) values($1,$2,$3,'Pakiet',10000,'paid',now()-interval '8 days')",[id(11002),id(2),pid]);
 await pg.query("insert into aco_sessions(id,client_id,trainer_id,package_id,kind,starts_at,ends_at,status) values($1,$2,$3,$4,'training',(($5::date+time '10:00') at time zone 'Europe/Warsaw'),(($5::date+time '11:00') at time zone 'Europe/Warsaw'),'scheduled')",[sid,id(2),id(3),pid,date]);
 const out=await command(3,{type:'outcome',id:sid,status:'completed'},11003);assert.equal(out.db.walletCredits.length,0);assert.equal(out.db.sales.length,0);
 const rows=(await pg.query<any>('select client_id,amount,spent from aco_wallet_credits order by amount desc')).rows;assert.equal(rows.length,2);assert.equal(rows[0].amount,20000);
 // Snapshots of two independent requests cannot both mutate the same reward pool.
 const load=()=>pg.query<any>('select aco_relational_load($1,$2,null) v',[id(4),id(104)]).then(r=>decodeRelational(r.rows[0].v));
 const a=await load(),b=await load();const ac=applyCommand(a,id(4),{type:'referralSettings',program:{enabled:true,referrerAmount:300,newClientAmount:100,monthlyLimit:5,validDays:180}},a.now),bc=applyCommand(b,id(4),{type:'referralSettings',program:{enabled:true,referrerAmount:400,newClientAmount:100,monthlyLimit:5,validDays:180}},b.now);
 async function commit(before:any,after:any,key:number){const d=relationalCommitArgs(before,after,id(4),'referralSettings'),args={p_actor:id(4),p_session:id(104),p_request:id(key),p_hash:'a'.repeat(64),...d},keys=Object.keys(args);return pg.query(`select aco_relational_commit(${keys.map((k,i)=>k+' => $'+(i+1)).join(',')})`,Object.entries(args).map(([k,v])=>['p_clients','p_trainers'].includes(k)?v:v&&typeof v==='object'?JSON.stringify(v):v))}
 await commit(a,ac,11004);await assert.rejects(commit(b,bc,11005),/Row changed/);
});
test('wallet reduces discounted checkout and is spent only after confirmation',async()=>{
 await command(4,{type:'settings',...source.settings,consultation:0,personal:0,physio:0,packagePrices:{personal:{1:150,2:150,3:150},physio:{1:150,2:150,3:150}}},12000);
 await command(4,{type:'scheduleMode',clientId:id(2),flexible:true},12001);
 const res=await command(2,{type:'hold',clientId:id(2),start:dateOf(new Date()),slots:[],dates:[]},12002),h=res.db.holds.find((h:any)=>h.status==='active');
 const waiting=await command(2,{type:'requestPayment',id:h.id,useWallet:true},12003);const hold=waiting.db.holds.find((x:any)=>x.id===h.id);assert.equal(hold.price,50);assert.equal(hold.walletAllocations[0].amount,10000);assert.equal(waiting.db.walletCredits[0].spent,0);
 const confirmed=await command(4,{type:'payHold',id:h.id},12004);assert.equal(confirmed.db.packages.find((p:any)=>p.clientId===id(2)&&p.flexible).price,50);assert.equal(confirmed.db.walletCredits.find((c:any)=>c.clientId===id(2)).spent,10000);await command(4,{type:'payHold',id:h.id},12004);assert.equal((await pg.query<any>('select spent from aco_wallet_credits where client_id=$1',[id(2)])).rows[0].spent,10000);
});
test('RLS and SQL grants keep every referral table inaccessible to browser roles',async()=>{for(const role of ['anon','authenticated']){await pg.exec('set role '+role);for(const table of ['aco_referral_program','aco_referral_codes','aco_referrals','aco_wallet_credits'])await assert.rejects(pg.query('select * from '+table),/permission denied/)}await pg.exec('set role service_role')});
