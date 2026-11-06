import {automaticPalletRows} from './automatic-pallets.ts';
export const STOCK_PALLET_SETTINGS_SQL="SELECT key,value,updated_at AS updatedAt FROM settings WHERE key LIKE 'pallet_manual:stock:%' ORDER BY key";
export const STOCK_PALLET_AUDITS_SQL="SELECT action,before_snapshot AS beforeValue,after_snapshot AS afterValue FROM audit_logs WHERE action='库存修改' AND json_valid(before_snapshot) AND json_valid(after_snapshot) AND json_type(before_snapshot,'$.palletCount') IN ('integer','real') AND json_type(after_snapshot,'$.palletCount') IN ('integer','real') AND json_extract(before_snapshot,'$.palletCount')<>json_extract(after_snapshot,'$.palletCount')";
type Reader={prepare:(sql:string)=>{bind:(...values:unknown[])=>{all:()=>Promise<{results:Record<string,unknown>[]}>}}};
export async function loadStockPalletMetadata(client:Reader){const [a,b]=await Promise.all([client.prepare(STOCK_PALLET_SETTINGS_SQL).bind().all(),client.prepare(STOCK_PALLET_AUDITS_SQL).bind().all()]);return{settings:a.results as Array<{key:string;value:string;updatedAt?:string}>,audits:b.results};}
export function projectStockPallets<T extends Parameters<typeof automaticPalletRows>[0][number]>(rows:readonly T[],meta:Awaited<ReturnType<typeof loadStockPalletMetadata>>){return automaticPalletRows(rows,meta.settings,meta.audits).map(row=>({...row,palletManual:!row.palletAutomatic}));}

/** Compare physical stored facts independently of a current automatic display share. */
export function stockStoredImage<T extends {palletCount:number;palletLabel:string;palletRawCount?:number;palletRawLabel?:string;palletAutomatic?:boolean;palletManual?:boolean}>(row:T){
 const {palletManual,palletAutomatic,palletRawCount,palletRawLabel,...stored}=row;
 void palletManual;void palletAutomatic;
 return {...stored,palletCount:palletRawCount??row.palletCount,palletLabel:palletRawLabel??row.palletLabel};
}
