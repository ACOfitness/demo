/** Polish statutory public holidays. Sundays remain bookable unless they are a named holiday. */
export function holidayName(date:string):string|undefined {
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return;
 const year=Number(date.slice(0,4)),md=date.slice(5);
 const fixed:Record<string,string>={'01-01':'Nowy Rok','01-06':'Trzech Króli','05-01':'Święto Pracy','05-03':'Święto Konstytucji 3 Maja','08-15':'Wniebowzięcie NMP','11-01':'Wszystkich Świętych','11-11':'Święto Niepodległości','12-25':'Boże Narodzenie','12-26':'Drugi dzień Bożego Narodzenia'};
 if(fixed[md])return fixed[md];if(year>=2025&&md==='12-24')return 'Wigilia';
 const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),n=h+l-7*m+114;
 const easter=Date.UTC(year,Math.floor(n/31)-1,n%31+1);
 const delta=Math.round((Date.parse(date+'T00:00:00Z')-easter)/86400000);
 return ({0:'Wielkanoc',1:'Poniedziałek Wielkanocny',49:'Zielone Świątki',60:'Boże Ciało'} as Record<number,string>)[delta];
}
