import React,{useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Context,useApp} from './context';
export function UnsavedDialog({children}:{children:React.ReactNode}){
 const app=useApp(),dirty=useRef(new Map<string,string>()),initial=useRef(new Map<string,string>());
 const [pending,setPending]=useState<null|(()=>void)>(null);
 const key=(el:HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement)=>el.getAttribute('aria-label')||el.name||el.closest('label')?.textContent?.trim()||el.getAttribute('placeholder')||el.type;
 const value=(el:HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement)=>el instanceof HTMLInputElement&&['checkbox','radio'].includes(el.type)?String(el.checked):el.value;
 const request=(action:()=>void)=>{if(dirty.current.size)setPending(()=>action);else action()};
 const clear=(type:string)=>{
  if(type==='notes'){for(const k of dirty.current.keys())if(k.startsWith('Notatki publiczne')||k.startsWith('Notatki trenerskie'))dirty.current.delete(k)}
  else if(type==='comment')dirty.current.delete('Komentarz do sesji');
  else if(type==='prescribe'){for(const k of dirty.current.keys())if(k.startsWith('Produkt')||k.startsWith('Intensywność'))dirty.current.delete(k)}
  else if(!['outcome','readNotice','readLetter','activate'].includes(type))dirty.current.clear();
  for(const k of initial.current.keys())if(!dirty.current.has(k))initial.current.delete(k);
 };
 const warning=<div className="unsaved-overlay" onClick={e=>e.stopPropagation()}><section className="unsaved-confirm" role="alertdialog" aria-modal="true" aria-labelledby="unsaved-title"><h2 id="unsaved-title">Niezapisane zmiany</h2><p>Zamknąć okno i odrzucić wprowadzone zmiany?</p><div className="form-actions"><button autoFocus className="button secondary" onClick={()=>setPending(null)}>Wróć do edycji</button><button className="button primary" onClick={()=>{const action=pending;dirty.current.clear();setPending(null);action?.()}}>Odrzuć zmiany</button></div></section></div>;
 return <Context.Provider value={{...app,back:()=>request(app.back),open:m=>request(()=>app.open(m)),go:p=>request(()=>app.go(p)),run:(cmd,msg,confirmed)=>{const result=app.run(cmd,msg,confirmed);if(result)clear(cmd.type);return result},createTrainer:async data=>{await app.createTrainer(data);dirty.current.clear()}}}>
 <div onFocusCapture={e=>{const el=e.target;if(el instanceof HTMLInputElement||el instanceof HTMLSelectElement||el instanceof HTMLTextAreaElement){const k=key(el);if(!initial.current.has(k))initial.current.set(k,value(el))}}}
 onChangeCapture={e=>{const el=e.target;if(el instanceof HTMLInputElement||el instanceof HTMLSelectElement||el instanceof HTMLTextAreaElement){const k=key(el),v=value(el);if(initial.current.get(k)===v)dirty.current.delete(k);else dirty.current.set(k,v)}}}
 onClickCapture={e=>{if((e.target as HTMLElement).closest('.time-options button,.slot-picker button,.crop-nudge button,.day-ranges button'))dirty.current.set('wybór','changed');if((e.target as HTMLElement).closest('.photo-actions')&&['Usuń','Zastosuj kadr'].includes((e.target as HTMLElement).textContent||''))dirty.current.set('zdjęcie','changed')}}>{children}</div>
 {pending&&createPortal(warning,document.querySelector('dialog[open]')||document.body)}
 </Context.Provider>;
}
