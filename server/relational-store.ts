import type {Database} from '../src/auth';
import {at,dateOf,defaultRules,packagePrice,rules,trainerHours,type Rules} from '../src/domain';
import {productCopy} from '../src/business';
export interface Row {table:string;key:string;data:Record<string,any>;version?:number}
export interface RelationalSnapshot {revision:number;now:string;role:string;rows:Row[];receipt?:{hash:string;revision:number}}
const ruleColumns:Record<keyof Rules,string>={renewalDays:'renewal_days',cycleWeeks:'cycle_weeks',validWeeks:'validity_weeks',coachHoldHours:'coach_hold_hours',checkoutMinutes:'checkout_minutes',protectionDays:'protection_days',consultationDays:'consultation_days',startDays:'start_days',substituteHours:'substitute_hours',freezeDays:'freeze_days'};
const money=(n:number|undefined)=>n===undefined?null:Math.round(n*100);
const iso=(value:string|null|undefined)=>value?new Date(value).toISOString():undefined;
const wall=(value:string)=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value));
const starts=(date:string,hour:number)=>at(date,hour).toISOString();
const original=(v:string|undefined)=>v?starts(v.slice(0,10),Number(v.slice(11,13))):null;
const ruleData=(r:Rules)=>Object.fromEntries(Object.entries(ruleColumns).map(([key,col])=>[col,r[key as keyof Rules]]));
const readRules=(r:Record<string,any>):Rules=>Object.fromEntries(Object.entries(ruleColumns).map(([key,col])=>[key,r[col]??defaultRules[key as keyof Rules]])) as unknown as Rules;
const sourceRows=new WeakMap<Database,Row[]>();
const group=(rows:Row[],table:string)=>rows.filter(r=>r.table===table).map(r=>r.data);
/** Every returned object is a typed row; JSON exists only as the transport format. */
export function encodeRelational(db:Database,baseline:Row[]=sourceRows.get(db)||[]):Row[]{
 const previous=(table:string,key:string)=>baseline.find(r=>r.table===table&&r.key===key)?.data;
 const out:Row[]=[];const add=(table:string,data:Record<string,any>,key=String(data.id??data.session_id??data.trainer_id))=>out.push({table,key,data});
 const accountProfile=(id:string)=>{const a=db.accounts.find(a=>a.id===id);return a?.clientId||a?.trainerId||a?.id};
 for(const a of db.accounts){
  const c=db.clients.find(c=>c.id===a.clientId),t=db.trainers.find(t=>t.id===a.trainerId),pid=a.clientId||a.trainerId||a.id;
  add('aco_profiles',{id:pid,auth_user_id:a.id,name:c?.name||t?.name||a.name||'Administrator ACO!',email:a.email,phone:c?.phone||t?.phone||a.phone||'',avatar_path:c?.photo||t?.photo||a.photo||null,must_change_password:!!a.mustChangePassword});
  add('aco_accounts',{id:a.id,profile_id:pid,role:a.role,enabled:!a.disabled});
 }
 for(const t of db.trainers){
  add('aco_trainers',{id:t.id,deleted_at:t.deleted?(previous('aco_trainers',t.id)?.deleted_at||db.now):null});
  add('aco_trainer_payroll',{trainer_id:t.id,pesel:t.pesel||null,student:!!t.student,address:t.address||'',tax_office:t.taxOffice||''});
  for(const product of t.products||['personal'])add('aco_trainer_products',{id:t.id+':'+product,trainer_id:t.id,product_id:product});
  const history=t.productRateHistory||t.rates?.map(r=>({from:r.from,personal:r.rate,physio:r.rate}))||[{from:'1900-01-01',...(t.productRates||{personal:t.rate,physio:t.rate})}];
  for(const r of history)for(const product of ['personal','physio'] as const)add('aco_trainer_rates',{id:[t.id,product,r.from].join(':'),trainer_id:t.id,product_id:product,effective_from:r.from,rate_grosz:money(r[product])});
  for(let day=0;day<7;day++)for(const hour of trainerHours(t,day))add('aco_availability',{id:[t.id,day,hour].join(':'),trainer_id:t.id,weekday:day,hour});
 }
 for(const c of db.clients){
  add('aco_clients',{id:c.id,lead_trainer_id:c.trainerId,birth_date:c.birthDate||null,status:c.active?'active':c.invited?'approved':'pending',product:c.prescribed?c.service:null,intensity:c.prescribed?c.intensity:null,approved_at:c.invited?(previous('aco_clients',c.id)?.approved_at||db.now):null});
  c.answers.forEach((answer,position)=>add('aco_client_answers',{id:c.id+':'+position,client_id:c.id,position,answer}));
 }
 for(const service of ['personal','physio']){
  const copy=productCopy(db,service);add('aco_products',{id:service,name:copy.name,subtitle:copy.subtitle,bullets:copy.bullets});
  for(const intensity of [1,2,3])add('aco_product_prices',{id:service+':'+intensity,product_id:service,intensity,amount_grosz:money(packagePrice(db,service,intensity))});
 }
 const settings={consultation_grosz:money(db.settings.consultation),personal_grosz:money(db.settings.personal),physio_grosz:money(db.settings.physio),cancellation_hours:db.settings.cancelHours,...ruleData(rules(db))};
 add('aco_settings',{id:'company',...settings});
 for(const p of db.promotions||[])add('aco_promotions',{id:p.id,kind:p.kind,value:p.value,percent:p.percent,max_uses:p.kind==='code'?p.maxUses:null,used:p.used,expires_on:p.expires||null,active:p.active});
 for(const p of db.packages){
  add('aco_packages',{id:p.id,client_id:p.clientId,product:p.service,intensity:p.intensity,count:p.count,starts_on:p.start,cycle_end:p.cycleEnd,valid_until:p.validUntil,protection_until:p.protectionUntil,price_grosz:money(p.price),base_price_grosz:money(p.basePrice??p.price),discount_percent:p.discountPercent||0,promotion_id:p.promotionId||null,frozen:!!p.frozen});
  for(const s of p.slots)add('aco_package_slots',{id:p.id+':'+s.day,package_id:p.id,weekday:s.day,hour:s.hour});
 }
 for(const h of db.holds){
  add('aco_holds',{id:h.id,client_id:h.clientId,trainer_id:h.trainerId,product_id:h.service,intensity:h.intensity,starts_on:h.start,expires_at:iso(h.expires),price_grosz:money(h.price),status:h.status,kind:h.type,payment_requested_at:iso(h.paymentRequest?.at)||null,promotion_code:h.paymentRequest?.code??null});
  for(const d of h.dates)add('aco_hold_dates',{id:[h.id,d.date,d.hour].join(':'),hold_id:h.id,starts_at:starts(d.date,d.hour),original_starts_at:original(d.original)});
  for(const s of h.slots)add('aco_hold_slots',{id:h.id+':'+s.day,hold_id:h.id,weekday:s.day,hour:s.hour});
  add('aco_hold_terms',{id:h.id,hold_id:h.id,...ruleData(h.terms||defaultRules)});
 }
 for(const s of db.substitutions)add('aco_substitutions',{id:s.id,client_id:s.clientId,trainer_id:s.trainerId,expires_at:iso(s.until),revoked_at:null});
 for(const s of db.sessions){
  const start=starts(s.date,s.hour);add('aco_sessions',{id:s.id,client_id:s.clientId,trainer_id:s.trainerId,substitution_id:s.substituteId||null,package_id:s.packageId||null,kind:s.kind,starts_at:start,ends_at:new Date(+new Date(start)+(s.kind==='consultation'?90:60)*60000).toISOString(),status:s.status,original_starts_at:original(s.original),consultation_grosz:money(s.consultationPrice)});
  if(s.earned!==undefined)add('aco_earnings',{id:s.id,trainer_id:s.trainerId,session_id:s.id,kind:s.kind,hours:s.kind==='consultation'?1.5:1,rate_grosz:money(s.rate||0),amount_grosz:money(s.earned),month:s.date.slice(0,7)+'-01',description:''});
  add('aco_public_notes',{session_id:s.id,body:s.publicNote});add('aco_trainer_notes',{session_id:s.id,body:s.privateNote});
  for(const c of s.comments)add('aco_comments',{id:c.id,session_id:s.id,author_label:c.author,body:c.text,created_at:iso(c.at)});
 }
 for(const b of db.blocks)if(!b.id.startsWith('busy:')&&!b.id.startsWith('protected:'))add('aco_blackouts',{id:b.id,trainer_id:b.trainerId,starts_at:starts(b.date,b.hour),visibility:b.visibility||'busy'});
 for(const s of db.sales)add('aco_sales',{id:s.id,client_id:s.clientId,package_id:s.packageId||null,session_id:s.sessionId||null,label:s.label,amount_grosz:money(s.amount),status:s.status,settled_at:iso(s.date)});
 for(const h of db.extraHours||[])add('aco_earnings',{id:h.id,trainer_id:h.trainerId,session_id:null,kind:'company',hours:h.hours,rate_grosz:money(h.rate),amount_grosz:money(h.amount),month:h.month+'-01',description:h.description});
 for(const m of db.letters||[])add('aco_messages',{id:m.id,sender_id:accountProfile(m.from),recipient_id:accountProfile(m.to),subject:m.subject,body:m.body,created_at:iso(m.at),read_at:m.read?(previous('aco_messages',m.id)?.read_at||iso(db.now)):null});
 for(const m of db.messages)add('aco_events',{id:m.id,client_id:m.clientId||null,title:m.title,body:m.body,audience:m.target,created_at:iso(m.at)});
 for(const a of db.audit)add('aco_activity',{id:a.id,description:a.text,created_at:iso(a.at)});
 for(const [account,notices] of Object.entries(db.noticeReads||{}))for(const notice of notices){const profile=accountProfile(account);if(profile)add('aco_notice_reads',{id:profile+':'+notice,profile_id:profile,notice_id:notice})}
 return out;
}
export function decodeRelational(snapshot:RelationalSnapshot):Database{
 const rows=snapshot.rows,get=(table:string)=>group(rows,table),profiles=get('aco_profiles'),accounts=get('aco_accounts');
 const profile=(id:string)=>profiles.find(p=>p.id===id)||get('aco_trainer_directory').find(p=>p.id===id)||{};
 const accountId=(profileId:string)=>accounts.find(a=>a.profile_id===profileId)?.id||profileId;
 const setting=get('aco_settings')[0]||{};
 const db:Database={version:1,now:new Date(snapshot.now).toISOString(),accounts:[],clients:[],trainers:[],sessions:[],packages:[],holds:[],messages:[],sales:[],substitutions:[],audit:[],blocks:[],letters:[],noticeReads:{},promotions:[],extraHours:[],productCopies:{},settings:{personal:(setting.personal_grosz??18000)/100,physio:(setting.physio_grosz??22000)/100,consultation:(setting.consultation_grosz??25000)/100,cancelHours:setting.cancellation_hours??24,rules:readRules(setting),packagePrices:{personal:{},physio:{}}}};
 for(const a of accounts){const p=profile(a.profile_id);db.accounts.push({id:a.id,email:p.email||'',name:p.name,phone:p.phone,photo:p.avatar_path||undefined,role:a.role,disabled:!a.enabled,mustChangePassword:!!p.must_change_password,...(a.role==='client'?{clientId:a.profile_id}:a.role==='trainer'?{trainerId:a.profile_id}:{})})}
 for(const t of get('aco_trainers')){
  const p=profile(t.id),pay=get('aco_trainer_payroll').find(r=>r.trainer_id===t.id)||{},availability=get('aco_availability').filter(r=>r.trainer_id===t.id),rates=get('aco_trainer_rates').filter(r=>r.trainer_id===t.id);
  const history=[...new Set(rates.map(r=>r.effective_from))].sort().map(from=>({from,personal:(rates.find(r=>r.effective_from===from&&r.product_id==='personal')?.rate_grosz||0)/100,physio:(rates.find(r=>r.effective_from===from&&r.product_id==='physio')?.rate_grosz||0)/100}));
  const effective=history.filter(r=>r.from<=dateOf(new Date(db.now))).at(-1)||{personal:0,physio:0};
  db.trainers.push({id:t.id,name:p.name||'',photo:p.avatar_path||undefined,deleted:!!t.deleted_at,days:[...new Set(availability.map(r=>r.weekday))].sort(),hours:[...new Set(availability.map(r=>r.hour))].sort((a,b)=>a-b),weeklyHours:Object.fromEntries(Array.from({length:7},(_,day)=>[day,availability.filter(r=>r.weekday===day).map(r=>r.hour).sort((a,b)=>a-b)])),products:get('aco_trainer_products').filter(r=>r.trainer_id===t.id).map(r=>r.product_id),productRateHistory:history,productRates:{personal:effective.personal,physio:effective.physio},rate:effective.personal,phone:p.phone||'',pesel:pay.pesel||'',student:!!pay.student,address:pay.address||'',taxOffice:pay.tax_office||''});
 }
 for(const c of get('aco_clients')){const p=profile(c.id);db.clients.push({id:c.id,name:p.name||'',email:p.email||'',phone:p.phone||'',photo:p.avatar_path||undefined,birthDate:c.birth_date,trainerId:c.lead_trainer_id,active:c.status==='active',invited:['approved','active'].includes(c.status),service:c.product||db.trainers.find(t=>t.id===c.lead_trainer_id)?.products?.[0]||'personal',intensity:c.intensity||2,prescribed:!!c.product,answers:get('aco_client_answers').filter(r=>r.client_id===c.id).sort((a,b)=>a.position-b.position).map(r=>r.answer)})}
 for(const p of get('aco_products'))db.productCopies![p.id]={name:p.name,subtitle:p.subtitle,bullets:p.bullets};
 for(const p of get('aco_product_prices'))db.settings.packagePrices![p.product_id][p.intensity]=p.amount_grosz/100;
 for(const p of get('aco_promotions'))db.promotions!.push({id:p.id,kind:p.kind,value:p.value,percent:Number(p.percent),maxUses:p.max_uses||0,used:p.used,expires:p.expires_on||'',active:p.active});
 for(const p of get('aco_packages'))db.packages.push({id:p.id,clientId:p.client_id,service:p.product,intensity:p.intensity,count:p.count,start:p.starts_on,cycleEnd:p.cycle_end,validUntil:p.valid_until,protectionUntil:p.protection_until,price:p.price_grosz/100,basePrice:p.base_price_grosz/100,discountPercent:Number(p.discount_percent),promotionId:p.promotion_id||undefined,frozen:p.frozen,slots:get('aco_package_slots').filter(s=>s.package_id===p.id).map(s=>({day:s.weekday,hour:s.hour}))});
 for(const h of get('aco_holds'))db.holds.push({id:h.id,clientId:h.client_id,trainerId:h.trainer_id,service:h.product_id,intensity:h.intensity,start:h.starts_on,expires:iso(h.expires_at)!,price:h.price_grosz/100,status:h.status,type:h.kind,terms:readRules(get('aco_hold_terms').find(t=>t.hold_id===h.id)||{}),dates:get('aco_hold_dates').filter(d=>d.hold_id===h.id).map(d=>({date:wall(d.starts_at).slice(0,10),hour:Number(wall(d.starts_at).slice(11,13)),original:d.original_starts_at?wall(d.original_starts_at):undefined})),slots:get('aco_hold_slots').filter(s=>s.hold_id===h.id).map(s=>({day:s.weekday,hour:s.hour})),paymentRequest:h.payment_requested_at?{at:iso(h.payment_requested_at)!,code:h.promotion_code||''}:undefined});
 for(const s of get('aco_substitutions'))if(!s.revoked_at)db.substitutions.push({id:s.id,clientId:s.client_id,trainerId:s.trainer_id,until:iso(s.expires_at)!});
 for(const s of get('aco_sessions')){const earning=get('aco_earnings').find(e=>e.session_id===s.id);db.sessions.push({id:s.id,clientId:s.client_id,trainerId:s.trainer_id,packageId:s.package_id||undefined,substituteId:s.substitution_id||undefined,kind:s.kind,status:s.status,date:wall(s.starts_at).slice(0,10),hour:Number(wall(s.starts_at).slice(11,13)),original:s.original_starts_at?wall(s.original_starts_at):undefined,consultationPrice:s.consultation_grosz==null?undefined:s.consultation_grosz/100,rate:earning?earning.rate_grosz/100:undefined,earned:earning?earning.amount_grosz/100:undefined,publicNote:get('aco_public_notes').find(n=>n.session_id===s.id)?.body||'',privateNote:get('aco_trainer_notes').find(n=>n.session_id===s.id)?.body||'',comments:get('aco_comments').filter(c=>c.session_id===s.id).map(c=>({id:c.id,author:c.author_label||profile(c.author_id).name||'',text:c.body,at:iso(c.created_at)!}))})}
 for(const b of get('aco_blackouts'))db.blocks.push({id:b.id,trainerId:b.trainer_id,date:wall(b.starts_at).slice(0,10),hour:Number(wall(b.starts_at).slice(11,13)),visibility:b.visibility});
 for(const b of get('aco_busy_slots'))db.blocks.push({id:'busy:'+b.trainer_id+':'+b.starts_at,trainerId:b.trainer_id,date:wall(b.starts_at).slice(0,10),hour:Number(wall(b.starts_at).slice(11,13)),visibility:'busy'});
 for(const s of get('aco_sales'))db.sales.push({id:s.id,clientId:s.client_id,packageId:s.package_id||undefined,sessionId:s.session_id||undefined,label:s.label,amount:s.amount_grosz/100,status:s.status,date:iso(s.settled_at)!});
 for(const e of get('aco_earnings'))if(e.kind==='company')db.extraHours!.push({id:e.id,trainerId:e.trainer_id,month:e.month.slice(0,7),hours:Number(e.hours),rate:e.rate_grosz/100,amount:e.amount_grosz/100,description:e.description});
 for(const m of get('aco_messages'))db.letters!.push({id:m.id,from:accountId(m.sender_id),to:accountId(m.recipient_id),fromName:profile(m.sender_id).name||'',toName:profile(m.recipient_id).name||'',subject:m.subject,body:m.body,at:iso(m.created_at)!,read:!!m.read_at});
 for(const m of get('aco_events'))db.messages.push({id:m.id,clientId:m.client_id||undefined,title:m.title,body:m.body,target:m.audience,at:iso(m.created_at)!,read:false});
 for(const r of get('aco_notice_reads'))(db.noticeReads![accountId(r.profile_id)]??=[]).push(r.notice_id);
 for(const a of get('aco_activity'))db.audit.push({id:a.id,text:a.description,at:iso(a.created_at)!});
 db.holds.sort((a,b)=>b.expires.localeCompare(a.expires));db.messages.sort((a,b)=>b.at.localeCompare(a.at));db.audit.sort((a,b)=>b.at.localeCompare(a.at));db.letters!.sort((a,b)=>b.at.localeCompare(a.at));
 sourceRows.set(db,rows);return db;
}
/** Compare canonical projections, not database defaults or timestamp spelling. */
export function relationalChanges(before:Database,after:Database){
 const baseline=sourceRows.get(before)||[],versions=new Map(baseline.map(r=>[r.table+':'+r.key,r.version]));
 const old=new Map(encodeRelational(before,baseline).map(r=>[r.table+':'+r.key,r]));
 const changes:Row[]=[],removed:Pick<Row,'table'|'key'|'version'>[]=[];
 for(const r of encodeRelational(after,baseline)){
  const k=r.table+':'+r.key,prior=old.get(k);
  if(JSON.stringify(prior?.data)!==JSON.stringify(r.data))changes.push({...r,version:versions.get(k)});
  old.delete(k);
 }
 for(const [key,r] of old)if(versions.has(key))removed.push({table:r.table,key:r.key,version:versions.get(key)});
 return {changes,removed};
}

