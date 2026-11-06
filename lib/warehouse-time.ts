/** Business calendar is New York; persisted audit instants remain UTC. */
export const WAREHOUSE_TIME_ZONE = 'America/New_York';
const warehouseDateFormatter=new Intl.DateTimeFormat('en-US',{timeZone:WAREHOUSE_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'});
export function warehouseTodayDate(now = new Date()) {
 const parts = warehouseDateFormatter.formatToParts(now);
 const values = new Map(parts.map(p=>[p.type,p.value]));
 return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
}
export function warehouseTimestamp(value:string|Date) {
 const date=new Date(value);if(!Number.isFinite(date.getTime()))return String(value||'—');
 return new Intl.DateTimeFormat('zh-CN',{timeZone:WAREHOUSE_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'short'}).format(date);
}
export function warehouseCalendarDays(from:string,to=warehouseTodayDate()) {
 const a=Date.parse(`${from}T00:00:00Z`),b=Date.parse(`${to}T00:00:00Z`);
 return Number.isFinite(a)&&Number.isFinite(b)?Math.max(0,Math.floor((b-a)/86400000)):0;
}
export function warehouseDayBoundary(value:string,end=false) {
 if(!value)return undefined;
 if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('日期格式不正确');
 const date=new Date(`${value}T00:00:00Z`);
 if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value)throw new Error('日期无效');
 const target=date.getTime()+(end?86400000:0);
 let guess=target+5*3600000;
 // Solve local midnight rather than adding 24h to the previous boundary (DST).
 for(let i=0;i<3;i++){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:WAREHOUSE_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(guess));
  const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));
  const local=Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour),Number(p.minute),Number(p.second));
  const next=target-(local-guess);if(next===guess)break;guess=next;
 }
 return new Date(guess).toISOString();
}
