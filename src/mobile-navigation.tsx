import React,{useRef,useEffect,useState} from 'react';
import {Menu,X,UserRound,LogOut} from 'lucide-react';
import {useApp} from './context';
export function MobileNavigation({items,logout}:{items:any[];logout:()=>void}){
 const {page,go,open}=useApp(),[shown,setShown]=useState(false),dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{if(shown)dialog.current?.showModal();else dialog.current?.close()},[shown]);
 const select=(name:string)=>{setShown(false);go(name)};
 return <><nav className="mobile-bottom-nav" aria-label="Nawigacja mobilna">{items.slice(0,3).map(([Icon,name])=><button key={name} aria-current={page.split('?')[0]===name?'page':undefined} onClick={()=>select(name)}><Icon size={21}/><span>{name==='Podsumowanie'?'Start':name}</span></button>)}<button aria-expanded={shown} onClick={()=>setShown(true)}><Menu size={21}/><span>Menu</span></button></nav><dialog ref={dialog} className="mobile-menu-dialog" onCancel={()=>setShown(false)} onClick={e=>{if(e.target===e.currentTarget)setShown(false)}}><header><h2>Menu</h2><button aria-label="Zamknij menu" onClick={()=>setShown(false)}><X/></button></header><nav>{items.map(([Icon,name])=><button key={name} aria-current={page.split('?')[0]===name?'page':undefined} onClick={()=>select(name)}><Icon size={21}/>{name}</button>)}</nav><footer><button onClick={()=>{setShown(false);open({type:'profile'})}}><UserRound size={20}/>Mój profil</button><button onClick={()=>{setShown(false);logout()}}><LogOut size={20}/>Wyloguj się</button></footer></dialog></>;
}
