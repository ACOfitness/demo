import {State,Session,spends} from './domain';
export interface RevenueRow {session:Session;grosz:number;category:'training'|'consultation'|'absence';service:string}
/** Allocate indivisible grosz deterministically; a complete package always sums to its paid price. */
export function recognizedRevenue(db:State):RevenueRow[]{
 const allocations=new Map<string,number>();
 for(const p of db.packages){
  const sale=db.sales.find(s=>s.packageId===p.id&&s.status==='paid');
  if(!sale||p.count<=0)continue;
  const total=Math.max(0,Math.round(p.price*100)),base=Math.floor(total/p.count),extra=total%p.count;
  db.sessions.filter(s=>s.packageId===p.id&&spends(s)).sort((a,b)=>a.date.localeCompare(b.date)||a.hour-b.hour||a.id.localeCompare(b.id)).slice(0,p.count).forEach((s,i)=>allocations.set(s.id,base+(i<extra?1:0)));
 }
 return db.sessions.filter(spends).flatMap<RevenueRow>(s=>{
  if(s.kind==='training')return allocations.has(s.id)?[{session:s,grosz:allocations.get(s.id)!,category:s.status==='completed'?'training' as const:'absence' as const,service:db.packages.find(p=>p.id===s.packageId)?.service||''}]:[];
  const sale=db.sales.find(x=>x.sessionId===s.id&&x.status==='paid');
  return sale?[{session:s,grosz:Math.round(sale.amount*100),category:s.status==='completed'?'consultation' as const:'absence' as const,service:'consultation'}]:[];
 });
}
