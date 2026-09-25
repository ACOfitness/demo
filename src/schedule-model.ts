import {State,Actor,Session,at,endAt,canSee} from './domain';
export const sessionOrder=(a:Session,b:Session)=>a.date.localeCompare(b.date)||a.hour-b.hour;
export const upcomingSessions=(db:State,trainerId:string)=>db.sessions.filter(s=>s.trainerId===trainerId&&s.status==='scheduled'&&at(s.date,s.hour)>new Date(db.now)).sort(sessionOrder);
export const journalSessions=(db:State,actor:Actor)=>db.sessions.filter(s=>actor.role==='trainer'?s.trainerId===actor.trainerId&&(canSee(db,actor,db.clients.find(c=>c.id===s.clientId)!)||!s.substituteId&&endAt(s)<=new Date(db.now)):db.clients.some(c=>c.id===s.clientId&&canSee(db,actor,c)));
export function currentEvent<T extends {date:string}>(items:T[],now:string){return items.filter(e=>e.date<=now).sort((a,b)=>b.date.localeCompare(a.date))[0]||items.slice().sort((a,b)=>a.date.localeCompare(b.date))[0]}
export const sessionsAt=(db:State,date:string,hour:number)=>db.sessions.filter(s=>s.date===date&&!s.status.startsWith('cancelled')&&s.hour<=hour&&s.hour+(s.kind==='consultation'?1.5:1)>hour);
