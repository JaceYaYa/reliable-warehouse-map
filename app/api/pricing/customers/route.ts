import {gt,or} from 'drizzle-orm';
import {getDb} from '../../../../db';
import {stocks,cartonReceipts} from '../../../../db/schema';
import {merchantAliases,resolveMerchantName} from '../../../../lib/merchant-identity';
import {readCorrectedOutboundHistory} from '../../../../lib/outbound-history-store';
import {isConfirmedLayerLegacyBill} from '../../../../lib/layer-storage-report';
import {requireUser} from '../../../../lib/auth';
import {cartonView} from '../../../../lib/carton-store';
import {cartonPlacementDetails} from '../../../../lib/box-stock-details';
import {isHistoricalDirectorySnapshotSettlement} from '../../../../lib/historical-directory-snapshot';

const headers={'cache-control':'no-store'};
/** Customer selection needs identities only, never the large physical replay ledgers. */
export async function GET(request:Request){
 const auth=await requireUser(request,'pricing.manage');if(auth.error){auth.error.headers.set('cache-control','no-store');return auth.error;}
 try{
  const db=getDb(),[stockRows,cartons]=await db.batch([
   db.select({customerName:stocks.customerName}).from(stocks).where(or(gt(stocks.totalQuantity,0),gt(stocks.totalBoxes,0))),
   db.select().from(cartonReceipts),
  ]);
  const customers=new Set<string>();let unclaimedCount=0;
  const add=(name:string,physical=true)=>{const value=name.trim();if(value)customers.add(value);else if(physical)unclaimedCount++;};
  for(const row of stockRows)add(row.customerName);
  for(const row of cartons){const receipt=cartonView(row);for(const placement of receipt.placements)if(placement.boxes>0)add(cartonPlacementDetails(receipt,placement).customerName);}
  const history=await readCorrectedOutboundHistory(),aliases=merchantAliases(history.settingsRows),canonical=(name:string)=>resolveMerchantName(name,aliases),active=new Set([...customers].map(canonical));customers.clear();for(const name of active)customers.add(name);
  for(const row of history.records)if(!history.hiddenDirectoryKeys.has(row.key))add(canonical(row.customerName),false);
  // Obsolete archive-only names are not independent billing customers. Unlinked
  // or conflicting archives remain selectable until their ownership is resolved.
  for(const row of history.settlements)if(row.settlementStatus!=='restored'&&(row.quantity>0||row.boxes>0||row.version>0&&isConfirmedLayerLegacyBill(row))&&!history.migratedSettlementIds.has(row.id)&&!isHistoricalDirectorySnapshotSettlement(row))add(canonical(row.customerName),false);
  const historicalCustomers=[...customers].filter(name=>!active.has(name)).sort((a,b)=>a.localeCompare(b,'zh-CN',{numeric:true}));
  return Response.json({customers:[...customers].sort((a,b)=>a.localeCompare(b,'zh-CN',{numeric:true})),unclaimedCount,...(historicalCustomers.length?{historicalCustomers}:{})},{headers});
 }catch{return Response.json({error:'客户目录读取失败，请刷新后核对'},{status:400,headers});}
}
