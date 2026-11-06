import {projectCartonRows} from '../../../../lib/carton-pallets';
import {automaticPalletRows} from '../../../../lib/automatic-pallets';
import {getDb} from '../../../../db';
import {stocks,settings,cartonReceipts,goodsOperations,auditLogs,cartonOperations,storageFeeSettlements,layerStorageCheckpoints} from '../../../../db/schema';
import {requireUser} from '../../../../lib/auth';
import {cartonView} from '../../../../lib/carton-store';
import {cartonPlacementDetails} from '../../../../lib/box-stock-details';
import {LOCATION_ALIASES_KEY,parseLocationAliases,resolveLocationAlias} from '../../../../lib/location-aliases';
import {locationCodeKey} from '../../../../lib/location-code';
import type {LayerOccupant} from '../../../../lib/layer-storage';
import {buildStorageFreePeriods,parseFreePeriodQuery,deriveFreePeriodArrivalReviewIds} from '../../../../lib/storage-free-periods';
import {projectLayerStorageHistory} from '../../../../lib/layer-storage-history';
import {warehouseTodayDate} from '../../../../lib/warehouse-time';
import {STORAGE_PRICING_BASIS_KEY,layerStoragePricingFromValue} from '../../../../lib/storage-pricing-basis';
import {eq,sql} from 'drizzle-orm';
import {projectStagingLayerOccupants,type StagingLayerPricingOperation} from '../../../../lib/staging-layer-pricing';
import {LEGACY_WAITING_MOVE_AUDIT_PREDICATE} from '../../../../lib/legacy-waiting-origins';
import {waitingPricingFromEvidence} from '../../../../lib/manual-waiting-origins';
import {merchantAliases,resolveMerchantName} from '../../../../lib/merchant-identity';

