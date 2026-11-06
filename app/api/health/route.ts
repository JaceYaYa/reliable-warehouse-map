import { env } from "cloudflare:workers";
import { asc,count,desc,lt } from "drizzle-orm";
import { getDb } from "../../../db";
import { auditLogs,sessions,stocks,users } from "../../../db/schema";
import { requireUser } from "../../../lib/auth";

export async function GET(req:Request){
 const auth=await requireUser(req,"health.view");if(auth.error)return auth.error;const db=getDb(),cutoff=new Date(Date.now()-365*86400000).toISOString();
 const [[{stockCount}],[{logCount}],[{archiveDue}],[{userCount}],[{sessionCount}],oldest,newest,backupList,archiveList]=await Promise.all([
  db.select({stockCount:count()}).from(stocks),db.select({logCount:count()}).from(auditLogs),db.select({archiveDue:count()}).from(auditLogs).where(lt(auditLogs.createdAt,cutoff)),db.select({userCount:count()}).from(users),db.select({sessionCount:count()}).from(sessions),db.select({createdAt:auditLogs.createdAt}).from(auditLogs).orderBy(asc(auditLogs.id)).limit(1),db.select({createdAt:auditLogs.createdAt}).from(auditLogs).orderBy(desc(auditLogs.id)).limit(1),env.BACKUPS.list({prefix:"backups/",limit:1000}),env.BACKUPS.list({prefix:"archives/",limit:1000})
 ]);
 let databaseBytes:number|null=null;try{const pages=await env.DB.prepare("PRAGMA page_count").first<{page_count:number}>(),size=await env.DB.prepare("PRAGMA page_size").first<{page_size:number}>();if(pages&&size)databaseBytes=pages.page_count*size.page_size}catch{}
 const objects=[...backupList.objects,...archiveList.objects],latestDaily=backupList.objects.filter(x=>x.key.includes("/daily-")).sort((a,b)=>b.uploaded.getTime()-a.uploaded.getTime())[0];
 return Response.json({checkedAt:new Date().toISOString(),database:{stockCount,logCount,archiveDue,userCount,sessionCount,bytes:databaseBytes,oldestLogAt:oldest[0]?.createdAt||null,newestLogAt:newest[0]?.createdAt||null},storage:{fileCount:objects.length,totalBytes:objects.reduce((n,x)=>n+x.size,0),archiveCount:archiveList.objects.length,latestDailyAt:latestDaily?.uploaded||null},policy:{dailyRetention:90,monthlyRetention:12,archiveAfterDays:365}});
}
