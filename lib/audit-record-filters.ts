import {and,eq,sql,type SQL} from "drizzle-orm";
import {auditLogs} from "../db/schema";
import {loadLocationAliases} from "./location-alias-store";
import {resolveLocationAlias} from "./location-aliases";
import {recordDateBoundary,type RecordFilters} from "./record-filters";
const contains=(column:SQL|typeof auditLogs.summary|typeof auditLogs.entityId,value:string)=>sql`instr(lower(coalesce(${column},'')),lower(${value}))>0`;
export function auditRecordConditions(f:RecordFilters){
 const start=recordDateBoundary(f.from),end=recordDateBoundary(f.to,true);
 const search=f.q?sql`(${contains(auditLogs.userName as unknown as SQL,f.q)} OR ${contains(auditLogs.entityId,f.q)} OR ${contains(auditLogs.summary,f.q)})`:undefined;
 return and(search,f.action?eq(auditLogs.action,f.action):undefined,f.operator?eq(auditLogs.userName,f.operator):undefined,start?sql`julianday(${auditLogs.createdAt})>=julianday(${start})`:undefined,end?sql`julianday(${auditLogs.createdAt})<julianday(${end})`:undefined,f.customer?contains(auditLogs.summary,f.customer):undefined);
}
export async function auditFilterOptions(db:ReturnType<typeof import("../db").getDb>,scope:SQL|undefined){
 const values=await db.select({action:auditLogs.action,operator:auditLogs.userName}).from(auditLogs).where(scope).groupBy(auditLogs.action,auditLogs.userName);
 return{actions:[...new Set(values.map(v=>v.action))].sort((a,b)=>a.localeCompare(b,"zh-CN")),operators:[...new Set(values.map(v=>v.operator))].sort((a,b)=>a.localeCompare(b,"zh-CN"))};
}
export async function auditLocationCondition(location:string){
 if(!location)return undefined;
 const aliases=await loadLocationAliases(),canonical=resolveLocationAlias(location,aliases),names=[canonical,...Object.keys(aliases).filter(code=>resolveLocationAlias(code,aliases)===canonical)];
 const tokens=sql`'、'||replace(replace(replace(replace(replace(replace(${auditLogs.entityId},' → ','、'),'→','、'),',','、'),'，','、'),char(13),'、'),char(10),'、')||'、'`;
 const cartonLocation=sql`(${auditLogs.entityType} IN ('箱件收货','箱件原操作') AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(${auditLogs.afterSnapshot}) THEN COALESCE(json_extract(${auditLogs.afterSnapshot},'$.placements'),'[]') WHEN json_valid(${auditLogs.beforeSnapshot}) THEN COALESCE(json_extract(${auditLogs.beforeSnapshot},'$.placements'),'[]') ELSE '[]' END) cp WHERE ${sql.join(names.map(code=>sql`json_extract(cp.value,'$.locationCode')=${code}`),sql` OR `)}))`;
 return sql`(${sql.join(names.map(code=>sql`instr(${tokens},${'、'+code+'、'})>0`),sql` OR `)} OR ${cartonLocation})`;
}
