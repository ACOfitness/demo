import type {Database} from './auth';
import {validBirthDate} from './auth';
import {validPhone} from './validation';
import {available,bookingLeadAllowed,defaultLocation,execute,uid} from './domain';
export interface AdminClientInput {name:string;email:string;phone:string;birthDate:string;trainerId:string;answers:string[];mode:'consultation'|'skip';date?:string;hour?:number;service?:'personal'|'physio';intensity?:number}
export function prepareAdminClient(source:Database,input:AdminClientInput){
 const email=input.email.trim().toLowerCase(),trainer=source.trainers.find(t=>t.id===input.trainerId&&!t.deleted);
 if(!trainer||!input.name.trim()||!/^\S+@\S+\.\S+$/.test(email)||!validPhone(input.phone)||!validBirthDate(input.birthDate,source.now))throw Error('Sprawdź dane klienta i wybierz trenera.');
 if(source.accounts.some(a=>a.email.toLowerCase()===email)||source.clients.some(c=>c.email.toLowerCase()===email))throw Error('Ten adres jest już przypisany do klienta. Otwórz jego profil.');
 if(input.mode==='consultation'){
  if(!input.date||input.hour===undefined||!bookingLeadAllowed(source,'consultation',input.date,input.hour,'admin')||!available(source,trainer.id,input.date,input.hour)||!available(source,trainer.id,input.date,input.hour+1))throw Error('Wybierz dwa kolejne wolne bloki na konsultację.');
 }else if(!input.service||!trainer.products?.includes(input.service)||![1,2,3].includes(input.intensity||0))throw Error('Wybierz produkt trenera i częstotliwość treningów.');
 const db=execute(source,{role:'admin',trainerId:'',clientId:''},{type:'manualClient',name:input.name,email,phone:input.phone,trainerId:trainer.id}) as Database;
 const client=db.clients.at(-1)!;client.birthDate=input.birthDate;client.answers=input.answers;
 if(input.mode==='consultation')db.sessions.push({id:uid(),clientId:client.id,trainerId:trainer.id,locationId:trainer.locationId||defaultLocation.id,date:input.date!,hour:input.hour!,kind:'consultation',status:'scheduled',consultationPrice:db.settings.consultation,publicNote:'',privateNote:'',comments:[]});
 else {client.service=input.service!;client.intensity=input.intensity!;client.prescribed=true;client.invited=true;db.audit.unshift({id:uid(),at:db.now,text:'Administrator pominął konsultację i zatwierdził aktywację: '+client.name});}
 return {db,client};
}
