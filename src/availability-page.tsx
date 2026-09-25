import React,{useState,useRef,useEffect} from 'react';
import {Check,Save} from 'lucide-react';
import {useApp,days,Empty} from './context';
import {trainerHours,hourLabel} from './domain';
import {availabilityRanges,toggleAvailabilityHour} from './availability-model';
export function AvailabilityPage({id}:{id?:string}){
 const {db,actor,run}=useApp();const trainer=db.trainers.find(t=>t.id===(id||actor.trainerId));
 const [week,setWeek]=useState<number[][]>(()=>Array.from({length:7},(_,d)=>trainer?[...new Set(trainerHours(trainer,d))].sort((a,b)=>a-b):[]));
 const [error,setError]=useState(''),[saving,setSaving]=useState(false);const grid=useRef<HTMLDivElement>(null);
 useEffect(()=>{const box=grid.current;const hour=Math.min(8,...week.flat());const cell=box?.querySelector<HTMLElement>(`[data-hour="${hour}"]`);if(box&&cell)box.scrollTop=cell.offsetTop-70},[]);
 if(actor.role!=='admin')return <Empty title="Dostępność ustawia administrator" body="Skontaktuj się z administratorem, aby zmienić godziny pracy."/>;
 if(!trainer)return <Empty title="Nie znaleziono trenera" body="Wybierz trenera z listy."/>;
 const dirty=week.some((hours,d)=>JSON.stringify(hours)!==JSON.stringify([...new Set(trainerHours(trainer,d))].sort((a,b)=>a-b)));
 const toggle=(day:number,hour:number)=>{try{const hours=toggleAvailabilityHour(week[day],hour);setWeek(week.map((w,i)=>i===day?hours:w));setError('')}catch(e){setError(`${days[day]}: ${(e as Error).message}`)}};
 return <><div className="page-heading"><div><h1>Dostępność - {trainer.name}</h1><p>Kliknij bloki godzinowe. Ten grafik powtarza się co tydzień.</p></div></div><form className="card availability-week-form" onSubmit={async e=>{e.preventDefault();setError('');if(week.some(h=>availabilityRanges(h).length>3)){setError('W jednym dniu można ustawić maksymalnie 3 zakresy godzin.');return}setSaving(true);try{await run({type:'availability',trainerId:trainer.id,days:week.flatMap((h,d)=>h.length?[d]:[]),hours:[...new Set(week.flat())].sort((a,b)=>a-b),weeklyHours:Object.fromEntries(week.map((h,d)=>[d,h]))},'Dostępność zapisana.')}finally{setSaving(false)}}}>
 <div className="availability-week-scroll" ref={grid} aria-label="Tygodniowa dostępność trenera"><div className="availability-week-grid"><div className="availability-grid-header availability-grid-corner">Godzina</div>{days.map((day,d)=><div className="availability-grid-header" key={day}><strong>{day.slice(0,3)}</strong><small>{week[d].length?`${week[d].length} h · ${availabilityRanges(week[d]).length}/3`:'Dzień wolny'}</small></div>)}{Array.from({length:24},(_,hour)=><React.Fragment key={hour}><span className="availability-hour-label" data-hour={hour}>{hourLabel(hour)}</span>{days.map((day,d)=>{const selected=week[d].includes(hour);return <label key={day} className={'availability-hour '+(selected?'selected':'')}><input type="checkbox" aria-label={`${day} ${hourLabel(hour)} - ${hourLabel(hour+1)}`} checked={selected} disabled={saving} onChange={()=>toggle(d,hour)}/><span>{selected?<Check size={15}/>:hourLabel(hour)}</span></label>})}</React.Fragment>)}</div></div>
 <div className="availability-week-footer"><div className="availability-week-legend"><span><i/>Wybrane godziny</span><small>Maks. 3 zakresy dziennie · 1 blok = 1 godzina</small></div>{error&&<p className="alert" role="alert">{error}</p>}<button className="button primary" disabled={!dirty||saving}><Save size={16}/>{saving?'Zapisywanie…':'Zapisz dostępność'}</button></div></form></>;
}
