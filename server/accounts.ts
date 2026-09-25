import {registerAccount,addTrainer,validBirthDate,type Database} from '../src/auth';
import {actorFor} from '../src/auth';
import {execute,available,rules,dayAdd,dateOf} from '../src/domain';
import {parseRegistration,parseTrainer} from './commands';
import {relationalCommitArgs,decodeRelational as decode,type RelationalSnapshot as Snapshot} from './relational-store';
import {publicState,projectState} from './access';
export interface AccountServices {
 rpc<T>(name:string,args:Record<string,unknown>):Promise<T>;
 auth(path:string,method:string,body?:unknown,token?:string):Promise<any>;
 hash(value:string):Promise<string>;
}
export async function publicAction(body:any,req:Request,services:AccountServices){
 const {rpc,auth,hash}=services;
 if(!['publicState','register','activation'].includes(body.action))throw Error('Nieznana operacja.');
 const ip=req.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim()||'unknown';
 const limit=body.action==='publicState'?120:5;
 if(!await rpc<boolean>('aco_rate_limit',{p_key:await hash(body.action+':'+ip),p_max:limit,p_seconds:body.action==='publicState'?60:3600}))throw Error('Zbyt wiele prób. Spróbuj ponownie później.');
 const lookupEmail=body.action==='register'?parseRegistration(body.command).email:body.action==='activation'&&typeof body.email==='string'?body.email:null;
 let snapshot=await rpc<Snapshot>('aco_relational_public_load',{p_email:lookupEmail}),db=decode(snapshot);
 if(body.action==='publicState')return {accountId:'',revision:snapshot.revision,db:publicState(db)};
 if(body.action==='activation'){
  if(typeof body.email!=='string'||body.email.length>254||typeof body.birthDate!=='string')throw Error('Uzupełnij e-mail i datę urodzenia.');
  const email=body.email.trim().toLowerCase();
  if(!await rpc<boolean>('aco_rate_limit',{p_key:await hash('activation-email:'+email),p_max:3,p_seconds:3600}))return {ok:true};
  const account=db.accounts.find(a=>a.email===email&&a.role==='client'&&!a.disabled),client=db.clients.find(c=>c.id===account?.clientId);
  if(client?.invited&&client.birthDate===body.birthDate){
   // Ownership is proven by the emailed one-time link, never by birth date alone.
   await auth('/recover?redirect_to='+encodeURIComponent('https://acofitness.github.io/demo/panel.html?activation=1'),'POST',{email});
  }
  return {ok:true};
 }
 const command=parseRegistration(body.command),email=command.email.trim().toLowerCase();
 if(!await rpc<boolean>('aco_rate_limit',{p_key:await hash('register-email:'+email),p_max:3,p_seconds:86400}))return {ok:true};
 if(!validBirthDate(command.birthDate||'',db.now))throw Error('Podaj poprawną datę urodzenia.');
 if(command.date>dayAdd(dateOf(new Date(db.now)),rules(db).consultationDays)||!available(db,command.trainerId,command.date,command.hour)||!available(db,command.trainerId,command.date,command.hour+1))throw Error('Wybrany termin nie jest dostępny.');
 if(db.accounts.some(a=>a.email===email))return {ok:true};
 if(!await rpc<boolean>('aco_rate_limit',{p_key:await hash('registration-global'),p_max:60,p_seconds:3600}))throw Error('Zbyt wiele rejestracji. Spróbuj ponownie później.');
 // Validate all scheduling rules before provisioning an Auth identity.
 await registerAccount(db,command);
 const user=await auth('/admin/users','POST',{email,password:crypto.randomUUID()+crypto.randomUUID(),email_confirm:false});
 const userId=user.id;
 if(typeof userId!=='string')throw Error('Nie udało się utworzyć konta.');
 let committed=false;
 try{
  for(let attempt=0;attempt<3;attempt++){
   if(attempt){snapshot=await rpc<Snapshot>('aco_relational_public_load',{p_email:email});db=decode(snapshot)}
   const result=await registerAccount(db,command),next=result.db,client=next.clients.at(-1)!;
   const account=next.accounts.find(a=>a.clientId===client.id)!;account.id=userId;
   // Until a payment provider is integrated, registration never fabricates a paid sale.
   for(const session of next.sessions)if(session.clientId===client.id&&session.kind==='consultation')session.consultationPrice=db.settings.consultation;
   next.sales=next.sales.filter(s=>s.clientId!==client.id);
   const delta=relationalCommitArgs(db,next,userId,'register');
   try{
    await rpc('aco_relational_commit',{p_actor:userId,p_session:null,p_request:body.requestId,p_hash:await hash(JSON.stringify(command)),...delta});
    committed=true;return {ok:true};
   }catch(error){if((error as {code?:string}).code==='40001'&&attempt<2)continue;throw error}
  }
 }finally{
  // Do not delete on an uncertain network result: it may already be committed.
  // Unattached Auth users have no enabled application identity or data access.
  if(!committed){/* owner can reconcile an unattached Auth identity from the audit log */}
 }
 throw Error('Nie udało się zarezerwować konsultacji.');
}

export async function trainerAction(db:Database,body:any,userId:string,services:AccountServices){
 const me=db.accounts.find(a=>a.id===userId&&!a.disabled);
 if(me?.role!=='admin'||me.mustChangePassword)throw Error('Brak uprawnień administratora.');
 const input=parseTrainer(body.input);
 if(!input.id&&input.password.length<12)throw Error('Hasło musi mieć co najmniej 12 znaków.');
 // Auth email changes require verification and are handled through the profile flow.
 const old=input.id?db.accounts.find(a=>a.trainerId===input.id):undefined;
 if(old&&input.email.trim().toLowerCase()!==old.email)throw Error('Zmianę adresu e-mail potwierdza właściciel konta.');
 const next=await addTrainer(db,actorFor(me),input);
 const trainer=next.trainers.find(t=>t.id===(input.id||next.trainers.at(-1)!.id))!;
 const account=next.accounts.find(a=>a.trainerId===trainer.id)!;
 if(!old){
  const user=await services.auth('/admin/users','POST',{email:account.email,password:input.password,email_confirm:true});
  account.id=user.id;
 }
 delete account.password;delete account.token;
 return next;
}

export function finishActivation(db:Database,userId:string){
 const me=db.accounts.find(a=>a.id===userId&&!a.disabled),client=db.clients.find(c=>c.id===me?.clientId);
 if(me?.role!=='client'||!client?.invited||!client.prescribed)throw Error('Konto oczekuje na zatwierdzenie konsultacji.');
 return execute(db,actorFor(me),{type:'acceptInvite',id:client.id}) as Database;
}
