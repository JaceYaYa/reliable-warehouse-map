import {env} from 'cloudflare:workers';
import {eq} from 'drizzle-orm';
import {getDb} from '../../../../db';
import {settings} from '../../../../db/schema';
import {requireUser} from '../../../../lib/auth';
import {hasPermission,type PermissionUser} from '../../../../lib/permissions';
import {BOX_REVIEW_KEY,parseBoxReviews,pendingBoxRecord,matchesBoxReviewPostimage} from '../../../../lib/box-inventory-review';
import {GoodsFlowError} from '../../../../lib/goods-flow';
import {goodsGuard,goodsFinish,goodsStateUpdate,goodsResponseError,loadGoodsContext} from '../../../../lib/goods-store';
const approver=(user:PermissionUser)=>hasPermission(user,'stock.convert')&&(user.role==='admin'||user.username?.trim().toLowerCase()==='boss');
async function loadReview(){const [stored]=await getDb().select().from(settings).where(eq(settings.key,BOX_REVIEW_KEY));return{raw:stored?.value??null,state:parseBoxReviews(stored?.value)}}
export async function GET(request:Request){const a=await requireUser(request);if(a.error)return a.error;try{const [context,review]=await Promise.all([loadGoodsContext(),loadReview()]);return Response.json({state:review.state,pending:context.rows.filter(pendingBoxRecord),canApprove:approver(a.user!),canConvert:hasPermission(a.user!,'stock.convert')});}catch(e){return goodsResponseError(e)}}
export async function POST(request:Request){const a=await requireUser(request);if(a.error)return a.error;if(!approver(a.user!))return Response.json({error:'箱库存核对仅限老板或管理员确认；员工可以查看'},{status:403});try{
 const body=await request.json();if(!body||typeof body!=='object'||Array.isArray(body))throw new GoodsFlowError('核对提交格式不正确',400);if(body.action==='undo'&&!hasPermission(a.user!,'stock.restore'))throw new GoodsFlowError('没有撤销箱库存核对的权限',403);if(typeof body.requestId!=='string'||!/^[-\da-f]{36}$/i.test(body.requestId))throw new GoodsFlowError('请求编号无效',400);
 const review=await loadReview(),fingerprint=JSON.stringify(body),old=review.state.reviews.find(r=>r.requestId===body.requestId)??review.state.undoRequests.find(r=>r.requestId===body.requestId);
 if(old){if(old.fingerprint!==fingerprint)throw new GoodsFlowError('此请求编号已用于另一操作');return Response.json({ok:true,state:review.state,replayed:true});}
 if(body.revision!==review.state.revision)throw new GoodsFlowError('核对记录已变化，请刷新后重试');
 const context=await loadGoodsContext(),stamp=new Date().toISOString();let row;let unit:string,decision:string;
 if(body.action==='undo'){
  const record=review.state.reviews.find(r=>r.id===body.reviewId);if(!record||record.revertedAt)throw new GoodsFlowError('核对决定不存在或已撤销');row=context.rows.find(r=>r.id===record.stockId);
  if(!row||!matchesBoxReviewPostimage(row,record))throw new GoodsFlowError('该库存核对后已变化，或旧决定缺少完整库存身份资料；请核对当前记录，不能直接撤销');
  unit=record.beforeUnit;decision=record.beforeDecision;record.revertedAt=stamp;record.revertedBy=a.user!.displayName;review.state.undoRequests.push({requestId:body.requestId,fingerprint});
 }else{
  if(!['confirm','retain'].includes(body.action))throw new GoodsFlowError('请选择确认箱库存或保留现有库存',400);row=context.rows.find(r=>r.id===body.stockId);
  if(!row||!pendingBoxRecord(row))throw new GoodsFlowError('这条记录已核对或不再属于待核对箱库存');
  unit=body.action==='confirm'?'box':'item';decision=body.action;
  review.state.reviews.push({id:crypto.randomUUID(),requestId:body.requestId,fingerprint,stockId:row.id,product:row.product,customerName:row.customerName,locationCode:row.locationCode,inboundDate:row.inboundDate,boxes:row.totalBoxes,decision:body.action,beforeUnit:row.inventoryUnit,beforeDecision:row.inventoryReviewDecision,afterVersion:row.version+1,createdBy:a.user!.displayName,createdAt:stamp});
 }
 if(body.version!==row.version)throw new GoodsFlowError('库存版本已变化，请刷新核对');
 const after={...row,inventoryUnit:unit,inventoryReviewDecision:decision,version:row.version+1,updatedAt:stamp,updatedBy:a.user!.displayName};
 if(body.action!=='undo')review.state.reviews[review.state.reviews.length-1].afterStock={...after};
 // Classification changes update lot metadata only, preserving every pricing value, date and balance.
 const state=structuredClone(context.state);for(const c of state.categories)for(const lot of c.lots)if(lot.stockId===row.id)lot.snapshot={...lot.snapshot,inventoryUnit:unit,inventoryReviewDecision:decision};
 review.state.revision++;const guard=`box-review:${body.requestId}`,settingsGuard=env.DB.prepare("INSERT INTO goods_transaction_guards(id,valid) VALUES (?,CASE WHEN COALESCE((SELECT value FROM settings WHERE key=?),'')=? THEN 1 ELSE 0 END)").bind(`${guard}:history`,BOX_REVIEW_KEY,review.raw??'');
 await env.DB.batch([goodsGuard(context,guard,{rows:[row]}),settingsGuard,env.DB.prepare('UPDATE stocks SET inventory_unit=?,inventory_review_decision=?,version=?,updated_at=?,updated_by=? WHERE id=?').bind(unit,decision,after.version,stamp,a.user!.displayName,row.id),goodsStateUpdate(state),env.DB.prepare('INSERT INTO settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(BOX_REVIEW_KEY,JSON.stringify(review.state),stamp),env.DB.prepare('INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(a.user!.id,a.user!.displayName,'箱库存核对','库存',String(row.id),guard,`${body.action==='undo'?'撤销核对':body.action==='confirm'?'确认箱库存':'保留现有库存'}｜${row.product}｜${row.customerName}｜${row.locationCode}｜${row.inboundDate}｜${row.totalBoxes}箱`,JSON.stringify(row),JSON.stringify(after),stamp),goodsFinish(`${guard}:history`),goodsFinish(guard)]);
 return Response.json({ok:true,state:review.state,stock:after});
 }catch(e){return goodsResponseError(e)}}
