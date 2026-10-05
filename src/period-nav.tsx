import React from 'react';
import {ChevronLeft,ChevronRight} from 'lucide-react';
import {Select} from './controls';
import {dayAdd,labelDate,weekOf} from './domain';
export type PeriodMode='month'|'week';
export function periodStart(date:string,mode:PeriodMode){return mode==='week'?weekOf(date):date.slice(0,7)+'-01'}
export function periodShift(date:string,mode:PeriodMode,n:number){if(mode==='week')return dayAdd(weekOf(date),7*n);const d=new Date(date.slice(0,7)+'-01T12:00:00Z');d.setUTCMonth(d.getUTCMonth()+n);return d.toISOString().slice(0,10)}
export function PeriodNav({date,mode,onDate,onMode,label}:{date:string;mode:PeriodMode;onDate:(v:string)=>void;onMode?:(v:PeriodMode)=>void;label:string}){const start=periodStart(date,mode);return <div className="period-nav" aria-label={label}>{onMode&&<Select aria-label={label+' - okres'} value={mode} onChange={e=>onMode(e.target.value as PeriodMode)}><option value="week">Tydzień</option><option value="month">Miesiąc</option></Select>}<button className="icon-btn" aria-label={label+' - poprzedni okres'} onClick={()=>onDate(periodShift(start,mode,-1))}><ChevronLeft size={18}/></button><strong aria-live="polite">{mode==='month'?labelDate(start,{month:'long',year:'numeric'}):`${labelDate(start)} - ${labelDate(dayAdd(start,6),{day:'numeric',month:'long',year:'numeric'})}`}</strong><button className="icon-btn" aria-label={label+' - następny okres'} onClick={()=>onDate(periodShift(start,mode,1))}><ChevronRight size={18}/></button></div>}
