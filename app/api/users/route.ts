import { effectivePermissions, hasPermission } from "../../../lib/permissions";
import { and, eq, exists, inArray, ne, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb } from "../../../db";
import { auditLogs, sessions, users } from "../../../db/schema";
import { hashPassword, requireUser } from "../../../lib/auth";
import { recordAudit } from "../../../lib/audit";
import { normalizeUserRole, userRoleLabel, isProtectedOwnerUsername } from "../../../lib/roles";
type AccountPayload = {id?:number;username?:string;displayName?:string;password?:string;role?:unknown;active?:number;permissions?:unknown;expectedVersion?:number;confirmUsername?:string};
async function accountPayload(req:Request):Promise<AccountPayload|null>{
 try{const value=await req.json();return value&&typeof value==="object"&&!Array.isArray(value)?value:null;}catch{return null;}
}
const invalidPayload=()=>Response.json({error:"账号提交格式无效"},{status:400});
const batchTuple=(queries:BatchItem<"sqlite">[])=>queries as [BatchItem<"sqlite">,...BatchItem<"sqlite">[]];
export async function GET(req:Request){const a=await requireUser(req,"users.manage");if(a.error)return a.error;const rows=await getDb().select({id:users.id,username:users.username,displayName:users.displayName,role:users.role,active:users.active,createdAt:users.createdAt,permissions:users.permissions,permissionVersion:users.permissionVersion}).from(users);return Response.json({users:rows.map(u=>({...u,permissions:effectivePermissions(u)}))})}
export async function POST(req:Request){
 const a=await requireUser(req,"users.manage");if(a.error)return a.error;
 const p=await accountPayload(req);if(!p)return invalidPayload();
 if(p.permissions!==undefined)return Response.json({error:"请使用固定角色，不再支持单独授权"},{status:400});
 const role=normalizeUserRole(p.role);
 if(role!=="employee"&&role!=="admin")return Response.json({error:"请选择员工或管理员"},{status:400});
 if(typeof p.username!=="string"||typeof p.displayName!=="string"||typeof p.password!=="string"||!p.username.trim()||!p.displayName.trim()||p.password.length<8)return Response.json({error:"账号、姓名必填，密码至少8位"},{status:400});
 if(isProtectedOwnerUsername(p.username))return Response.json({error:"老板账号受保护，不能创建或分配"},{status:403});
 const h=await hashPassword(p.password!);
 try {const [u]=await getDb().insert(users).values({username:p.username.trim().toLowerCase(),displayName:p.displayName.trim(),role,permissions:null,passwordHash:h.hash,passwordSalt:h.salt,active:1,mustChange:1,createdAt:new Date().toISOString()}).returning({id:users.id,username:users.username,displayName:users.displayName});
 await recordAudit(a.user!,"创建账号","系统账号",u.username,`${u.displayName} · ${userRoleLabel(role)}`);return Response.json({user:u});}catch{return Response.json({error:"账号已存在"},{status:409})}
}
export async function PATCH(req:Request){
 const a=await requireUser(req,"users.manage");if(a.error)return a.error;
 const p=await accountPayload(req);if(!p)return invalidPayload();
 if(!Number.isSafeInteger(p.id)||Number(p.id)<=0)return Response.json({error:"缺少用户"},{status:400});
 const db=getDb(),[target]=await db.select().from(users).where(eq(users.id,p.id!)).limit(1);
 if(!target)return Response.json({error:"账号不存在"},{status:404});
 if(isProtectedOwnerUsername(target.username)||target.id===a.user!.id)return Response.json({error:"不能在此修改老板或当前登录账号"},{status:403});
 if(!Number.isSafeInteger(p.expectedVersion)||p.expectedVersion!==target.permissionVersion)return Response.json({error:"账号已更新，请刷新后重试"},{status:409});
 if(p.permissions!==undefined)return Response.json({error:"请使用固定角色，不再支持单独授权"},{status:400});
 if([p.role,p.password,p.active].filter(value=>value!==undefined).length!==1)return Response.json({error:"每次只能修改一项账号设置"},{status:400});
 let change:Partial<typeof users.$inferInsert>,action:string,summary="";
 if(p.role!==undefined){const role=normalizeUserRole(p.role);if(role!=="employee"&&role!=="admin")return Response.json({error:"请选择员工或管理员"},{status:400});
 change={role,permissions:null};action="修改账号角色";summary=`${userRoleLabel(target.role)} → ${userRoleLabel(role)}`;
 }else if(p.password!==undefined){if(typeof p.password!=="string"||p.password.length<8)return Response.json({error:"密码至少8位"},{status:400});const h=await hashPassword(p.password);change={passwordHash:h.hash,passwordSalt:h.salt,mustChange:1};action="重置密码";
 }else if(p.active===0||p.active===1){change={active:p.active};action=p.active?"启用账号":"停用账号";
 }else return Response.json({error:"没有有效的修改内容"},{status:400});
 const operationId=`user-permissions:${target.id}:${crypto.randomUUID()}`,stamp=new Date().toISOString();
 const result=await db.batch(batchTuple([
 db.update(users).set({...change,permissionVersion:target.permissionVersion+1}).where(and(eq(users.id,target.id),eq(users.permissionVersion,target.permissionVersion))).returning({id:users.id}),
 db.insert(auditLogs).select(db.select({id:sql<number>`null`.as("id"),userId:sql<number>`${a.user!.id}`.as("user_id"),userName:sql<string>`${a.user!.displayName}`.as("user_name"),action:sql<string>`${action}`.as("action"),entityType:sql<string>`'系统账号'`.as("entity_type"),entityId:sql<string>`${target.username}`.as("entity_id"),operationId:sql<string>`${operationId}`.as("operation_id"),summary:sql<string>`${summary}`.as("summary"),beforeSnapshot:sql<string|null>`null`.as("before_snapshot"),afterSnapshot:sql<string|null>`null`.as("after_snapshot"),createdAt:sql<string>`${stamp}`.as("created_at")}).from(users).where(and(eq(users.id,target.id),sql`changes() = 1`)))
 ]));
 if(!result[0]?.length)return Response.json({error:"账号已更新，请刷新后重试"},{status:409});
 return Response.json({ok:true});
}
export async function DELETE(req:Request){const a=await requireUser(req,"users.manage");if(a.error)return a.error;const p=await accountPayload(req);if(!p)return invalidPayload();if(!Number.isSafeInteger(p.id)||Number(p.id)<=0)return Response.json({error:"缺少用户"},{status:400});if(p.id===a.user!.id)return Response.json({error:"不能删除当前登录账号"},{status:403});const db=getDb(),[target]=await db.select({id:users.id,username:users.username,displayName:users.displayName,role:users.role,permissions:users.permissions,permissionVersion:users.permissionVersion,active:users.active}).from(users).where(eq(users.id,p.id!)).limit(1);if(!target)return Response.json({error:"账号不存在"},{status:404});if(effectivePermissions(target).some(key=>!hasPermission(a.user!,key)))return Response.json({error:"不能删除权限高于自己的账号"},{status:403});const role=normalizeUserRole(target.role),protectedBoss=isProtectedOwnerUsername(target.username);if(protectedBoss||role==="admin")return Response.json({error:"老板和管理员账号受保护，不能删除"},{status:403});if(role!=="employee"&&role!=="warehouse")return Response.json({error:"账号角色无效，不能删除"},{status:403});if(p.confirmUsername!==target.username)return Response.json({error:"账号确认信息不一致，请刷新后重试"},{status:409});if(target.active)return Response.json({error:"请先停用账号，再进行删除"},{status:409});const operationId=`delete-user:${target.id}:${crypto.randomUUID()}`,stamp=new Date().toISOString(),summary=`${target.displayName} · ${target.username} · ${role}；历史操作记录保留`,targetCondition=and(eq(users.id,target.id),eq(users.active,0),ne(users.id,a.user!.id),inArray(users.role,["employee","warehouse"]),sql`lower(trim(${users.username})) NOT IN ('boss','xmcxmc')`,eq(users.username,target.username),eq(users.permissionVersion,target.permissionVersion)),auditGate=exists(db.select({id:auditLogs.id}).from(auditLogs).where(eq(auditLogs.operationId,operationId))),auditInsert=db.insert(auditLogs).select(db.select({id:sql<number>`null`.as("id"),userId:sql<number>`${a.user!.id}`.as("user_id"),userName:sql<string>`${a.user!.displayName}`.as("user_name"),action:sql<string>`'删除账号'`.as("action"),entityType:sql<string>`'系统账号'`.as("entity_type"),entityId:sql<string>`${String(target.id)}`.as("entity_id"),operationId:sql<string>`${operationId}`.as("operation_id"),summary:sql<string>`${summary}`.as("summary"),beforeSnapshot:sql<string|null>`null`.as("before_snapshot"),afterSnapshot:sql<string|null>`null`.as("after_snapshot"),createdAt:sql<string>`${stamp}`.as("created_at")}).from(users).where(targetCondition)).returning({id:auditLogs.id}),results=await db.batch(batchTuple([
 auditInsert,
 db.delete(sessions).where(and(eq(sessions.userId,target.id),auditGate)),
 db.delete(users).where(and(targetCondition,auditGate)).returning({id:users.id}),
]));if(!results[0]?.length||!results[2]?.length)return Response.json({error:"账号状态已变化，请刷新后重试"},{status:409});return Response.json({ok:true})}
