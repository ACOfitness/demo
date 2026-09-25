import type {Account, Database} from '../src/auth';
import {actorFor} from '../src/auth';
import {canSee, endAt, dayAdd, dayIndex, dateOf, rules} from '../src/domain';
import {notifications, recipients} from '../src/management';

/** Identity must come from Auth.getUser plus a live, enabled database identity. */
export function identityAccount(db:Database, userId:string):Account {
 const account=db.accounts.find(a=>a.id===userId&&!a.disabled);
 if(!account)throw Error('Brak dostępu do konta.');
 if(account.role==='client'&&!db.clients.some(c=>c.id===account.clientId&&c.active))throw Error('Konto oczekuje na aktywację.');
 if(account.role==='trainer'&&!db.trainers.some(t=>t.id===account.trainerId&&!t.deleted))throw Error('Brak dostępu do konta.');
 return account;
}

/** Explicit allowlists: future fields must never silently become client-visible. */
function safeAccount(a:Account, own:boolean):Account {
 return {id:a.id,role:a.role,email:a.email,name:a.name,phone:own?a.phone:undefined,
 photo:a.photo,trainerId:a.trainerId,clientId:a.clientId,
 ...(own?{mustChangePassword:!!a.mustChangePassword}: {})};
}

export function projectState(source:Database,userId:string):Database {
 const me=identityAccount(source,userId),actor=actorFor(me),admin=me.role==='admin';
 const managed=new Set(source.clients.filter(c=>canSee(source,actor,c)).map(c=>c.id));
 const sessions=source.sessions.filter(s=>managed.has(s.clientId)||me.role==='trainer'&&s.trainerId===me.trainerId&&!s.substituteId&&endAt(s)<=new Date(source.now));
 const historical=new Set(sessions.map(s=>s.clientId));
 const trainers=new Set(sessions.map(s=>s.trainerId));
 for(const c of source.clients)if(managed.has(c.id))trainers.add(c.trainerId);
 if(me.trainerId)trainers.add(me.trainerId);
 // Contacts are limited to allowed recipients and existing message participants.
 const letters=(source.letters||[]).filter(m=>m.from===me.id||m.to===me.id);
 const contacts=new Set([me.id,...recipients(source,actor).map(a=>a.id)]);
 for(const m of letters){contacts.add(m.from);contacts.add(m.to)}
 const out:Database={version:1,now:source.now,
 accounts:source.accounts.filter(a=>contacts.has(a.id)).map(a=>safeAccount(a,a.id===me.id)),
 clients:source.clients.filter(c=>managed.has(c.id)||historical.has(c.id)).map(c=>managed.has(c.id)?{
 id:c.id,name:c.name,email:c.email,birthDate:c.birthDate,phone:c.phone,trainerId:c.trainerId,
 active:c.active,invited:c.invited,service:c.service,intensity:c.intensity,prescribed:c.prescribed,answers:[...c.answers],photo:c.photo
 }:{id:c.id,name:c.name,email:'',phone:'',trainerId:'',active:false,invited:false,service:c.service,intensity:0,prescribed:false,answers:[]}),
 trainers:source.trainers.filter(t=>admin||trainers.has(t.id)||!t.deleted).map(t=>{
 const own=admin||t.id===me.trainerId;
 return {id:t.id,name:t.name,photo:t.photo,deleted:t.deleted,products:t.products,
 days:[...t.days],hours:[...t.hours],weeklyHours:structuredClone(t.weeklyHours),rate:own?t.rate:0,
 ...(own?{productRates:structuredClone(t.productRates),productRateHistory:structuredClone(t.productRateHistory),rates:structuredClone(t.rates),phone:t.phone,pesel:t.pesel,student:t.student,address:t.address,taxOffice:t.taxOffice}:{})};
 }),
 sessions:sessions.map(s=>({id:s.id,clientId:s.clientId,trainerId:s.trainerId,packageId:s.packageId,date:s.date,hour:s.hour,kind:s.kind,status:s.status,
 locationId:s.locationId,consultationPrice:s.consultationPrice,publicNote:s.publicNote,privateNote:me.role==='client'?'':s.privateNote,
 comments:s.comments.map(c=>({id:c.id,author:c.author,text:c.text,at:c.at})),original:s.original,substituteId:s.substituteId,
 ...(admin||s.trainerId===me.trainerId?{rate:s.rate,earned:s.earned}:{})})),
 packages:source.packages.filter(p=>managed.has(p.clientId)).map(p=>structuredClone(p)),
 holds:source.holds.filter(h=>managed.has(h.clientId)).map(h=>structuredClone(h)),
 sales:source.sales.filter(s=>admin||me.role==='client'&&s.clientId===me.clientId).map(s=>structuredClone(s)),
 substitutions:source.substitutions.filter(s=>managed.has(s.clientId)&&s.until>source.now).map(s=>structuredClone(s)),
 blocks:occupiedSlots(source,new Set(sessions.map(s=>s.id)),new Set(source.holds.filter(h=>managed.has(h.clientId)).map(h=>h.id)),managed),
 messages:source.messages.filter(m=>notifications(source,actor).some(n=>n.id===m.id)).map(m=>structuredClone(m)),
 letters:letters.map(m=>structuredClone(m)),noticeReads:{[me.id]:[...(source.noticeReads?.[me.id]||[])]},
 locations:structuredClone(source.locations),audit:admin?structuredClone(source.audit):[],settings:structuredClone(source.settings),
 productCopies:structuredClone(source.productCopies),
 promotions:source.promotions?.filter(p=>admin||me.role==='client'&&p.kind==='email'&&p.value===me.email.toLowerCase()).map(p=>structuredClone(p)),
 extraHours:source.extraHours?.filter(h=>admin||h.trainerId===me.trainerId).map(h=>structuredClone(h))
 };
 // Ensure the actual signed-in admin is first; older UI resolves admin by role.
 out.accounts.sort((a,b)=>Number(b.id===me.id)-Number(a.id===me.id));
 return out;
}

