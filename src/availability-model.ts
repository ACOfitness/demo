export function availabilityRanges(hours:number[]){
 const ranges:{from:number;to:number}[]=[];
 for(const hour of [...new Set(hours)].sort((a,b)=>a-b)){
  const last=ranges.at(-1);
  if(last&&last.to===hour)last.to=hour+1;
  else ranges.push({from:hour,to:hour+1});
 }
 return ranges;
}
export function toggleAvailabilityHour(hours:number[],hour:number){
 const next=hours.includes(hour)?hours.filter(h=>h!==hour):[...hours,hour];
 if(availabilityRanges(next).length>3)throw Error('W jednym dniu można ustawić maksymalnie 3 zakresy godzin.');
 return next.sort((a,b)=>a-b);
}
