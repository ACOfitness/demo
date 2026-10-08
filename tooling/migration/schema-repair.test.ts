import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const dir=new URL('../../supabase/migrations/',import.meta.url);
test('repair restores missing October migrations, preserves existing colors and is repeatable',async()=>{
 const pg=new PGlite();try{
 await pg.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,raw_app_meta_data jsonb default '{}');create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`);
 const names=(await readdir(dir)).filter(n=>n.endsWith('.sql')).sort();
 for(const name of names.filter(n=>!n.startsWith('20261001')&&!n.startsWith('20261005')&&!n.startsWith('20261008')))await pg.exec(await readFile(new URL(name,dir),'utf8'));
 await assert.rejects(pg.query('select color from public.aco_products'),/does not exist/);
 const repair=await readFile(new URL(names.find(n=>n.startsWith('20261008'))!,dir),'utf8');await pg.exec(repair);
 await pg.query("insert into public.aco_products(id,name,subtitle,bullets,color) values('personal','Trening','Opis','{}','#123456') on conflict(id) do update set color=excluded.color");
 await pg.exec(repair);
 assert.equal((await pg.query<any>("select color from public.aco_products where id='personal'")).rows[0].color,'#123456');
 await pg.exec('set role service_role');
 await pg.query("update public.aco_products set color='#345678' where id='personal'");
 for(const [table,cols] of [['aco_profiles','pending_email'],['aco_holds','holiday_override'],['aco_sessions','holiday_override'],['aco_earnings','settled_at,corrections'],['aco_settings','consultation_lead_hours,training_lead_hours'],['aco_hold_terms','consultation_lead_hours,training_lead_hours']])await pg.query(`select ${cols} from public.${table} limit 0`);
 for(const role of ['anon','authenticated']){await pg.exec('reset role;set role '+role);await assert.rejects(pg.query('select * from aco_private.email_changes'),/permission denied/);await assert.rejects(pg.query("update public.aco_products set color='#000000'"),/permission denied/)}
 }finally{await pg.close()}
});