/** Lock just the aggregates involved in a command, not unrelated customers. */
export function relationalCommitArgs(before:Database,after:Database,actorId:string,action:string){
 const delta=relationalChanges(before,after),baseline=sourceRows.get(before)||[];
 const clients=new Set<string>(),trainers=new Set<string>();
 for(const r of [...delta.changes,...delta.removed]){
  const data:Record<string,any>=('data' in r?r.data as Record<string,any>:baseline.find(b=>b.table===r.table&&b.key===r.key)?.data)||{};
  if(r.table==='aco_clients')clients.add(r.key);
  if(data.client_id)clients.add(data.client_id);
  if(r.table==='aco_trainers')trainers.add(r.key);
  if(data.trainer_id)trainers.add(data.trainer_id);
  if(data.package_id){const p=after.packages.find(p=>p.id===data.package_id)||before.packages.find(p=>p.id===data.package_id);if(p)clients.add(p.clientId)}
  if(data.hold_id){const h=after.holds.find(h=>h.id===data.hold_id)||before.holds.find(h=>h.id===data.hold_id);if(h){clients.add(h.clientId);trainers.add(h.trainerId)}}
  if(data.session_id){const s=after.sessions.find(s=>s.id===data.session_id)||before.sessions.find(s=>s.id===data.session_id);if(s){clients.add(s.clientId);trainers.add(s.trainerId)}}
 }
 for(const db of [before,after])for(const c of db.clients)if(clients.has(c.id)&&c.trainerId)trainers.add(c.trainerId);
 const actor=before.accounts.find(a=>a.id===actorId),profile=actor?.clientId||actor?.trainerId||actorId;
 const calendar=['register','hold','editHold','payHold','makeup','reschedule','outcome','substitute','transferClient','block','unblock','freeze','validity','extend','availability'].includes(action);
 const dependencies=baseline.filter(r=>r.table==='aco_accounts'&&r.key===actorId||r.table==='aco_profiles'&&r.key===profile||r.table==='aco_clients'&&clients.has(r.key)||r.table==='aco_trainers'&&trainers.has(r.key)||calendar&&['aco_settings','aco_product_prices','aco_promotions'].includes(r.table)).map(({table,key,version})=>({table,key,version}));
 return {p_changes:delta.changes,p_removed:delta.removed,p_dependencies:dependencies,p_clients:[...clients].sort(),p_trainers:[...trainers].sort(),p_role:actor?.role||'registration',p_action:action};
}
