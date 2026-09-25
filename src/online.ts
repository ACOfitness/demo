import {createClient,type Session} from '@supabase/supabase-js';
import type {Database,TrainerInput} from './auth';
import type {Command} from './domain';
interface Configuration {url:string;publishableKey:string}
export interface OnlineState {notice?:string;db:Database;accountId:string;revision:number}
class OnlineError extends Error {constructor(public status:number,message:string){super(message)}}
export function createOnlineClient(config:Configuration){
 const auth=createClient(config.url,config.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,storage:sessionStorage,storageKey:'aco-auth-session',flowType:'implicit'}});
 async function request<T>(body:unknown,session:Session|null,signal?:AbortSignal):Promise<T>{
  const response=await fetch(config.url+'/functions/v1/aco-api',{method:'POST',headers:{'Content-Type':'application/json',apikey:config.publishableKey,...(session?{Authorization:'Bearer '+session.access_token}:{})},body:JSON.stringify(body),signal});
  const data=await response.json();
  if(!response.ok)throw new OnlineError(response.status,data.error||'Nie udało się połączyć z ACO!. Spróbuj ponownie.');
  return data as T;
 }
 async function session(){const {data,error}=await auth.auth.getSession();if(error)throw error;return data.session}
 return {
  auth,
  async load(signal?:AbortSignal){const current=await session();try{return await request<OnlineState>({action:current?'state':'publicState'},current,signal)}catch(error){if(current&&error instanceof OnlineError&&[401,403].includes(error.status)){await auth.auth.signOut({scope:'local'});return request<OnlineState>({action:'publicState'},null,signal)}throw error}},
  async login(email:string,password:string){const {error}=await auth.auth.signInWithPassword({email:email.trim().toLowerCase(),password});if(error)throw Error('Nieprawidłowy e-mail lub hasło.');try{const result=await request<OnlineState>({action:'state'},await session());return result}catch(error){await auth.auth.signOut({scope:'local'});throw error}},
  async logout(){const {error}=await auth.auth.signOut({scope:'local'});if(error)throw error},
  async command(command:Command){const current=await session();if(!current)throw Error('Zaloguj się ponownie.');const envelope={action:'command',requestId:crypto.randomUUID(),command};
   // Retry only uncertain network failures, preserving the same idempotency key.
   try{return await request<OnlineState>(envelope,current)}catch(error){if(!(error instanceof TypeError))throw error;return request<OnlineState>(envelope,current)}
  },
  async quote(id:string,code:string){return request<{base:number;total:number;percent:number}>({action:'quote',id,code},await session())},
  async register(command:Extract<Command,{type:'register'}>){return request<{ok:boolean}>({action:'register',requestId:crypto.randomUUID(),command},null)},
  async activation(email:string,birthDate:string){return request<{ok:boolean}>({action:'activation',email:email.trim().toLowerCase(),birthDate},null)},
  async trainer(input:TrainerInput){return request<OnlineState>({action:'trainer',requestId:crypto.randomUUID(),input},await session())},
  async resetPassword(accountId:string){return request<{temporary:string}>({action:'resetPassword',requestId:crypto.randomUUID(),accountId},await session())},
  async finishActivation(password:string){return request<OnlineState>({action:'finishActivation',requestId:crypto.randomUUID(),password},await session())},
  async changePassword(oldPassword:string,password:string){return request<OnlineState>({action:'changePassword',requestId:crypto.randomUUID(),oldPassword,password},await session())}
 };
}
