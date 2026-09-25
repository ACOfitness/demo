import {Database,TrainerInput} from './auth';
import React from 'react';
import {State,Actor,Command} from './domain';
export type Modal = {type:'session'|'client'|'wizard'|'reschedule'|'makeup'|'substitute'|'payment'|'editHold'|'editTrainer'|'trainerClients'|'availability'|'resetPassword'|'companyHours'|'validity';id:string}|{type:'newTrainer'|'profile'}|{type:'block';trainerId?:string;date?:string;hour?:number}|{type:'confirm';title:string;body:string;command?:Command};
export const Context=React.createContext<{db:Database;actor:Actor;back:()=>void;canBack:boolean;feedback:string;resetPassword:(id:string)=>Promise<string>;noticeId:string;openNotice:(id:string)=>void;run:(cmd:Command,message?:string,confirmed?:boolean)=>boolean;modal:Modal|null;open:(m:Modal|null)=>void;page:string;go:(p:string)=>void;toast:(s:string)=>void;registerClient:(cmd:Extract<Command,{type:"register"}>)=>Promise<void>;createTrainer:(input:TrainerInput)=>Promise<void>}>(null!);
export const useApp=()=>React.useContext(Context);
export const initials=(n:string)=>n.split(' ').map(s=>s[0]).slice(0,2).join('');
export const days=['Poniedziałek','Wtorek','Środa','Czwartek','Piątek','Sobota','Niedziela'];
export function Avatar({name,tone='mint',small=false}:{name:string;tone?:string;small?:boolean}){return <span className={`avatar ${tone} ${small?'small':''}`}>{initials(name)}</span>}
export function Empty({title,body,action}:{title:string;body:string;action?:React.ReactNode}){return <div className="empty"><div className="empty-mark">✳</div><h2>{title}</h2><p>{body}</p>{action}</div>}
export function Field({label,children}:{label:string;children:React.ReactNode}){return <label className="field"><span>{label}</span>{children}</label>}
export function download(name:string,text:string,type='application/json'){const blob=new Blob([text],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}

export function Steps({labels,step,onChange}:{labels:string[];step:number;onChange:(step:number)=>void}){return <div className="steps">{labels.map((label,i)=><button type="button" key={label} className={step===i+1?'active':''} aria-current={step===i+1?'step':undefined} onClick={()=>onChange(i+1)}><i>{i+1}</i>{label}</button>)}</div>}
