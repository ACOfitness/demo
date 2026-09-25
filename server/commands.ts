import {quote} from '../src/business';
import type {Database} from '../src/auth';
import {actorFor} from '../src/auth';
import {execute, type Command, defaultRules,uid} from '../src/domain';
import {manage, managementTypes} from '../src/management';
import {identityAccount} from './access';

type Check=(value:unknown)=>boolean;
const text=(max:number,min=0):Check=>v=>typeof v==='string'&&v.length>=min&&v.length<=max;
const number=(min:number,max:number,integer=false):Check=>v=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max&&(!integer||Number.isInteger(v));
const choice=(...values:unknown[]):Check=>v=>values.includes(v);
const optional=(check:Check):Check=>v=>v===undefined||check(v);
const array=(check:Check,max:number):Check=>v=>Array.isArray(v)&&v.length<=max&&v.every(check);
const object=(fields:Record<string,Check>):Check=>v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).every(k=>Object.hasOwn(fields,k))&&Object.entries(fields).every(([k,check])=>check((v as Record<string,unknown>)[k]));
const id=text(100,1),day=number(0,6,true),hour=number(0,23,true),service=choice('personal','physio');
const date:Check=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&v>='1900-01-01'&&v<='2200-12-31'&&Number.isFinite(Date.parse(v+'T12:00:00Z'))&&new Date(v+'T12:00:00Z').toISOString().slice(0,10)===v;
const dates=array(object({date,hour,original:optional(text(100))}),156);
const rules=object(Object.fromEntries(Object.keys(defaultRules).map(k=>[k,number(1,k.endsWith('Weeks')?52:366,true)])));
const prices=object({'1':number(.01,1000000),'2':number(.01,1000000),'3':number(.01,1000000)});
const photo:Check=v=>typeof v==='string'&&(v===''||v.length<=2900000&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v));
const fields:Record<string,Record<string,Check>>={
 saveLocation:{id,name:text(200,1),address:text(500)},sessionLocation:{id,locationId:id},
 updateProfile:{name:text(200,1),email:text(254,3),phone:text(40),photo},
 availability:{trainerId:id,days:array(day,7),hours:array(hour,24),weeklyHours:optional(object(Object.fromEntries(Array.from({length:7},(_,i)=>[String(i),optional(array(hour,24))]))))},
 requestPayment:{id,code:optional(text(100))},confirmConsultation:{id},
 transferClient:{clientId:id,trainerId:id},deleteTrainer:{id},birthDate:{id,value:date},
 sendLetter:{to:id,subject:text(200,1),body:text(20000,1)},readLetter:{id},readNotice:{id},
 outcome:{id,status:choice('completed','no_show','cancelled_early','cancelled_late','cancelled_trainer')},
 notes:{id,publicNote:text(20000),privateNote:text(20000)},comment:{id,text:text(10000,1)},reschedule:{id,date,hour},
 activate:{id,service,intensity:number(1,3,true)},
 hold:{clientId:id,start:date,slots:array(object({day,hour}),3),dates},payHold:{id,code:optional(text(100))},
 editHold:{id,dates},makeup:{packageId:id,date,hour},substitute:{clientId:id,trainerId:id,from:date,to:date},
 extend:{packageId:id,days:number(1,366,true)},validity:{packageId:id,date},freeze:{packageId:id},
 block:{trainerId:id,date,hour,visibility:optional(choice('busy','hidden'))},unblock:{id},
 settings:{personal:number(.01,1000000),physio:number(.01,1000000),consultation:number(.01,1000000),cancelHours:number(1,8760,true),rules:optional(rules),packagePrices:optional(object({personal:prices,physio:prices}))},
 rate:{trainerId:id,rate:number(.01,1000000)},
 productCopy:{service,copy:object({name:text(200,1),subtitle:text(2000,1),bullets:array(text(1000,1),20)})},
 promotion:{promotion:object({kind:choice('email','code'),value:text(254,1),percent:number(1,100),maxUses:number(0,1000000,true),expires:v=>v===''||date(v),active:choice(true,false)})},
 disablePromotion:{id},extraHours:{trainerId:id,month:v=>typeof v==='string'&&/^20\d\d-(0[1-9]|1[0-2])$/.test(v),hours:number(.01,744),rate:number(.01,1000000),description:text(2000,1)}
};

