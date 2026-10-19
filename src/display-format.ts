import {labelDate} from './domain';
export function duration(hours:number){const minutes=Math.round(hours*60),h=Math.floor(minutes/60),m=minutes%60;return h?(h+' godz.'+(m?' '+m+' min':'')):m+' min'}

export function dateRange(start:string,end:string){
 const sameYear=start.slice(0,4)===end.slice(0,4),sameMonth=start.slice(0,7)===end.slice(0,7);
 if(sameMonth)return `${Number(start.slice(8))}–${labelDate(end,{day:'numeric',month:'short',year:'numeric'})}`;
 return `${labelDate(start,{day:'numeric',month:'short',...(sameYear?{}:{year:'numeric'})})} – ${labelDate(end,{day:'numeric',month:'short',year:'numeric'})}`;
}
export function pluralCount(count:number,forms:[string,string,string]){const ending=count%10,teen=count%100;return `${count} ${forms[count===1?0:ending>=2&&ending<=4&&(teen<12||teen>14)?1:2]}`}
export const meetingCount=(count:number)=>pluralCount(count,['spotkanie','spotkania','spotkań']);
export const sessionCount=(count:number)=>pluralCount(count,['sesja','sesje','sesji']);
export const clientCount=(count:number)=>pluralCount(count,['klient','klientów','klientów']);

export function originalSlotLabel(value:string){const match=/^(\d{4}-\d{2}-\d{2})(.*)$/.exec(value);return match?`${labelDate(match[1],{day:'numeric',month:'long',year:'numeric'})}${match[2]}`:value}
