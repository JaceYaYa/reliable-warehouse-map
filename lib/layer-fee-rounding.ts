import type {LayerStorageReportRow} from './layer-storage-report-types';

/** Round once per customer, distribute fractional cents by layer, then by interval.
 * UI and exported detail consequently add up to the exact customer total.
 */
export function layerDisplayFees(rows:readonly LayerStorageReportRow[]):Map<string,number|null>{
 // Transport compaction carries the original per-row cent allocation. Reallocating
 // after adjacent intervals merge could move a cent between physical cohorts.
 if(rows.every(row=>row.feeUsd===null?row.displayFeeUsd===null:typeof row.displayFeeUsd==='number'&&Number.isFinite(row.displayFeeUsd)&&row.displayFeeUsd>=0))return new Map(rows.map(row=>[row.key,row.displayFeeUsd!]));
 const result=new Map(rows.map(row=>[row.key,row.feeUsd===null?null:0]));
 const allocate=(amounts:number[],target:number)=>{
  const cents=amounts.map(n=>Math.floor(n*100+1e-8));let left=target-cents.reduce((n,v)=>n+v,0);
  const order=amounts.map((n,index)=>({index,fraction:n*100-cents[index]})).sort((a,b)=>b.fraction-a.fraction||a.index-b.index);
  for(const item of order)if(left>0){cents[item.index]++;left--;}
  return cents;
 };
 const customers=new Map<string,LayerStorageReportRow[]>();for(const row of rows)if(row.feeUsd!==null){const own=customers.get(row.customerName)??[];own.push(row);customers.set(row.customerName,own);}
 for(const own of customers.values()){
  const layers=new Map<string,LayerStorageReportRow[]>();for(const row of own){const key=JSON.stringify([row.locationCode,row.layer]),items=layers.get(key)??[];items.push(row);layers.set(key,items);}
  const groups=[...layers.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,items])=>items.sort((a,b)=>a.key.localeCompare(b.key)));
  const amounts=groups.map(items=>items.reduce((n,row)=>n+row.feeUsd!,0)),target=Math.round(Number(own.reduce((n,row)=>n+row.feeUsd!,0).toFixed(2))*100),layerCents=allocate(amounts,target);
  groups.forEach((items,index)=>{const cents=allocate(items.map(row=>row.feeUsd!),layerCents[index]);items.forEach((row,n)=>result.set(row.key,cents[n]/100));});
 }
 return result;
}
