export function duration(hours:number){const minutes=Math.round(hours*60),h=Math.floor(minutes/60),m=minutes%60;return h?(h+' godz.'+(m?' '+m+' min':'')):m+' min'}
