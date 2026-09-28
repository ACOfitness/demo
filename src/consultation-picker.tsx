import {TrainerCard} from './trainer-card';
import {WeekGrid,WeekNav} from './week-grid';
import React,{useState,useRef,useEffect} from 'react';
import {Check,ChevronLeft,ChevronRight,Clock,CalendarDays} from 'lucide-react';
import {Avatar,days} from './context';
import {State,Trainer,available,dateOf,dayAdd,dayIndex,hourLabel,labelDate,money,locationsOf,rules,serviceName,trainerHours,weekOf} from './domain';

export function consultationHours(db:State,trainer:Trainer,date:string){
 const today=dateOf(new Date(db.now));
 if(date<today||date>dayAdd(today,rules(db).consultationDays))return [];
 const hours=trainerHours(trainer,dayIndex(date));
 return [...new Set(hours)].filter(h=>h<23&&hours.includes(h+1)&&!db.blocks.some(b=>b.trainerId===trainer.id&&b.date===date&&b.visibility==='hidden'&&(b.hour===h||b.hour===h+1))).sort((a,b)=>a-b);
}
export function ConsultationPicker({db,trainers,trainerId,date,hour,onTrainer,onSlot}:{db:State;trainers:Trainer[];trainerId:string;date:string;hour:number;onTrainer:(id:string)=>void;onSlot:(date:string,hour:number)=>void}){
 const [choosing,setChoosing]=useState(false);const chooser=useRef<HTMLDialogElement>(null);useEffect(()=>{if(choosing)chooser.current?.showModal()},[choosing]);
 const today=dateOf(new Date(db.now)),last=dayAdd(today,rules(db).consultationDays);
 const [week,setWeek]=useState(()=>{const t=trainers.find(t=>t.id===trainerId)||trainers[0];const first=Array.from({length:rules(db).consultationDays+1},(_,i)=>dayAdd(today,i)).find(d=>consultationHours(db,t,d).some(h=>available(db,t.id,d,h)&&available(db,t.id,d,h+1)));return weekOf(hour>=0?date:first||today)});
 const trainer=trainers.find(t=>t.id===trainerId)||trainers[0];
 const dates=Array.from({length:7},(_,i)=>dayAdd(week,i));
 const hoursByDate=dates.map(d=>consultationHours(db,trainer,d));
 const axis=[...new Set(hoursByDate.flatMap(hours=>hours.flatMap(h=>[h,h+1])))].sort((a,b)=>a-b);
 const free=(d:string,h:number)=>available(db,trainer.id,d,h)&&available(db,trainer.id,d,h+1);
 const hasFree=dates.some((d,i)=>hoursByDate[i].some(h=>free(d,h)));
 const choose=(id:string)=>{onTrainer(id);setChoosing(false);const t=trainers.find(t=>t.id===id)!;const first=Array.from({length:rules(db).consultationDays+1},(_,i)=>dayAdd(today,i)).find(d=>consultationHours(db,t,d).some(h=>available(db,t.id,d,h)&&available(db,t.id,d,h+1)));setWeek(weekOf(first||today))};
 const place=locationsOf(db).find(l=>l.id===trainer.locationId)||locationsOf(db)[0];
 return <div className="consultation-picker"><div className="registration-section-heading"><h2>Twój trener</h2><button type="button" className="button secondary" onClick={()=>setChoosing(true)}>Zmień trenera</button></div><TrainerCard db={db} trainer={trainer} description/>
 {choosing&&<dialog ref={chooser} className="dialog trainer-choice-dialog" aria-label="Zmień trenera" onCancel={e=>{e.preventDefault();setChoosing(false)}}><div className="dialog-inner"><button type="button" className="dialog-close" aria-label="Zamknij wybór trenera" onClick={()=>setChoosing(false)}>×</button><h2>Zmień trenera</h2><p>Sprawdź produkt i miejsce przed wyborem.</p>{trainers.map(t=><section className="trainer-choice-row" key={t.id}><TrainerCard db={db} trainer={t}/><button type="button" className="button secondary" disabled={t.id===trainerId} onClick={()=>choose(t.id)}>{t.id===trainerId?'Wybrany trener':'Wybierz'}</button></section>)}</div></dialog>}
 <div className="registration-section-heading"><h2>Wybierz termin konsultacji</h2><span>{money(db.settings.consultation)}</span></div>
 <section className="consultation-calendar"><div className="calendar-toolbar"><WeekNav week={week} onChange={setWeek} min={weekOf(today)} max={last}/><span className="hint">Dostępne do {labelDate(last)}</span></div><WeekGrid week={week} today={today} hours={axis} empty={!hasFree?<p>Brak wolnych konsultacji w tym tygodniu. Sprawdź następny tydzień lub wybierz innego trenera.</p>:undefined} cell={(d,h,i)=>{if(date===d&&hour>=0&&h===hour+1)return {hidden:true};if(!hoursByDate[i].includes(h))return;const selected=date===d&&hour===h,enabled=free(d,h);return {span:selected?2:1,kind:selected?'selected':enabled?'free':'busy',disabled:!enabled,label:selected?<><strong>{hourLabel(h)} - {String(h+1).padStart(2,'0')}:30</strong><small>Konsultacja</small></>:hourLabel(h),onClick:()=>onSlot(d,selected?-1:h)}}}/></section>
 <div className={'consultation-selection '+(hour>=0?'has-selection':'')} aria-live="polite"><CalendarDays size={21}/>{hour>=0?<div><strong>{labelDate(date,{weekday:'long',day:'numeric',month:'long'})} · {hourLabel(hour)}</strong><span>{trainer.name} <span aria-hidden="true">·</span> <Clock size={13}/> 90 minut</span><span className="consultation-place">{place.name}{place.address?' · '+place.address:''}</span></div>:<span>Wybierz wolną godzinę w kalendarzu. Wybrana godzina nie determinuje stałych godzin współpracy.</span>}</div></div>;
}
