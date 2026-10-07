export function csv(rows:readonly (readonly unknown[])[]):string {
 return '\ufeff'+rows.map(row=>row.map(value=>{
  let text=String(value??'');
  if(/^[\s\u0000-\u001f]*[=+@-]/.test(text))text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
 }).join(';')).join('\r\n');
}
