import React,{useState} from 'react';
import {Check,ChevronLeft,ChevronRight,Clock,CalendarDays} from 'lucide-react';
import {Avatar,days} from './context';
import {State,Trainer,available,dateOf,dayAdd,dayIndex,hourLabel,labelDate,money,rules,serviceName,trainerHours,weekOf} from './domain';

export function consultationHours(db:State,trainer:Trainer,date:string){
 const today=dateOf(new Date(db.now));
 if(date<today||date>dayAdd(today,rules(db).consultationDays))return [];
 const hours=trainerHours(trainer,dayIndex(date));
 return [...new Set(hours)].filter(h=>h<23&&hours.includes(h+1)&&!db.blocks.some(b=>b.trainerId===trainer.id&&b.date===date&&b.visibility==='hidden'&&(b.hour===h||b.hour===h+1))).sort((a,b)=>a-b);
}
export function ConsultationPicker({db,trainers,trainerId,date,hour,onTrainer,onSlot}:{db:State;trainers:Trainer[];trainerId:string;date:string;hour:number;onTrainer:(id:string)=>void;onSlot:(date:string,hour:number)=>void}){
 const today=dateOf(new Date(db.now)),last=dayAdd(today,rules(db).consultationDays);
 const [week,setWeek]=useState(()=>weekOf(hour>=0?date:today));
 const trainer=trainers.find(t=>t.id===trainerId)||trainers[0];
 const dates=Array.from({length:7},(_,i)=>dayAdd(week,i));
 const hoursByDate=dates.map(d=>consultationHours(db,trainer,d));
 const axis=[...new Set(hoursByDate.flatMap(hours=>hours.flatMap(h=>[h,h+1])))].sort((a,b)=>a-b);
 const free=(d:string,h:number)=>available(db,trainer.id,d,h)&&available(db,trainer.id,d,h+1);
 const hasFree=dates.some((d,i)=>hoursByDate[i].some(h=>free(d,h)));
 return <div className="consultation-picker"><div className="registration-section-heading"><h2>Wybierz trenera</h2><span>Konsultacja · 90 minut</span></div>
 <div className="consultation-trainers" role="group" aria-label="Wybór trenera">{trainers.map(t=><button type="button" key={t.id} aria-pressed={trainerId===t.id} className={'consultation-trainer '+(trainerId===t.id?'selected':'')} onClick={()=>{if(trainerId!==t.id)onTrainer(t.id)}}><span className="consultation-trainer-photo">{t.photo?<img src={t.photo} alt=""/>:<Avatar name={t.name}/>}</span><span className="consultation-trainer-info"><strong>{t.name}</strong><span>{(t.products||[]).map(serviceName).join(' · ')||'Trener personalny'}</span></span><span className="trainer-choice-mark">{trainerId===t.id&&<Check size={14}/>}</span></button>)}</div>
 <div className="registration-section-heading"><h2>Wybierz termin konsultacji</h2><span>{money(db.settings.consultation)}</span></div>
 <section className="consultation-calendar" aria-label="Terminy konsultacji"><div className="calendar-toolbar"><div className="week-nav"><button type="button" aria-label="Poprzedni tydzień konsultacji" disabled={week<=weekOf(today)} onClick={()=>setWeek(dayAdd(week,-7))}><ChevronLeft size={17}/></button><strong>{labelDate(week)} - {labelDate(dayAdd(week,6))}</strong><button type="button" aria-label="Następny tydzień konsultacji" disabled={dayAdd(week,7)>last} onClick={()=>setWeek(dayAdd(week,7))}><ChevronRight size={17}/></button></div><span className="consultation-calendar-hint">Dostępne do {labelDate(last)}</span></div>
 <div className="consultation-calendar-scroll"><div className="consultation-calendar-grid"><div className="consultation-day-header consultation-axis-label">Godzina</div>{dates.map((d,i)=><div key={d} className={'consultation-day-header '+(d===today?'today ':'')+(d<today||d>last?'outside':'')}><strong>{days[i].slice(0,3)}</strong><span>{labelDate(d,{day:'2-digit',month:'2-digit'})}</span><small>{d===today?'Dziś':'\u00a0'}</small></div>)}{axis.map((h,index)=><React.Fragment key={h}>{index>0&&h>axis[index-1]+1&&<div className="consultation-hours-gap" aria-hidden="true"/>}<span className="consultation-axis-label">{hourLabel(h)}</span>{dates.map((d,i)=>{if(date===d&&hour>=0&&h===hour+1)return <span key={d} className="consultation-slot-tail" aria-label="Wybrana konsultacja - ostatnie 30 minut"><i/></span>;if(!hoursByDate[i].includes(h))return <span key={d} className="consultation-slot-empty"/>;const enabled=free(d,h),selected=date===d&&hour===h;return <div className="consultation-slot-frame" key={d}><button type="button" className={'consultation-slot '+(selected?'selected':enabled?'free':'busy')} disabled={!enabled} aria-pressed={selected} aria-label={`${days[i]} ${labelDate(d,{day:'numeric',month:'long'})}, ${hourLabel(h)}${enabled?'':' - niedostępny'}`} title={enabled?`${hourLabel(h)} - ${String(h+1).padStart(2,'0')}:30`:'Termin niedostępny'} onClick={()=>onSlot(d,selected?-1:h)}>{selected?<><Check size={14}/>{hourLabel(h)}</>:hourLabel(h)}<i aria-hidden="true"/></button></div>})}</React.Fragment>)}</div></div>
 {!hasFree&&<p className="consultation-no-slots">Brak wolnych konsultacji w tym tygodniu.{dayAdd(week,7)<=last?' Sprawdź następny tydzień lub wybierz innego trenera.':' Wybierz innego trenera lub skontaktuj się z ACO!.'}</p>}
 <div className="consultation-legend"><span><i className="free"/>Wolny termin</span><span><i className="selected"/>Wybrany</span><span><i className="busy"/>Niedostępny</span></div></section>
 <div className={'consultation-selection '+(hour>=0?'has-selection':'')} aria-live="polite"><CalendarDays size={21}/>{hour>=0?<div><strong>{labelDate(date,{weekday:'long',day:'numeric',month:'long'})} · {hourLabel(hour)}</strong><span>{trainer.name} <span aria-hidden="true">·</span> <Clock size={13}/> 90 minut</span></div>:<span>Wybierz wolną godzinę w kalendarzu.</span>}</div></div>;
}
