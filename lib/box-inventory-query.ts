import {filterInventory,type InventoryGroup,type InventoryStock} from './inventory-groups';
import type {CartonReceipt} from './carton-flow';
import {boxInventoryRecords} from './box-inventory-records';
import {searchWarehouseRecords} from './warehouse-search';
type Filters={query?:string;customers?:readonly string[];status?:string};

/** List, map and outbound all search the same box inventory fields and receipt aliases. */
export function filterCartonInventory(receipts:readonly CartonReceipt[],{query='',customers=[],status='all'}:Filters={}){
 const scoped=receipts.map(r=>{const placements=r.placements.filter(p=>{const customer=p.details?.customerName??r.customerName;return p.boxes>0&&(!customers.length||customers.includes(customer)||(customers.includes('__missing__')&&!customer));});return {...r,placements,totalBoxes:placements.reduce((sum,p)=>sum+p.boxes,0),status:placements.every(p=>p.details?.customerName??r.customerName)?'claimed' as const:'pending' as const};});
 const eligible=scoped.filter(r=>{
  const positive=r.placements;if(!positive.length)return false;
  // A receipt is one original inventory group; sharing a receipt does not establish product association.
  if(status==='linked')return false;
  if(status==='review'&&positive.every(p=>(p.details?.customerName??r.customerName)&&p.product))return false;
  return true;
 });
 if(!query.trim())return eligible;
 const found=new Set(searchWarehouseRecords(boxInventoryRecords([],eligible),query).flatMap(r=>r.reference.kind==='carton'?[r.reference.id]:[]));
 return eligible.filter(r=>found.has(r.id));
}

export function filterBoxInventoryGroups<T extends InventoryStock>(groups:readonly InventoryGroup<T>[],{query='',customers=[],status='all'}:Filters={}){
 const eligible=filterInventory(groups,'box',[...customers],'',status);
 if(!query.trim())return eligible;
 const records=eligible.flatMap(group=>boxInventoryRecords(group.members.map(m=>m.stock),[]).map(row=>({...row,groupKey:group.key,product:[row.product,group.product].join(' '),sku:[row.sku,group.sku].filter(Boolean).join(' / ')})));
 const found=new Set(searchWarehouseRecords(records,query).map(r=>r.groupKey));
 return eligible.filter(group=>found.has(group.key));
}
