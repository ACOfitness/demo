import React from 'react';
import {useApp,days} from './context';
import {at,currentPackage,hourLabel,labelDate,statusLabels} from './domain';
import {sessionOrder} from './schedule-model';
export function SelectedSchedule({clientId,compact=false}:{clientId:string;compact?:boolean}){
 const {db,open}=useApp();const hold=db.holds.find(h=>h.clientId===clientId&&h.status==='active'&&h.expires>db.now),pack=currentPackage(db,clientId);
 if(!hold&&!pack)return null;
 const slots=hold?.slots||pack!.slots;
 const dates=hold?hold.dates.slice().sort((a,b)=>a.date.localeCompare(b.date)||a.hour-b.hour):db.sessions.filter(s=>s.packageId===pack!.id&&s.status==='scheduled').sort(sessionOrder);
 return <section className="selected-schedule"><h3>Wybrane godziny</h3><div className="selected-slots">{slots.map(s=><span key={s.day}>{days[s.day]} <strong>{hourLabel(s.hour)}</strong></span>)}</div>{!compact&&<div className="selected-dates">{dates.map((d,i)=><div key={i}><span>{labelDate(d.date,{weekday:'short',day:'numeric',month:'long'})} · {hourLabel(d.hour)}</span>{!hold&&'id' in d&&at(d.date,d.hour)>new Date(db.now)&&<button className="text-button" onClick={()=>open({type:'reschedule',id:String(d.id)})}>Edytuj godzinę</button>}</div>)}{!dates.length&&<p>Brak zaplanowanych treningów w tym pakiecie.</p>}</div>}{compact&&dates.length>0&&<div className="selected-dates-preview">{dates.slice(0,3).map((d,i)=><small key={i}>{labelDate(d.date)} · {hourLabel(d.hour)}</small>)}{dates.length>3&&<small>+ {dates.length-3} kolejnych terminów</small>}</div>}{compact?<button className="button secondary full" onClick={()=>open(hold?{type:'editHold',id:hold.id}:{type:'schedule',id:clientId})}>Edytuj godziny</button>:hold&&<button className="button secondary full" onClick={()=>open({type:'editHold',id:hold.id})}>Edytuj godziny</button>}</section>
}
