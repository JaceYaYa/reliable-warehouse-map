import {warehouseDayBoundary} from './warehouse-time';
export type RecordFilters={q:string;action:string;from:string;to:string;operator:string;location:string;customer:string;status:string};
export const emptyRecordFilters=():RecordFilters=>({q:"",action:"",from:"",to:"",operator:"",location:"",customer:"",status:""});
export const recordDateBoundary=warehouseDayBoundary;
export function readRecordFilters(params:URLSearchParams):RecordFilters{
 const f=emptyRecordFilters();for(const key of Object.keys(f) as (keyof RecordFilters)[]){f[key]=(params.get(key)||"").trim();if(f[key].length>500)throw new Error("筛选内容过长");}
 recordDateBoundary(f.from);recordDateBoundary(f.to);if(f.from&&f.to&&f.from>f.to)throw new Error("开始日期不能晚于结束日期");
 if(f.status&&!['active','restored'].includes(f.status))throw new Error("记录状态无效");return f;
}
export function recordFilterQuery(f:RecordFilters){const p=new URLSearchParams();for(const [key,value] of Object.entries(f))if(value)p.set(key,value);return p;}
export function matchesRecordDate(stamp:string,f:Pick<RecordFilters,"from"|"to">){const start=recordDateBoundary(f.from),end=recordDateBoundary(f.to,true),t=Date.parse(stamp);return(!start||t>=Date.parse(start))&&(!end||t<Date.parse(end));}
