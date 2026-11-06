import type {OutboundHistoryRecord} from './outbound-history';
import {resolveMerchantName,type MerchantAliases} from './merchant-identity';
import {warehouseTodayDate} from './warehouse-time';
import {validFreePeriodDate} from './storage-free-periods';

type Bill=Record<string,unknown>;
const text=(value:unknown)=>typeof value==='string'?value.trim():'';
function outboundDay(value:unknown){
 const s=text(value);if(validFreePeriodDate(s))return s;
 return /^\d{4}-\d\d-\d\dT/.test(s)&&Number.isFinite(Date.parse(s))?warehouseTodayDate(new Date(s)):null;
}

/** Read-time visibility only. Exact operation, stock cohort, dates and quantities
 * prove the link. Original bills and outbound correction revisions remain unchanged. */
export function migratedLegacyBillIds(bills:readonly Bill[],raw:readonly OutboundHistoryRecord[],corrected:readonly OutboundHistoryRecord[],direct:readonly {id:unknown;operationId:unknown}[],aliases:MerchantAliases):Set<number>{
 const directOps=new Map(direct.map(row=>['audit:'+row.id,text(row.operationId)]));
 const byKey=new Map(corrected.map(row=>[row.key,row])),rawByKey=new Map(raw.map(row=>[row.key,row]));
 const sources=new Map<string,OutboundHistoryRecord[]>();
 for(const row of raw){
  const op=row.key.startsWith('audit:')?directOps.get(row.key):row.key.startsWith('goods:')?row.key.slice(6,row.key.lastIndexOf(':')):undefined;
  if(!op||!row.physicalId)continue;
  const k=JSON.stringify([op,row.physicalId]),entries=sources.get(k)??[];entries.push(row);sources.set(k,entries);
 }
 const migrated=new Set<number>();
 for(const bill of bills){
  if(!Number.isSafeInteger(bill.id)||!Number.isSafeInteger(bill.stockId))continue;
  const operation=text(bill.operationId),base=operation.includes(':cost:')?operation.slice(0,operation.indexOf(':cost:')):operation;
  const candidates=sources.get(JSON.stringify([base,'stock:'+bill.stockId]))??[];
  // A retained settlement can itself be the source after an explicit correction.
  const own=rawByKey.get('settlement:'+bill.id);
  const matches=own?[...candidates,own]:candidates;
  if(matches.length!==1)continue;
  const source=matches[0],record=byKey.get(source.key);
  if(!record||record.billingDetailsConflict||record.customerCorrectionConflict)continue;
  if(source.inboundDate!==text(bill.inboundDate)||source.outboundDate!==outboundDay(bill.outboundAt)||source.quantity!==bill.quantity||source.boxes!==bill.boxes)continue;
  if(!validFreePeriodDate(record.inboundDate)||!validFreePeriodDate(record.outboundDate)||record.outboundDate<record.inboundDate||!record.locationCode.trim()||!Number.isSafeInteger(record.layer)||(record.layer??0)<1)continue;
  const owner=resolveMerchantName(record.customerName,aliases);
  if(owner&&owner!==text(bill.customerName))migrated.add(bill.id as number);
 }
 return migrated;
}
