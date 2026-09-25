import type {Database} from '../src/auth';
export const collections=['accounts','clients','trainers','sessions','packages','holds','messages','sales','substitutions','audit','blocks','letters','promotions','extraHours'] as const;
const maps=['settings','productCopies','noticeReads'] as const;
export interface Entity {kind:string;id:string;payload:Record<string,unknown>}
export interface Snapshot {revision:number;now:string;role:string;entities:Entity[]}
export function encode(db:Database):Entity[]{
 const records:Entity[]=[];
 for(const kind of collections)for(const row of db[kind]||[]){
  const payload=structuredClone(row) as unknown as Record<string,unknown>;
  if(kind==='accounts'){delete payload.password;delete payload.token}
  records.push({kind,id:row.id,payload});
 }
 for(const kind of maps)if(db[kind])records.push({kind,id:'singleton',payload:structuredClone(db[kind]) as unknown as Record<string,unknown>});
 return records;
}
export function decode(snapshot:Snapshot):Database {
 const db={version:1,now:new Date(snapshot.now).toISOString(),settings:{personal:180,physio:220,consultation:250,cancelHours:24}} as Database;
 for(const kind of collections)(db[kind] as unknown)=[];
 for(const row of snapshot.entities){
  if((collections as readonly string[]).includes(row.kind)){
   if(row.payload.id!==row.id)throw Error('Inconsistent entity identity');
   (db[row.kind as typeof collections[number]] as unknown[]).push(structuredClone(row.payload));
  }else if((maps as readonly string[]).includes(row.kind)){
   if(row.id!=='singleton')throw Error('Inconsistent singleton');
   (db[row.kind as typeof maps[number]] as unknown)=structuredClone(row.payload);
  }else throw Error('Unexpected entity');
 }
 // Database rows have no defined order. Keep newest records first where UI expects it.
 db.holds.sort((a,b)=>b.expires.localeCompare(a.expires));
 db.messages.sort((a,b)=>b.at.localeCompare(a.at));
 db.audit.sort((a,b)=>b.at.localeCompare(a.at));
 db.letters?.sort((a,b)=>b.at.localeCompare(a.at));
 return db;
}
export function changes(before:Database,after:Database){
 const old=new Map(encode(before).map(e=>[e.kind+':'+e.id,e]));
 const next=encode(after),modified:Entity[]=[];
 for(const e of next){const key=e.kind+':'+e.id;if(JSON.stringify(old.get(key)?.payload)!==JSON.stringify(e.payload))modified.push(e);old.delete(key)}
 return {changes:modified,removed:[...old.values()].map(({kind,id})=>({kind,id}))};
}
