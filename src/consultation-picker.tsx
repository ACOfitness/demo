import {TrainerCard} from './trainer-card';
import {WeekGrid,WeekNav} from './week-grid';
import React,{useState,useRef,useEffect} from 'react';
import {Check,ChevronLeft,ChevronRight,Clock,CalendarDays} from 'lucide-react';
import {Avatar,days} from './context';
import {State,Trainer,Role,bookingLeadAllowed,available,dateOf,dayAdd,dayIndex,hourLabel,labelDate,money,locationsOf,rules,serviceName,trainerHours,weekOf} from './domain';

export function consultationHours(db:State,trainer:Trainer,date:string,role:Role='client'){
 const today=dateOf(new Date(db.now));
 if(date<today||date>dayAdd(today,rules(db).consultationDays))return [];
 const hours=trainerHours(trainer,dayIndex(date));
 return [...new Set(hours)].filter(h=>bookingLeadAllowed(db,'consultation',date,h,role)&&h<23&&hours.includes(h+1)&&!db.blocks.some(b=>b.trainerId===trainer.id&&b.date===date&&b.visibility==='hidden'&&(b.hour===h||b.hour===h+1))).sort((a,b)=>a-b);
}
export function ConsultationPicker({db,trainers,trainerId,date,hour,onTrainer,onSlot,role='client'}:{role?:Role;db:State;trainers:Trainer[];trainerId:string;date:string;hour:number;onTrainer:(id:string)=>void;onSlot:(date:string,hour:number)=>void}){
 const [choosing,setChoosing]=useState(false);const chooser=useRef<HTMLDialogElement>(null);useEffect(()=>{if(choosing)chooser.current?.showModal()},[choosing]);
 const today=dateOf(new Date(db.now)),last=dayAdd(today,rules(db).consultationDays);
 const firstFree=(t:Trainer,from=today,to=last)=>Array.from({length:Math.max(0,Math.round((+new Date(to)-+new Date(from))/86400000))+1},(_,i)=>dayAdd(from,i)).find(d=>consultationHours(db,t,d,role).some(h=>available(db,t.id,d,h)&&available(db,t.id,d,h+1)));
 const [focusDate,setFocusDate]=useState(()=>hour>=0?date:firstFree(trainers.find(t=>t.id===trainerId)||trainers[0])||today);
 const [week,setWeek]=useState(()=>weekOf(focusDate));
 const trainer=trainers.find(t=>t.id===trainerId)||trainers[0];
 const dates=Array.from({length:7},(_,i)=>dayAdd(week,i));
 const hoursByDate=dates.map(d=>consultationHours(db,trainer,d,role));
 const axis=[...new Set(hoursByDate.flatMap(hours=>hours.flatMap(h=>[h,h+1])))].sort((a,b)=>a-b);
 const free=(d:string,h:number)=>available(db,trainer.id,d,h)&&available(db,trainer.id,d,h+1);
 const hasFree=dates.some((d,i)=>hoursByDate[i].some(h=>free(d,h)));
 const choose=(id:string)=>{onTrainer(id);setChoosing(false);const t=trainers.find(t=>t.id===id)!;const first=firstFree(t)||today;setWeek(weekOf(first));setFocusDate(first)};
 const place=locationsOf(db).find(l=>l.id===trainer.locationId)||locationsOf(db)[0];
 return <div className="consultation-picker"><div className="registration-section-heading"><h2>Twój trener</h2><button type="button" className="button secondary" onClick={()=>setChoosing(true)}>Zmień trenera</button></div><TrainerCard db={db} trainer={trainer} description/>
 {choosing&&<dialog ref={chooser} className="dialog trainer-choice-dialog" aria-label="Zmień trenera" onCancel={e=>{e.preventDefault();setChoosing(false)}}><div className="dialog-toolbar"><span>Wybór trenera</span><button type="button" className="dialog-close" aria-label="Zamknij wybór trenera" onClick={()=>setChoosing(false)}>×</button></div><div className="dialog-inner"><h2>Zmień trenera</h2><p>Sprawdź produkt i miejsce przed wyborem.</p>{trainers.map(t=><section className="trainer-choice-row" key={t.id}><TrainerCard db={db} trainer={t}/><button type="button" className="button secondary" disabled={t.id===trainerId} onClick={()=>choose(t.id)}>{t.id===trainerId?'Wybrany trener':'Wybierz'}</button></section>)}</div></dialog>}
 <div className="registration-section-heading"><h2>Wybierz termin konsultacji</h2><span>{money(db.settings.consultation)}</span></div>
 <section className="consultation-calendar"><div className="calendar-toolbar"><WeekNav week={week} onChange={value=>{setWeek(value);setFocusDate(firstFree(trainer,value,dayAdd(value,6))||value)}} min={weekOf(today)} max={last}/><span className="hint">Dostępne do {labelDate(last)}</span></div><WeekGrid focusDate={focusDate} onDayChange={setFocusDate} week={week} today={today} hours={axis} empty={!hasFree?<p>Brak wolnych konsultacji w tym tygodniu. {dayAdd(week,7)<=last?'Sprawdź następny tydzień lub wybierz innego trenera.':'Wybierz innego trenera lub sprawdź dostępność później.'}</p>:undefined} cell={(d,h,i)=>{if(date===d&&hour>=0&&h===hour+1)return {hidden:true};if(!hoursByDate[i].includes(h))return;const selected=date===d&&hour===h,enabled=free(d,h);return {span:selected?2:1,kind:selected?'selected':enabled?'free':'busy',disabled:!enabled,label:selected?<><strong>{hourLabel(h)} - {String(h+1).padStart(2,'0')}:30</strong><small>Konsultacja</small></>:hourLabel(h),onClick:()=>{setFocusDate(d);onSlot(d,selected?-1:h)}}}}/></section>
 <div className={'consultation-selection '+(hour>=0?'has-selection':'')} aria-live="polite"><CalendarDays size={21}/>{hour>=0?<div><strong>{labelDate(date,{weekday:'long',day:'numeric',month:'long'})} · {hourLabel(hour)}</strong><span>{trainer.name} <span aria-hidden="true">·</span> <Clock size={13}/> 90 minut</span><span className="consultation-place">{place.name}{place.address?' · '+place.address:''}</span></div>:<span>Wybierz wolną godzinę w kalendarzu. Wybrana godzina nie determinuje stałych godzin współpracy.</span>}</div></div>;
}
