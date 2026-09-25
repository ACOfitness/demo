import {quote} from '../src/business';
import {canSee} from '../src/domain';
import {publicAction,trainerAction} from './accounts';
import {applyCommand} from './commands';
import {identityAccount,projectState,publicState} from './access';
import {relationalCommitArgs,decodeRelational as decode,type RelationalSnapshot as Snapshot} from './relational-store';

interface Config {url:string;serviceKey:string;origins:string[]}
interface Identity {id:string;sessionId:string;email?:string}
class ApiError extends Error {constructor(public status:number,message:string,public code?:string){super(message)}}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash=async(v:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v))),b=>b.toString(16).padStart(2,'0')).join('');

export function createHandler(config:Config,fetcher:typeof fetch=fetch){
 async function rpc<T>(name:string,args:Record<string,unknown>):Promise<T>{
  const result=await fetcher(config.url+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:config.serviceKey,Authorization:'Bearer '+config.serviceKey,'Content-Type':'application/json'},body:JSON.stringify(args)});
  const data=await result.json();
  if(!result.ok)throw new ApiError(data.code==='40001'?409:403,'Nie udało się zapisać operacji.',data.code);
  return data as T;
 }
 async function auth(path:string,method:string,body?:unknown,token?:string){
  const response=await fetcher(config.url+'/auth/v1'+path,{method,headers:{apikey:config.serviceKey,Authorization:'Bearer '+(token||config.serviceKey),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  if(!response.ok)throw new ApiError(422,'Nie udało się zapisać danych konta.');
  return response.status===204?{}:response.json();
 }
 const services={rpc,auth,hash};
 async function authenticate(req:Request):Promise<Identity>{
  const authorization=req.headers.get('Authorization')||'';
  if(!/^Bearer [A-Za-z0-9_.-]+$/.test(authorization)||authorization.length>10000)throw new ApiError(401,'Zaloguj się ponownie.');
  // Online Auth validation comes BEFORE inspecting any JWT claims.
  const response=await fetcher(config.url+'/auth/v1/user',{headers:{apikey:config.serviceKey,Authorization:authorization}});
  if(!response.ok)throw new ApiError(401,'Zaloguj się ponownie.');
  const user=await response.json();
  let claims;try{claims=JSON.parse(atob(authorization.slice(7).split('.')[1].replace(/-/g,'+').replace(/_/g,'/')))}catch{throw new ApiError(401,'Zaloguj się ponownie.')}
  if(!uuid.test(user.id)||claims.sub!==user.id||!uuid.test(claims.session_id))throw new ApiError(401,'Zaloguj się ponownie.');
  return {id:user.id,sessionId:claims.session_id,email:user.email_confirmed_at?user.email:undefined};
 }
 return async function handle(req:Request):Promise<Response>{
  const origin=req.headers.get('Origin');
  const headers:Record<string,string>={'Content-Type':'application/json','Cache-Control':'no-store','Vary':'Origin','X-Content-Type-Options':'nosniff'};
  if(origin&&!config.origins.includes(origin))return new Response(JSON.stringify({error:'Niedozwolone źródło żądania.'}),{status:403,headers});
  if(origin)headers['Access-Control-Allow-Origin']=origin;
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:{...headers,'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Max-Age':'600'}});
  const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
  if(req.method!=='POST')return reply({error:'Nieobsługiwana metoda.'},405);
  try{
   if(Number(req.headers.get('Content-Length'))>3000000)throw new ApiError(413,'Formularz jest zbyt duży.');
   // Bound chunked bodies too, without trusting Content-Length.
   const reader=req.body?.getReader();if(!reader)throw new ApiError(400,'Brak formularza.');
   let size=0;const chunks:Uint8Array[]=[];
   while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>3000000){await reader.cancel();throw new ApiError(413,'Formularz jest zbyt duży.')}chunks.push(part.value)}
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
   let body;try{body=JSON.parse(new TextDecoder().decode(bytes))}catch{throw new ApiError(400,'Nieprawidłowy formularz.')}
   const allowed:Record<string,string[]>={state:[],quote:['id','code'],command:['requestId','command'],publicState:[],register:['requestId','command'],activation:['email','birthDate','password','requestId'],trainer:['requestId','input'],resetPassword:['requestId','accountId'],changePassword:['requestId','oldPassword','password']};
   if(!body||typeof body!=='object'||Array.isArray(body)||!Object.hasOwn(allowed,body.action)||Object.keys(body).some(k=>k!=='action'&&!allowed[body.action].includes(k)))throw new ApiError(400,'Nieprawidłowe żądanie.');
   if(['publicState','register','activation'].includes(body.action)){
    if((body.action==='register'||body.action==='activation'&&body.password!==undefined)&&!uuid.test(body.requestId))throw new ApiError(400,'Brak identyfikatora operacji.');
    try{return reply(await publicAction(body,req,services))}catch(error){throw error instanceof ApiError?error:new ApiError(422,error instanceof Error?error.message:'Nieprawidłowe dane.')}
   }
   const identity=await authenticate(req),mutating=!['state','quote'].includes(body.action);
   if(mutating&&!uuid.test(body.requestId))throw new ApiError(400,'Brak identyfikatora operacji.');
   const args={p_actor:identity.id,p_session:identity.sessionId,p_request:mutating?body.requestId:null};
   const requestHash=mutating?await hash(JSON.stringify(body)):'';
   let provisionedTrainerId:string|undefined,passwordUpdated=false;
   const temporaryPassword=async()=>{
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(config.serviceKey),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const signed=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('aco-reset:'+identity.id+':'+body.requestId));
    return 'ACO!'+Array.from(new Uint8Array(signed),b=>b.toString(16).padStart(2,'0')).join('').slice(0,32);
   };
   for(let attempt=0;attempt<3;attempt++){
    const snapshot=await rpc<Snapshot&{receipt?:{hash:string;revision:number}}>('aco_relational_load',args),db=decode(snapshot);
    let me;try{me=identityAccount(db,identity.id)}catch{throw new ApiError(403,'Konto nie jest aktywne lub dostęp został odebrany.');}
    if(!me)throw new ApiError(403,'Brak dostępu do konta.');
    if(identity.email&&identity.email!==me.email){
     const synced=structuredClone(db),account=synced.accounts.find(a=>a.id===me.id)!;account.email=identity.email;
     const client=synced.clients.find(c=>c.id===me.clientId);if(client)client.email=identity.email;
     const delta=relationalCommitArgs(db,synced,me.id,'emailVerified');
     try{await rpc('aco_relational_commit',{...args,...delta,p_request:crypto.randomUUID(),p_hash:await hash('verified-email:'+identity.email)})}catch(error){if(!(error instanceof ApiError&&error.code==='40001'))throw error}
     continue;
    }
    if(me.role!==snapshot.role)throw new ApiError(403,'Nieprawidłowe uprawnienia konta.');
    if(me.mustChangePassword&&body.action!=='changePassword'){
    if(body.action==='state')return reply({accountId:me.id,revision:snapshot.revision,db:{...publicState(db),accounts:[{id:me.id,role:me.role,email:me.email,trainerId:me.trainerId,clientId:me.clientId,mustChangePassword:true}]}});
     throw new ApiError(403,'Najpierw zmień hasło tymczasowe.');
    }
    if(body.action==='quote'){
     const hold=db.holds.find(h=>h.id===body.id),client=db.clients.find(c=>c.id===hold?.clientId);
     if(!hold||!client||!canSee(db,{role:me.role,trainerId:me.trainerId||'',clientId:me.clientId||''},client)||typeof body.code!=='string'||body.code.length>100)throw new ApiError(403,'Brak dostępu do rezerwacji.');
     try{const result=quote(db,hold.clientId,hold.service,hold.intensity,body.code);return reply({base:result.base,total:result.total,percent:result.percent})}catch(error){throw new ApiError(422,(error as Error).message)}
    }
    if(body.action==='state')return reply({accountId:me.id,revision:snapshot.revision,db:projectState(db,me.id)});
    if(snapshot.receipt){if(snapshot.receipt.hash!==requestHash)throw new ApiError(409,'Identyfikator wykorzystano do innej operacji.');return reply({accountId:me.id,revision:snapshot.revision,db:projectState(db,me.id),replayed:true,...(body.action==='resetPassword'&&me.role==='admin'?{temporary:await temporaryPassword()}:{})})}
    let next;let extra:Record<string,unknown>={};
    try{
     if(body.action==='command'){
      let command=body.command;
      if(command?.type==='updateProfile'&&typeof command.email==='string'&&command.email.trim().toLowerCase()!==me.email){
       // Validate all profile fields before requesting confirmation from Auth.
       applyCommand(db,me.id,command,snapshot.now);
       await auth('/user?redirect_to='+encodeURIComponent('https://acofitness.github.io/demo/panel.html'),'PUT',{email:command.email.trim().toLowerCase()},req.headers.get('Authorization')!.slice(7));
       command={...command,email:me.email};extra={notice:'Profil zapisany. Potwierdź zmianę adresu e-mail za pomocą otrzymanej wiadomości.'};
      }
      next=applyCommand(db,me.id,command,snapshot.now);
     }else if(body.action==='trainer'){
      next=await trainerAction(db,body,me.id,{...services,auth:async(path,method,input,token)=>{
       if(path==='/admin/users'&&method==='POST'&&provisionedTrainerId)return {id:provisionedTrainerId};
       const user=await auth(path,method,input,token);if(path==='/admin/users'&&method==='POST')provisionedTrainerId=user.id;return user;
      }});
     }else if(body.action==='resetPassword'){
      if(me.role!=='admin')throw Error('Brak uprawnień administratora.');
      const target=db.accounts.find(a=>a.id===body.accountId&&!a.disabled);
      if(!target||target.id===me.id)throw Error('Wybierz inne aktywne konto.');
      const temporary=await temporaryPassword();
      // Revoke database sessions before issuing a new temporary credential.
      await rpc('aco_revoke_sessions',{p_target:target.id});
      await auth('/admin/users/'+target.id,'PUT',{password:temporary});
      next=structuredClone(db);next.accounts.find(a=>a.id===target.id)!.mustChangePassword=true;extra={temporary};
     }else if(body.action==='changePassword'){
      if(typeof body.password!=='string'||body.password.length<12||body.password.length>200)throw Error('Hasło musi mieć od 12 do 200 znaków.');
      if(body.action==='changePassword'&&!passwordUpdated){
       if(typeof body.oldPassword!=='string'||body.oldPassword===body.password)throw Error('Wpisz inne hasło niż dotychczasowe.');
       try{await auth('/token?grant_type=password','POST',{email:me.email,password:body.oldPassword})}catch{await auth('/token?grant_type=password','POST',{email:me.email,password:body.password})}
      }
      next=structuredClone(db);
      if(!passwordUpdated){await auth('/user','PUT',{password:body.password},req.headers.get('Authorization')!.slice(7));passwordUpdated=true}
      next.accounts.find(a=>a.id===me.id)!.mustChangePassword=false;
     }else throw Error('Nieznana operacja.');
    }catch(error){throw error instanceof ApiError?error:new ApiError(422,error instanceof Error?error.message:'Nieprawidłowa operacja.')}
    const delta=relationalCommitArgs(db,next,me.id,body.action==='command'?body.command.type:body.action);
    try{
     const result=await rpc<{revision:number}>('aco_relational_commit',{...args,...delta,p_hash:requestHash});
     return reply({accountId:me.id,revision:result.revision,db:projectState(next,me.id),...extra});
    }catch(error){if(error instanceof ApiError&&error.code==='40001'&&attempt<2)continue;throw error}
   }
   throw new ApiError(409,'Grafik został zmieniony. Odśwież go i spróbuj ponownie.');
  }catch(error){return reply({error:error instanceof ApiError?error.message:'Nie udało się obsłużyć żądania.'},error instanceof ApiError?error.status:500)}
 };
}
