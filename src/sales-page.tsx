import React,{useState} from 'react';
import {Download,Wallet,Clock,Check,ArrowRight,RotateCcw,ShoppingBag} from 'lucide-react';
import {useApp,download} from './context';
import {Select} from './controls';
import {saleDay,labelDate,money} from './domain';
import {csv} from './csv';
import {pluralCount} from './display-format';
import {Heading} from './pages';
import './sales.css';

export function SalesPage(){
 const {db,open}=useApp();
 const [type,setType]=useState('all'),[month,setMonth]=useState('all'),[order,setOrder]=useState('newest');
 const months=[...new Set(db.sales.map(s=>saleDay(s.date).slice(0,7)))].sort().reverse();
 const consultation=(s:typeof db.sales[number])=>!s.packageId&&(s.label||'').toLowerCase().includes('konsult');
 const sales=db.sales.filter(s=>(month==='all'||saleDay(s.date).startsWith(month))&&(type==='all'||(type==='consultation'?consultation(s):!consultation(s)))).sort((a,b)=>(order==='newest'?-1:1)*a.date.localeCompare(b.date));
 const packages=sales.filter(s=>!consultation(s)),consultations=sales.filter(consultation);
 const total=(items:typeof sales)=>items.reduce((n,s)=>n+s.amount,0);
 const holds=db.holds.filter(h=>h.status==='active'&&h.expires>db.now);
 const unpaid=db.sessions.filter(s=>s.kind==='consultation'&&!db.sales.some(sale=>sale.id==='consultation:'+s.id));
 const pending=holds.length+unpaid.length;
 const exportSales=()=>download('ACO!-sprzedaz.csv',csv([['Data','Klient','Produkt','Kwota'],...sales.map(s=>[saleDay(s.date),db.clients.find(c=>c.id===s.clientId)?.name,s.label,s.amount])]),'text/csv;charset=utf-8');
 return <div className="sales-page results-page">
  <Heading title="Sprzedaż" subtitle="Wpłaty za pakiety i konsultacje."><button className="button secondary" onClick={exportSales}><Download size={16}/>Eksport CSV</button></Heading>
  <section className="card results-overview">
   <header className="sales-section-head"><div><h2>Podsumowanie sprzedaży</h2><p>{month==='all'?'Cała historia':labelDate(month+'-01',{month:'long',year:'numeric'})}</p></div><ShoppingBag size={20} aria-hidden="true"/></header>
   <div className="results-filters sales-filters">
    <label><span>Okres</span><Select aria-label="Miesiąc sprzedaży" value={month} onChange={e=>setMonth(e.target.value)}><option value="all">Wszystkie miesiące</option>{months.map(m=><option value={m} key={m}>{labelDate(m+'-01',{month:'long',year:'numeric'})}</option>)}</Select></label>
    <label><span>Produkt</span><Select aria-label="Typ sprzedaży" value={type} onChange={e=>setType(e.target.value)}><option value="all">Wszystkie produkty</option><option value="consultation">Konsultacje</option><option value="package">Pakiety</option></Select></label>
    {(type!=='all'||month!=='all')&&<button className="text-button results-reset" onClick={()=>{setType('all');setMonth('all')}}><RotateCcw size={13}/>Wyczyść filtry</button>}
   </div>
   <div className="results-revenue"><div className="results-total"><span className="results-total-label"><Wallet size={18}/>Wartość sprzedaży</span><strong>{money(total(sales))}</strong><span>{pluralCount(sales.length,['transakcja','transakcje','transakcji'])} w wybranym zakresie</span></div><div className="results-breakdown">
    <div className="revenue-category"><div><i className="category-dot"/><strong>Pakiety</strong><small>{pluralCount(packages.length,['transakcja','transakcje','transakcji'])}</small></div><div><strong>{money(total(packages))}</strong></div></div>
    <div className="revenue-category consultation"><div><i className="category-dot"/><strong>Konsultacje</strong><small>{pluralCount(consultations.length,['transakcja','transakcje','transakcji'])}</small></div><div><strong>{money(total(consultations))}</strong></div></div>
   </div></div>
  </section>
  <section className="card sales-settlements">
   <header className="sales-section-head"><div><h2>Do rozliczenia <span className="sales-count">{pending}</span></h2><p>Wszystkie oczekujące wpłaty</p></div><Clock size={20} aria-hidden="true"/></header>
   {pending?<div className="sales-pending-list">{holds.map(h=><div className="sales-payment-row" key={h.id}><span className="sales-kind-icon"><ShoppingBag size={17}/></span><div className="sales-payment-person"><strong>{db.clients.find(c=>c.id===h.clientId)?.name||'Klient'}</strong><small>Pakiet</small></div><div className="sales-payment-detail"><span>Rezerwacja do</span><strong>{new Date(h.expires).toLocaleString('pl-PL',{timeZone:'Europe/Warsaw',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</strong></div><button className="button secondary" onClick={()=>open({type:'payment',id:h.id})}>Rozlicz pakiet<ArrowRight size={15}/></button></div>)}{unpaid.map(s=><div className="sales-payment-row" key={s.id}><span className="sales-kind-icon consultation"><Wallet size={17}/></span><div className="sales-payment-person"><strong>{db.clients.find(c=>c.id===s.clientId)?.name||'Klient'}</strong><small>Konsultacja · {labelDate(s.date)}</small></div><div className="sales-payment-detail"><span>Do zapłaty</span><strong>{money(s.consultationPrice??db.settings.consultation)}</strong></div><button className="button secondary" onClick={()=>open({type:'confirm',title:'Potwierdzić wpłatę?',body:'Potwierdzasz otrzymanie wpłaty za tę konsultację?',command:{type:'confirmConsultation',id:s.id}})}>Potwierdź wpłatę<Check size={15}/></button></div>)}</div>:<div className="sales-settled"><Check size={18}/><span>Wszystkie wpłaty rozliczone</span></div>}
  </section>
  <section className="card results-detail sales-transactions">
   <header className="sales-section-head"><div><h2>Historia transakcji <span className="sales-count">{sales.length}</span></h2><p>{type==='all'?'Pakiety i konsultacje':type==='package'?'Pakiety':'Konsultacje'} · {month==='all'?'wszystkie miesiące':labelDate(month+'-01',{month:'long',year:'numeric'})}</p></div><Select aria-label="Kolejność sprzedaży" value={order} onChange={e=>setOrder(e.target.value)}><option value="newest">Od najnowszych</option><option value="oldest">Od najstarszych</option></Select></header>
   {sales.length?<div className="table-scroll"><table className="results-data sales-data"><thead><tr><th>Klient</th><th>Data</th><th>Produkt</th><th>Kwota</th><th>Status</th></tr></thead><tbody>{sales.map(s=><tr key={s.id}><td data-label="Klient"><strong>{db.clients.find(c=>c.id===s.clientId)?.name||'Klient usunięty'}</strong></td><td data-label="Data">{labelDate(saleDay(s.date))}</td><td data-label="Produkt">{s.label||(s.packageId?'Pakiet':'Konsultacja')}</td><td data-label="Kwota"><strong>{money(s.amount)}</strong></td><td data-label="Status"><span className="results-status completed">Opłacono</span></td></tr>)}</tbody></table></div>:<div className="results-empty"><ShoppingBag size={25}/><h3>Brak transakcji</h3><p>{db.sales.length?'Zmień okres lub produkt, aby zobaczyć pozostałe wpłaty.':'Opłacone pakiety i konsultacje pojawią się tutaj.'}</p></div>}
  </section>
 </div>
}
