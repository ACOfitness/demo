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
 credentialProof(value:string):Promise<string>;
}
export async function publicAction(body:any,req:Request,services:AccountServices){
 const {rpc,auth,hash,credentialProof}=services;
 if(!['publicState','register','activation'].includes(body.action))throw Error('Nieznana operacja.');
 const ip=req.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim()||'unknown';
 const phase=body.action==='activation'?(body.password===undefined?'verify':'save'):body.action;
 const limit=body.action==='publicState'?120:60;
 if(!await rpc<boolean>('aco_rate_limit',{p_key:await hash(body.action+':'+phase+':'+ip),p_max:limit,p_seconds:body.action==='publicState'?60:3600}))throw Error('Zbyt wiele prób. Spróbuj ponownie później.');
 if(body.action==='register'&&await rpc<boolean>('aco_registration_receipt',{p_request:body.requestId,p_hash:await hash(JSON.stringify(parseRegistration(body.command)))}))return {ok:true};
 const lookupEmail=body.action==='register'?parseRegistration(body.command).email:body.action==='activation'&&typeof body.email==='string'?body.email:null;
 let snapshot=await rpc<Snapshot>('aco_relational_public_load',{p_email:lookupEmail}),db=decode(snapshot);
 if(body.action==='publicState')return {accountId:'',revision:snapshot.revision,db:publicState(db)};
 if(body.action==='activation'){
  if(typeof body.email!=='string'||body.email.length>254||typeof body.birthDate!=='string'||!validBirthDate(body.birthDate,db.now))throw Error('Uzupełnij e-mail i datę urodzenia.');
  const email=body.email.trim().toLowerCase();
  if(!await rpc<boolean>('aco_rate_limit',{p_key:await hash('activation-email:'+phase+':'+email),p_max:8,p_seconds:3600}))throw Error('Zbyt wiele prób. Spróbuj ponownie później.');
  const account=db.accounts.find(a=>a.email===email&&a.role==='client'&&!a.disabled),client=db.clients.find(c=>c.id===account?.clientId);
  if(!account||!client?.invited||!client.prescribed||client.active||client.birthDate!==body.birthDate)throw Error('Nie można aktywować konta. Sprawdź dane i zatwierdzenie konsultacji. Jeśli konto jest już aktywne, przejdź do logowania.');
  if(body.password===undefined)return {ok:true};
  if(typeof body.password!=='string'||body.password.length<12||body.password.length>200)throw Error('Hasło musi mieć od 12 do 200 znaków.');
  // A secret-key proof binds retries to the first password without storing it.
  const proof=await credentialProof(email+'\0'+body.password),attemptId=crypto.randomUUID();
  const claim=await rpc<{userId:string;requestId:string;fresh:boolean;canWrite:boolean}>('aco_claim_activation_retry',{p_email:email,p_birth_date:body.birthDate,p_request:body.requestId,p_proof:proof,p_attempt:attemptId});
  try{
   let saved=false;
   if(!claim.fresh){try{const session=await auth('/token?grant_type=password','POST',{email,password:body.password});saved=session.user?.id===claim.userId}catch{/* Auth may not have received the first write. */}}
   if(!saved){
    if(!claim.canWrite)throw Error('Aktywacja jest w toku. Ponów próbę za dwie minuty z tym samym hasłem.');
    try{await auth('/admin/users/'+claim.userId,'PUT',{password:body.password,email_confirm:true})}
    catch(error){
     // A received rejection is definitive; an uncertain network result retains the lease.
     if((error as {status?:number}).status&&Number((error as {status:number}).status)<500)await rpc('aco_release_activation_attempt',{p_user:claim.userId,p_attempt:attemptId});
     throw error;
    }
   }
   await rpc('aco_complete_activation',{p_user:claim.userId,p_request:claim.requestId});
  }catch{throw Error('Nie udało się dokończyć aktywacji. Ponów próbę za dwie minuty z tym samym hasłem. Jeśli problem pozostanie, skontaktuj się z administratorem.');}
  return {ok:true};
 }
 const command=parseRegistration(body.command),email=command.email.trim().toLowerCase();
 if(!await rpc<boolean>('aco_rate_limit',{p_key:await hash('register-email:'+email),p_max:12,p_seconds:3600}))throw Error('Nie zapisano konsultacji: zbyt wiele prób dla tego adresu. Skontaktuj się z administratorem.');
 if(!validBirthDate(command.birthDate||'',db.now))throw Error('Podaj poprawną datę urodzenia.');
 if(command.date>dayAdd(dateOf(new Date(db.now)),rules(db).consultationDays)||!available(db,command.trainerId,command.date,command.hour)||!available(db,command.trainerId,command.date,command.hour+1))throw Error('Wybrany termin nie jest dostępny.');
 if(db.accounts.some(a=>a.email===email))throw Error('Nie zapisano nowej konsultacji. Sprawdź wcześniejsze zgłoszenie lub skontaktuj się z administratorem.');
 if(!await rpc<boolean>('aco_rate_limit',{p_key:await hash('registration-global'),p_max:60,p_seconds:3600}))throw Error('Zbyt wiele rejestracji. Spróbuj ponownie później.');
 // Validate all scheduling rules before provisioning an Auth identity.
 await registerAccount(db,command);
 const registrationHash=await hash(JSON.stringify(command));
 const recover=()=>rpc<string|null>('aco_registration_identity',{p_request:body.requestId,p_hash:registrationHash,p_email:email});
 let userId=await recover();
 if(!userId){
  try{const user=await auth('/admin/users','POST',{email,password:crypto.randomUUID()+crypto.randomUUID(),email_confirm:false,app_metadata:{aco_registration:{requestId:body.requestId,hash:registrationHash}}});userId=user.id}
  catch(error){userId=await recover();if(!userId)throw error}
 }
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
 // Login changes use the separate administrator confirmation workflow.
 const old=input.id?db.accounts.find(a=>a.trainerId===input.id):undefined;
 if(old&&input.email.trim().toLowerCase()!==old.email)throw Error('Użyj osobnej opcji zmiany e-maila i loginu.');
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

