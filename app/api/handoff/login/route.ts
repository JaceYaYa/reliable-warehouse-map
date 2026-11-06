import {env} from 'cloudflare:workers';
import {eq} from 'drizzle-orm';
import {getDb} from '../../../../db';
import {users} from '../../../../db/schema';
import {ensureAuthSchema,createSession,sessionCookie} from '../../../../lib/auth';

// Handoff edition only. Disabled unless the new Site owner explicitly configures
// their own platform-verified email in Sites runtime settings. Never enable with
// the previous owner's address, and never trust an email from the request body.
const ownerEmail=()=>String((env as unknown as Record<string,unknown>).HANDOFF_OWNER_EMAIL??'').trim().toLowerCase();
export async function GET(){return Response.json({enabled:!!ownerEmail()},{headers:{'Cache-Control':'no-store'}});}
export async function POST(req:Request){
 const owner=ownerEmail();if(!owner)return Response.json({error:'此站未启用交接登录'},{status:404});
 if(req.headers.get('Origin')&&req.headers.get('Origin')!==new URL(req.url).origin)return Response.json({error:'登录请求来源不符'},{status:403});
 const verified=req.headers.get('oai-authenticated-user-email')?.trim().toLowerCase();
 if(!verified)return Response.json({error:'请先使用本网站所有者的 ChatGPT 账号登录'},{status:401});
 if(verified!==owner)return Response.json({error:'当前 ChatGPT 账号不是交接指定的老板账号'},{status:403});
 await ensureAuthSchema();const [boss]=await getDb().select().from(users).where(eq(users.username,'boss')).limit(1);
 if(!boss||!boss.active)return Response.json({error:'老板账号已停用，请核对站点设置'},{status:403});
 const session=await createSession(boss.id);
 return Response.json({ok:true,mustChange:!!boss.mustChange},{headers:{'Set-Cookie':sessionCookie(session.token,session.expires),'Cache-Control':'no-store'}});
}
