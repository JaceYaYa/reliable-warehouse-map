export type CorrectionDate={date:string;kind:string;label:string;locationCode?:string};
export function filterCorrectionHistory<T extends CorrectionDate>(dates:readonly T[],filters:{location?:string;kind?:string;query?:string;limit?:number;offset?:number}){
 const q=(filters.query||'').normalize('NFKC').trim().toLowerCase();
 const matches=dates.filter(d=>(!filters.location||d.locationCode===filters.location)&&(!filters.kind||d.kind===filters.kind)&&(!q||[d.date,d.kind,d.label,d.locationCode||''].join(' ').normalize('NFKC').toLowerCase().includes(q)));
 return {total:matches.length,items:matches.slice(Math.max(0,filters.offset??0),Math.max(0,filters.offset??0)+Math.max(1,Math.min(100,filters.limit??20)))};
}