const headers={'cache-control':'no-store'};
export async function GET(request:Request){
  try{
    const auth=await requireUser(request,'pricing.manage');
    if(auth.error){auth.error.headers.set('cache-control','no-store');return auth.error;}
    const query=parseFreePeriodQuery(new URL(request.url).searchParams),db=getDb();
    // Layer expiry only needs current physical stock and customer rules.
    const [basisHint]=await db.select({value:settings.value}).from(settings).where(eq(settings.key,STORAGE_PRICING_BASIS_KEY)).limit(1),hintLayer=layerStoragePricingFromValue(basisHint?.value);
    let stockRows:typeof stocks.$inferSelect[]=[],settingsRows:typeof settings.$inferSelect[]=[],cartonRows:typeof cartonReceipts.$inferSelect[]=[],operationRows:typeof goodsOperations.$inferSelect[]=[],audits:typeof auditLogs.$inferSelect[]=[],cartonOps:typeof cartonOperations.$inferSelect[]=[],settlements:typeof storageFeeSettlements.$inferSelect[]=[],checkpoints:typeof layerStorageCheckpoints.$inferSelect[]=[];
    let stagingRows:StagingLayerPricingOperation[]=[],moveRows:Array<Record<string,unknown>>=[],palletAudits:Array<{action:string;beforeValue:string|null;afterValue:string|null}>=[],cartonPalletOps:Array<{kind:string;beforeSnapshot:string|null;afterSnapshot:string|null}>=[];
    const layerMode=()=>{const value=settingsRows.find(row=>row.key===STORAGE_PRICING_BASIS_KEY)?.value;return layerStoragePricingFromValue(value);};
    const moveQuery=()=>db.select({id:auditLogs.id,action:auditLogs.action,operationId:auditLogs.operationId,createdAt:auditLogs.createdAt,beforeSnapshot:auditLogs.beforeSnapshot,afterSnapshot:auditLogs.afterSnapshot}).from(auditLogs).where(sql.raw(LEGACY_WAITING_MOVE_AUDIT_PREDICATE));
    const palletAuditQuery=()=>db.select({action:auditLogs.action,beforeValue:auditLogs.beforeSnapshot,afterValue:auditLogs.afterSnapshot}).from(auditLogs).where(sql.raw("action='库存修改' AND json_valid(before_snapshot) AND json_valid(after_snapshot) AND json_type(before_snapshot,'$.palletCount') IN ('integer','real') AND json_type(after_snapshot,'$.palletCount') IN ('integer','real') AND json_extract(before_snapshot,'$.palletCount')<>json_extract(after_snapshot,'$.palletCount')"));
    const cartonPalletQuery=()=>db.select({kind:cartonOperations.kind,beforeSnapshot:cartonOperations.beforeSnapshot,afterSnapshot:cartonOperations.afterSnapshot}).from(cartonOperations).where(sql.raw("kind IN ('details','correction')"));
    if(hintLayer)[stockRows,settingsRows,cartonRows,stagingRows,moveRows,palletAudits,cartonPalletOps]=await db.batch([db.select().from(stocks),db.select().from(settings),db.select().from(cartonReceipts),db.select({id:goodsOperations.id,kind:goodsOperations.kind,fingerprint:goodsOperations.fingerprint,beforeRows:goodsOperations.beforeRows,afterRows:goodsOperations.afterRows,result:goodsOperations.result,createdAt:goodsOperations.createdAt,restoredAt:goodsOperations.restoredAt}).from(goodsOperations).where(eq(goodsOperations.kind,'staging')),moveQuery(),palletAuditQuery(),cartonPalletQuery()]);
    if(!hintLayer||!layerMode()){
      [stockRows,settingsRows,cartonRows,operationRows,audits,cartonOps,settlements,checkpoints]=await db.batch([db.select().from(stocks),db.select().from(settings),db.select().from(cartonReceipts),db.select().from(goodsOperations),db.select().from(auditLogs),db.select().from(cartonOperations),db.select().from(storageFeeSettlements),db.select().from(layerStorageCheckpoints)]);
      moveRows=audits.filter(a=>a.action==='移库'||a.action==='恢复');palletAudits=audits.map(a=>({action:a.action,beforeValue:a.beforeSnapshot,afterValue:a.afterSnapshot}));cartonPalletOps=cartonOps;
    }
    const aliases=parseLocationAliases(settingsRows.find(row=>row.key===LOCATION_ALIASES_KEY)?.value),seen=new Set<string>();
    for(const [from,to] of Object.entries(aliases)){
      const key=locationCodeKey(from);
      if(seen.has(key)||['__proto__','prototype','constructor'].includes(from)||['__proto__','prototype','constructor'].includes(to))throw Error('库位更名记录有重复或无效名称，请先核对');
      seen.add(key);
    }
    const canonical=(code:string)=>locationCodeKey(resolveLocationAlias(code,aliases));
    const occupants:LayerOccupant[]=automaticPalletRows(stockRows,settingsRows,palletAudits).filter(stock=>stock.totalQuantity>0||stock.totalBoxes>0).map(stock=>({id:`stock:${stock.id}`,kind:'stock',customerName:stock.customerName,productName:stock.product,sku:stock.sku,locationCode:canonical(stock.locationCode),layer:stock.layerCount,inboundDate:stock.inboundDate,palletCount:stock.palletCount}));
    for(const cartonRow of projectCartonRows(cartonRows,cartonPalletOps)){
      const receipt=cartonView(cartonRow);
      for(const placement of receipt.placements){
        if(!(placement.boxes>0))continue;
        const detail=cartonPlacementDetails(receipt,placement);
        occupants.push({id:`carton:${receipt.id}:${placement.key}`,kind:'carton',customerName:detail.customerName,productName:detail.product,sku:detail.sku,locationCode:canonical(placement.locationCode),layer:detail.layerCount,inboundDate:detail.inboundDate,palletCount:detail.palletCount});
      }
    }
    // Pallet billing retains every current batch arrival and its own free period.
    const basis=settingsRows.find(row=>row.key===STORAGE_PRICING_BASIS_KEY)?.value;
    if(layerStoragePricingFromValue(basis)){
      const pricing=waitingPricingFromEvidence(hintLayer?stagingRows:operationRows.filter(o=>o.kind==='staging'),moveRows,settingsRows,stockRows,aliases),customers=merchantAliases(settingsRows);
      return Response.json(buildStorageFreePeriods({...query,arrivalPolicy:'batch',occupants:projectStagingLayerOccupants(occupants.map(o=>({...o,customerName:resolveMerchantName(o.customerName,customers)})),pricing,aliases),settingsRows}),{headers});
    }
    // Legacy unit billing retains its independent correction-cohort safeguards.
    const today=warehouseTodayDate(),tomorrow=new Date(Date.parse(`${today}T00:00:00Z`)+86400000).toISOString().slice(0,10),checkpoint=checkpoints.find(row=>row.id===1)??null;
    const history=projectLayerStorageHistory({stocks:stockRows,cartons:cartonRows,audits,goodsOps:operationRows,cartonOps,settlements,checkpoint,aliases,periodStart:today,periodEndExclusive:tomorrow});
    // Missing or damaged history coverage never suppresses the independent direct-correction safeguard.
    const arrivalReviewIds=[...new Set([...deriveFreePeriodArrivalReviewIds(occupants,operationRows),...(history.currentArrivalReviewIds??[])])];
    return Response.json(buildStorageFreePeriods({...query,occupants,settingsRows,arrivalReviewIds}),{headers});
  }catch(error){
    return Response.json({error:error instanceof Error?error.message:'免租到期查询失败，请刷新后核对'},{status:400,headers});
  }
}
