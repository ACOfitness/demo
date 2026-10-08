/** Accept international phone numbers while rejecting arbitrary contact text. */
export function validPhone(value:string){
 return /^\+?[\d\s().-]+$/.test(value.trim()) && /^\d{7,15}$/.test(value.replace(/\D/g,''));
}
export function validPesel(value:string){
 if(!/^\d{11}$/.test(value))return false;
 const digits=[...value].map(Number),weights=[1,3,7,9,1,3,7,9,1,3];
 return (10-digits.slice(0,10).reduce((sum,n,i)=>sum+n*weights[i],0)%10)%10===digits[10];
}