export function parseCommand(value:unknown):Command {
 if(!value||typeof value!=='object'||!('type' in value)||typeof value.type!=='string'||!Object.hasOwn(fields,value.type)||!object({type:choice(value.type),...fields[value.type]})(value))throw Error('Nieprawidłowa operacja lub dane formularza.');
 return structuredClone(value) as Command;
}

/** Called only with database state and time loaded by the server, never client state. */
export function applyCommand(source:Database,userId:string,input:unknown,serverNow:string):Database {
 if(!Number.isFinite(Date.parse(serverNow)))throw Error('Nieprawidłowy czas serwera.');
 const db=structuredClone(source);db.now=new Date(serverNow).toISOString();
 const me=identityAccount(db,userId);
 if(me.mustChangePassword)throw Error('Najpierw zmień hasło tymczasowe.');
 const cmd=parseCommand(input);
 // Client-supplied "payment complete" can never create paid entries.
 if(cmd.type==='payHold'&&me.role!=='admin')throw Error('Opłatę może potwierdzić wyłącznie administrator.');
 // Bind the legacy management engine to the verified account, including multi-admin teams.
 db.accounts.sort((a,b)=>Number(b.id===userId)-Number(a.id===userId));
 const actor=actorFor(me);
 if(cmd.type==='requestPayment'){
  const hold=db.holds.find(h=>h.id===cmd.id&&h.clientId===me.clientId&&h.status==='active'&&h.expires>db.now);
  if(me.role!=='client'||!hold)throw Error('Rezerwacja jest niedostępna.');
  quote(db,hold.clientId,hold.service,hold.intensity,cmd.code);
  hold.paymentRequest={code:cmd.code||'',at:db.now};
  db.messages.unshift({id:uid(),title:'Prośba o rozliczenie pakietu',body:`${db.clients.find(c=>c.id===hold.clientId)?.name} · oczekuje na potwierdzenie wpłaty.`,at:db.now,target:'admin',read:false});
  return db;
 }
 if(cmd.type==='confirmConsultation'){
  if(me.role!=='admin')throw Error('Opłatę potwierdza administrator.');
  const session=db.sessions.find(s=>s.id===cmd.id&&s.kind==='consultation');
  if(!session||db.sales.some(s=>s.id==='consultation:'+session.id))throw Error('Konsultacja została już rozliczona lub nie istnieje.');
  db.sales.push({id:'consultation:'+session.id,sessionId:session.id,clientId:session.clientId,label:'Konsultacja',amount:session.consultationPrice??db.settings.consultation,date:db.now,status:'paid'});
  return db;
 }
 if(cmd.type==='payHold')cmd.code=cmd.code||db.holds.find(h=>h.id===cmd.id)?.paymentRequest?.code;

 return (managementTypes.includes(cmd.type)?manage(db,actor,cmd):execute(db,actor,cmd)) as Database;
}

export function parseRegistration(value:unknown):Extract<Command,{type:'register'}>{
 if(!object({type:choice('register'),name:text(200,1),email:text(254,3),birthDate:date,phone:text(40,1),trainerId:id,date,hour,answers:array(text(2000),20)})(value))throw Error('Uzupełnij poprawnie formularz konsultacji.');
 return structuredClone(value) as Extract<Command,{type:'register'}>;
}
export function parseTrainer(value:unknown):import('../src/auth').TrainerInput {
 if(!object({id:optional(id),name:text(200,1),email:text(254,3),products:array(service,2),productRates:object({personal:number(0,1000000),physio:number(0,1000000)}),days:array(day,7),hours:array(hour,24),password:text(200),phone:text(40),pesel:text(11),student:choice(true,false),address:text(500),taxOffice:text(200),photo})(value))throw Error('Nieprawidłowe dane trenera.');
 return structuredClone(value) as import('../src/auth').TrainerInput;
}
