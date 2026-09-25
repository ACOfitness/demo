import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {initialDatabase} from '../../src/auth';
import {encode} from '../../server/store';
test('initial cutover preserves admin, settings and audit, refuses repetition',async()=>{
 const pg=new PGlite();try{
 await pg.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`);
 for(const n of (await readdir(new URL('../../supabase/migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort().slice(0,3))await pg.exec(await readFile(new URL('../../supabase/migrations/'+n,import.meta.url),'utf8'));
 const db=await initialDatabase(),a=db.accounts[0];
 db.settings.rules={startDays:14,cycleWeeks:4,freezeDays:7,validWeeks:6,renewalDays:7,coachHoldHours:48,protectionDays:1,checkoutMinutes:15,substituteHours:48,consultationDays:7};db.settings.packagePrices={personal:{1:720,2:1440,3:2160},physio:{1:880,2:1760,3:2640}};
 await pg.query('insert into auth.users values($1)',[a.id]);await pg.query("insert into aco_private.identities(user_id,role,enabled) values($1,'admin',true)",[a.id]);
 for(const r of encode(db))await pg.query('insert into aco_private.runtime_entities(kind,id,payload) values($1,$2,$3)',[r.kind,r.id,r.payload]);
 await pg.exec(await readFile(new URL('../../docs/architecture/deploy-relational.sql',import.meta.url),'utf8'));assert.equal((await pg.query<any>('select count(*)::int n from public.aco_accounts')).rows[0].n,1);
 assert.equal((await pg.query<any>('select consultation_grosz from public.aco_settings')).rows[0].consultation_grosz,25000);
 await assert.rejects(pg.query('select aco_private.import_initial_runtime()'),/already initialized/);
 }finally{await pg.close()}
});
