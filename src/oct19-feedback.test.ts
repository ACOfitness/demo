import {test} from 'node:test';
import assert from 'node:assert/strict';
import {seed,execute,serviceName,defaultLocation} from './domain';
import {initialDatabase} from './auth';
import {prepareAdminClient,type AdminClientInput} from './admin-client-model';
const admin={role:'admin' as const,trainerId:'',clientId:''};
const trainer={role:'trainer' as const,trainerId:'t1',clientId:''};
test('staff can correct attendance without repricing or duplicating earnings',()=>{
 let db=seed();const s=db.sessions.find(s=>s.trainerId==='t1'&&s.status==='completed')!;const earned=s.earned;
 db=execute(db,trainer,{type:'outcome',id:s.id,status:'no_show'});assert.equal(db.sessions.find(x=>x.id===s.id)!.earned,earned);
 assert.ok(db.audit.some(x=>x.text.includes('Korekta statusu')));
 db=execute(db,admin,{type:'outcome',id:s.id,status:'scheduled'});assert.equal(db.sessions.find(x=>x.id===s.id)!.earned,undefined);
 db=execute(db,trainer,{type:'outcome',id:s.id,status:'completed'});assert.equal(db.sessions.find(x=>x.id===s.id)!.earned,earned);
 assert.throws(()=>execute(db,{role:'client',clientId:s.clientId,trainerId:''},{type:'outcome',id:s.id,status:'scheduled'}));
 assert.throws(()=>execute(db,{role:'trainer',trainerId:'t2',clientId:''},{type:'outcome',id:s.id,status:'no_show'}));
});
test('reopening a session cannot take an occupied slot',()=>{
 const db=seed(),s=db.sessions.find(s=>s.status==='completed')!;
 db.sessions.push({...s,id:'collision',clientId:'c2',status:'scheduled'});
 assert.throws(()=>execute(db,admin,{type:'outcome',id:s.id,status:'scheduled'}),/zajęty/);
});
test('product name is global and unused locations can be removed safely',()=>{
 let db=seed();db.productCopies={physio:{name:'Fizjoprofilaktyka',subtitle:'Opis',bullets:[]}};
 assert.equal(serviceName('physio',db),'Fizjoprofilaktyka');
 db.locations=[defaultLocation,{id:'unused',name:'Dodatkowe',address:''}];db=execute(db,admin,{type:'deleteLocation',id:'unused'});assert.equal(db.locations!.length,1);
 assert.throws(()=>execute(db,admin,{type:'deleteLocation',id:defaultLocation.id}));
 db.locations!.push({id:'used',name:'Historia',address:''});db.sessions[0].locationId='used';assert.throws(()=>execute(db,admin,{type:'deleteLocation',id:'used'}),/historii/);
});
test('manual client paths preserve activation and do not fabricate payments',async()=>{
 const db=await initialDatabase();db.now='2026-10-19T08:00:00Z';db.trainers=[{id:'t',name:'Trener',rate:50,days:[0,1,2,3,4],hours:[10,11,12,13],products:['personal']}];
 const input:AdminClientInput={name:'Nowy Klient',email:'new@example.test',phone:'500600700',birthDate:'1990-01-01',trainerId:'t',answers:['Cel'],mode:'skip',service:'personal',intensity:2};
 let result=prepareAdminClient(db,input);assert.equal(result.client.active,false);assert.equal(result.client.invited,true);assert.equal(result.client.prescribed,true);assert.equal(result.db.sessions.length,0);assert.equal(result.db.sales.length,0);
 assert.throws(()=>prepareAdminClient(result.db,input),/adres/);
 result=prepareAdminClient(db,{...input,mode:'consultation',date:'2026-10-19',hour:12});assert.equal(result.client.invited,false);assert.equal(result.db.sessions[0].kind,'consultation');assert.equal(result.db.sales.length,0);
 assert.throws(()=>prepareAdminClient(db,{...input,mode:'consultation',date:'2026-10-19',hour:13}),/dwa kolejne/);
});
