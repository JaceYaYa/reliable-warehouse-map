export function summarizeLocations(stocks:readonly {locationCode:string;product:string;customerName:string;totalQuantity:number;totalBoxes:number}[],cartons:readonly {placements:readonly {locationCode:string;boxes:number}[]}[]){
 const result:Record<string,string>={},codes=new Set([...stocks.map(s=>s.locationCode),...cartons.flatMap(c=>c.placements.map(p=>p.locationCode))]);
 for(const code of codes){const rows=stocks.filter(s=>s.locationCode===code&&(s.totalQuantity>0||s.totalBoxes>0)),boxes=cartons.flatMap(c=>c.placements).filter(p=>p.locationCode===code).reduce((sum,p)=>sum+p.boxes,0),products=new Set(rows.map(s=>s.customerName+'|'+s.product)).size;result[code]=`${products} 种产品 · ${rows.reduce((s,r)=>s+r.totalQuantity,0)}件 / ${rows.reduce((s,r)=>s+r.totalBoxes,0)}箱${boxes?` · 另有 ${boxes}箱件`:''}`;}
 return result;
}
