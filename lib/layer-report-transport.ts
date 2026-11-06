import type {LayerStorageReport,LayerStorageReportRow} from './layer-storage-report-types';
import {layerDisplayFees} from './layer-fee-rounding';

type CompactRow=LayerStorageReportRow & {displayFeeUsd:number|null};
type WireSection={rowKeys:string[];feeUsd:number};
type WireReport=Omit<LayerStorageReport,'rows'|'sections'> & {
 transport:'layer-report-v1';rows:CompactRow[];
 sections?:{inStock:WireSection;shipped:WireSection;uncalculable:NonNullable<LayerStorageReport['sections']>['uncalculable']};
};

/** Compress a read result, never the source ledger. Each unchanged cohort remains
 * independently dated; preserve the already allocated cents before coalescing. */
export function encodeLayerReport(report:LayerStorageReport):WireReport{
 const allocated=layerDisplayFees(report.rows),shipped=new Set(report.sections?.shipped.rows.map(row=>row.key)??[]);
 const rows:CompactRow[]=[],previous=new Map<string,CompactRow>(),keys=new Map<string,string>();
 for(const source of report.rows){
  const section=source.section??(shipped.has(source.key)?'shipped':'in_stock');
  const {key,startDate,endDateExclusive,storageDays,billableDays,feeUsd,evidenceIds,overlappingBillIds,...facts}=source;
  const signature=JSON.stringify({...facts,section}),last=previous.get(signature),display=allocated.get(key)??null;
  if(last&&last.endDateExclusive===startDate){
   last.endDateExclusive=endDateExclusive;last.storageDays+=storageDays;last.billableDays+=billableDays;
   last.feeUsd=last.feeUsd===null||feeUsd===null?null:last.feeUsd+feeUsd;
   last.displayFeeUsd=last.displayFeeUsd===null||display===null?null:Number((last.displayFeeUsd+display).toFixed(2));
   last.evidenceIds=[...new Set([...last.evidenceIds,...evidenceIds])];
   last.overlappingBillIds=[...new Set([...(last.overlappingBillIds??[]),...(overlappingBillIds??[])])];
   keys.set(key,last.key);
  }else{
   const row={...source,section,evidenceIds:[...evidenceIds],displayFeeUsd:display};
   rows.push(row);previous.set(signature,row);keys.set(key,key);
  }
 }
 const section=(value:NonNullable<LayerStorageReport['sections']>['inStock']):WireSection=>({rowKeys:[...new Set(value.rows.map(row=>keys.get(row.key)!))],feeUsd:value.feeUsd});
 return {...report,transport:'layer-report-v1',rows,sections:report.sections?{inStock:section(report.sections.inStock),shipped:section(report.sections.shipped),uncalculable:report.sections.uncalculable}:undefined};
}

/** Restore shared row references once at the client boundary, not duplicate JSON. */
export function decodeLayerReport(value:unknown):LayerStorageReport{
 if(!value||typeof value!=='object')throw Error('托层报告资料不完整，请重试');
 const wire=value as WireReport;
 if(wire.transport===undefined)return value as LayerStorageReport;
 if(wire.transport!=='layer-report-v1')throw Error('托层报告资料不完整，请重试');
 if(!Array.isArray(wire.rows))throw Error('托层报告资料不完整，请重试');
 for(const row of wire.rows)if(!row||typeof row.key!=='string'||!['in_stock','shipped'].includes(row.section??'')||(row.feeUsd===null?row.displayFeeUsd!==null:typeof row.displayFeeUsd!=='number'||!Number.isFinite(row.displayFeeUsd)||row.displayFeeUsd<0))throw Error('托层报告资料不完整，请重试');
 const rows=new Map(wire.rows.map(row=>[row.key,row]));
 if(rows.size!==wire.rows.length)throw Error('托层报告资料不完整，请重试');
 const section=(source:WireSection,name:'in_stock'|'shipped')=>{
  if(!source||!Array.isArray(source.rowKeys)||new Set(source.rowKeys).size!==source.rowKeys.length||!Number.isFinite(source.feeUsd))throw Error('托层报告资料不完整，请重试');
  const own=source.rowKeys.map(key=>{const row=rows.get(key);if(!row||row.section!==name||row.feeUsd===null)throw Error('托层报告资料不完整，请重试');return row;});
  if(own.length!==wire.rows.filter(row=>row.section===name&&row.feeUsd!==null).length||Math.round(own.reduce((sum,row)=>sum+row.displayFeeUsd!,0)*100)!==Math.round(source.feeUsd*100))throw Error('托层报告资料不完整，请重试');
  return {feeUsd:source.feeUsd,rows:own};
 };
 return {...wire,sections:wire.sections?{inStock:section(wire.sections.inStock,'in_stock'),shipped:section(wire.sections.shipped,'shipped'),uncalculable:wire.sections.uncalculable}:undefined};
}