/** Anonymous consultation picker: names/products and occupied slots only. */
export function publicState(source:Database):Database {
 return {version:1,now:source.now,accounts:[],clients:[],sessions:[],packages:[],holds:[],messages:[],sales:[],substitutions:[],audit:[],letters:[],
 trainers:source.trainers.filter(t=>!t.deleted).map(t=>({id:t.id,name:t.name,photo:t.photo,products:t.products,days:[...t.days],hours:[...t.hours],weeklyHours:structuredClone(t.weeklyHours),rate:0})),
 locations:structuredClone(source.locations),settings:structuredClone(source.settings),productCopies:structuredClone(source.productCopies),blocks:occupiedSlots(source,new Set())};
}
function occupiedSlots(source:Database,visibleSessions:Set<string>,visibleHolds=new Set<string>(),visibleClients=new Set<string>()){
 const out=source.blocks.map(b=>({...b}));
 for(const s of source.sessions)if(!visibleSessions.has(s.id)&&s.status==='scheduled')for(let h=s.hour;h<s.hour+(s.kind==='consultation'?2:1);h++)out.push({id:`busy:${s.trainerId}:${s.date}:${h}`,trainerId:s.trainerId,date:s.date,hour:h,visibility:'busy'});
 for(const h of source.holds)if(!visibleHolds.has(h.id)&&h.status==='active'&&h.expires>source.now)for(const d of h.dates)out.push({id:`busy:${h.trainerId}:${d.date}:${d.hour}`,trainerId:h.trainerId,date:d.date,hour:d.hour,visibility:'busy'});
 const today=dateOf(new Date(source.now));
 const days=visibleClients.size?366:rules(source).consultationDays+1;
 for(const p of source.packages)if(!visibleClients.has(p.clientId)&&p.protectionUntil>today){
  const trainerId=source.clients.find(c=>c.id===p.clientId)?.trainerId;if(!trainerId)continue;
  for(let n=0;n<days;n++){const date=dayAdd(today,n);if(date<p.start)continue;
   for(const slot of p.slots)if(slot.day===dayIndex(date)&&!source.sessions.some(s=>s.packageId===p.id&&((s.date===date&&s.hour===slot.hour&&s.status.startsWith('cancelled'))||s.original===`${date} ${String(slot.hour).padStart(2,'0')}:00`)))out.push({id:`protected:${trainerId}:${date}:${slot.hour}`,trainerId,date,hour:slot.hour,visibility:'busy'});
  }
 }
 return out;
}
