import { and, eq, gt } from "drizzle-orm";
import { getDb } from "../db";
import { sessions, users } from "../db/schema";
import { env } from "cloudflare:workers";
import { normalizeUserRole } from "./roles";

import { effectivePermissions, hasPermission, canWriteLegacyStock, type Permission } from "./permissions";

const enc=new TextEncoder();
const b64=(a:Uint8Array)=>btoa(String.fromCharCode(...a));
const fromB64=(s:string)=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const hex=(a:ArrayBuffer)=>[...new Uint8Array(a)].map(x=>x.toString(16).padStart(2,"0")).join("");
export async function hashPassword(password:string,salt?:string){const raw=salt?fromB64(salt):crypto.getRandomValues(new Uint8Array(16));const key=await crypto.subtle.importKey("raw",enc.encode(password),"PBKDF2",false,["deriveBits"]);const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt:raw,iterations:100000,hash:"SHA-256"},key,256);return{hash:b64(new Uint8Array(bits)),salt:b64(raw)}}
export async function verifyPassword(password:string,salt:string,expected:string){const {hash}=await hashPassword(password,salt);if(hash.length!==expected.length)return false;let diff=0;for(let i=0;i<hash.length;i++)diff|=hash.charCodeAt(i)^expected.charCodeAt(i);return diff===0}
const tokenHash=async(t:string)=>hex(await crypto.subtle.digest("SHA-256",enc.encode(t)));
export async function ensureAuthSchema(){const db=env.DB;await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'employee', password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, must_change INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY NOT NULL, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, user_name TEXT NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL DEFAULT '', operation_id TEXT, summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)"),
 db.prepare("INSERT OR IGNORE INTO users (username,display_name,role,password_hash,password_salt,active,must_change,created_at) VALUES ('boss','老板','admin','!setup-via-handoff-required!','AAAAAAAAAAAAAAAAAAAAAA==',1,1,CURRENT_TIMESTAMP)"),
])}
export function cookieValue(req:Request,name:string){const hit=req.headers.get("cookie")?.split(";").map(x=>x.trim()).find(x=>x.startsWith(name+"="));return hit?decodeURIComponent(hit.slice(name.length+1)):null}
export async function currentUser(req:Request){const token=cookieValue(req,"wms_session");if(!token)return null;const db=getDb(),now=new Date().toISOString();const rows=await db.select({id:users.id,username:users.username,displayName:users.displayName,role:users.role,permissions:users.permissions,permissionVersion:users.permissionVersion,mustChange:users.mustChange}).from(sessions).innerJoin(users,eq(sessions.userId,users.id)).where(and(eq(sessions.tokenHash,await tokenHash(token)),gt(sessions.expiresAt,now),eq(users.active,1))).limit(1),user=rows[0],role=normalizeUserRole(user?.role);return user&&role?{...user,role,permissions:effectivePermissions(user)}:null}
export async function requireUser(req:Request,admin:boolean|Permission=false){const user=await currentUser(req);if(!user)return{error:Response.json({error:"请先登录"},{status:401})};if(admin&&(typeof admin==="string"?!hasPermission(user,admin):!hasPermission(user,"users.manage")))return{error:Response.json({error:"当前账号没有此操作权限"},{status:403})};return{user}}
export async function requireWriteUser(req:Request,permission?:Permission){const auth=await requireUser(req);if(auth.error)return auth;if(!(permission?hasPermission(auth.user!,permission):canWriteLegacyStock(auth.user!)))return{error:Response.json({error:"当前账号没有此操作权限"},{status:403})};return auth}
export async function createSession(userId:number){const raw=crypto.getRandomValues(new Uint8Array(32)),token=b64(raw).replaceAll("+","-").replaceAll("/","_").replaceAll("=","");const now=new Date(),expires=new Date(now.getTime()+12*60*60*1000);await getDb().insert(sessions).values({tokenHash:await tokenHash(token),userId,createdAt:now.toISOString(),expiresAt:expires.toISOString()});return{token,expires}}
export const sessionCookie=(token:string,expires:Date)=>`wms_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expires.toUTCString()}`;
